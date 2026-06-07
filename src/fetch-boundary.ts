import { op } from 'weave';
import type { RawAuthor, RawWork, RawTopic } from './openalex-client.js';
import type { Researcher, Publication, Paper, ResearcherTopic } from './schemas.js';
import type { RecencyWindow } from './window.js';
import { inWindow } from './window.js';

// ── The fetch boundary: consume OpenAlex JSON, emit the v3.1 fixture shapes,
// never throw upward. Downstream of here the pipeline cannot tell a network
// response from a file — that is the success condition. The five transforms
// (ID normalization, abstract reconstruction, dedup cascade, polite pool [in
// openalex-client], degrade-to-empty [in openalex-client + skip-on-bad-item])
// are the ONLY deterministic boundary logic. Subfield SELECTION and the profile
// description are an LLM step (see skills/onboarding.ts) — a deliberate v3.2
// deviation: the LLM is the centerpiece of the candidate pull, so it decides
// which subfields to monitor and writes the narrative profile, rather than the
// deterministic primary_topic.subfield tag derivation R-3.2-4 describes. The
// tag set still seeds the LLM's choices (so every selected id is a real
// OpenAlex subfield id) and is the deterministic fallback.

// ── Transform 1: ID normalization (strip URL prefixes → bare id-space) ──────

export function stripOpenAlexId(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^https?:\/\/openalex\.org\//, '');
}

export function stripDoi(doi: string | null | undefined): string {
  if (!doi) return '';
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

// arXiv ids arrive embedded in landing-page URLs or the `ids` map; normalize to
// the bare "2401.12345" form. Returns '' when the work is not an arXiv work.
export function normalizeArxivId(work: RawWork): string {
  const candidates: string[] = [];
  if (work.ids?.arxiv) candidates.push(work.ids.arxiv);
  for (const loc of work.locations ?? []) {
    if (loc.landing_page_url) candidates.push(loc.landing_page_url);
    if (loc.pdf_url) candidates.push(loc.pdf_url);
  }
  if (work.primary_location?.landing_page_url) candidates.push(work.primary_location.landing_page_url);
  for (const c of candidates) {
    const m = c.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/i)
      ?? c.match(/^arxiv:([0-9]{4}\.[0-9]{4,5})/i)
      ?? c.match(/^([0-9]{4}\.[0-9]{4,5})$/);
    if (m) return m[1];
  }
  return '';
}

function normalizeTopics(topics: RawTopic[] | undefined): ResearcherTopic[] {
  return (topics ?? []).map(t => ({
    id: stripOpenAlexId(t.id),
    display_name: t.display_name,
    // OpenAlex author topics carry `count`; works carry `score`. Normalize to a
    // 0–1 score so the v3.1 ResearcherTopic shape holds (clamped).
    score: clamp01(t.score ?? 0),
  }));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ── Transform 2: abstract reconstruction (inverted index → text, or null) ───
// Plain helper (called inside the record-level mapping ops, which carry the
// trace span) — kept un-op'd to avoid op-in-op Promise nesting.

export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string | null {
  if (!invertedIndex || Object.keys(invertedIndex).length === 0) return null;
  const positions: { pos: number; word: string }[] = [];
  for (const [word, locs] of Object.entries(invertedIndex)) {
    for (const pos of locs) positions.push({ pos, word });
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a.pos - b.pos);
  const text = positions.map(p => p.word).join(' ').trim();
  return text.length > 0 ? text : null;
}

// ── Transform 3: deduplication cascade (arxiv_id → doi → openalex_id → new) ──

export const dedupeCascade = op(function dedupeCascade(papers: Paper[]): Paper[] {
  const seenArxiv = new Set<string>();
  const seenDoi = new Set<string>();
  const seenOa = new Set<string>();
  const out: Paper[] = [];
  for (const p of papers) {
    if (p.arxiv_id && seenArxiv.has(p.arxiv_id)) continue;
    if (p.doi && seenDoi.has(p.doi)) continue;
    if (p.openalex_id && seenOa.has(p.openalex_id)) continue;
    if (p.arxiv_id) seenArxiv.add(p.arxiv_id);
    if (p.doi) seenDoi.add(p.doi);
    if (p.openalex_id) seenOa.add(p.openalex_id);
    out.push(p);
  }
  return out;
});

// ── Shape emission ──────────────────────────────────────────────────────────

function mapAuthors(work: RawWork): { name: string; openalex_id: string }[] {
  const authors = (work.authorships ?? []).map(a => ({
    name: a.author.display_name,
    openalex_id: stripOpenAlexId(a.author.id),
  }));
  return authors.length > 0 ? authors : [{ name: 'Unknown', openalex_id: '' }];
}

function workArxivCategories(work: RawWork): string[] {
  // OpenAlex gives no arXiv category codes; surface the primary_topic field +
  // subfield display names as the closest analogue so the council prompt's
  // arXiv-category line is non-empty when possible.
  const out: string[] = [];
  const f = work.primary_topic?.field?.display_name;
  const sf = work.primary_topic?.subfield?.display_name;
  if (sf) out.push(sf);
  if (f && f !== sf) out.push(f);
  return out;
}

// publications: the researcher's own works. publication_id is the bare work id.
export const mapWorkToPublication = op(function mapWorkToPublication(
  work: RawWork,
  researcherId: string,
): Publication {
  return {
    publication_id: stripOpenAlexId(work.id),
    researcher_id: researcherId,
    openalex_id: stripOpenAlexId(work.id),
    title: work.title ?? '(untitled)',
    abstract: reconstructAbstract(work.abstract_inverted_index),
    authors: mapAuthors(work),
    year: yearFrom(work.publication_date),
    venue: '',
    arxiv_categories: workArxivCategories(work),
    topics: normalizeTopics(work.topics),
    citation_count: work.cited_by_count ?? 0,
  };
});

// candidate papers: the subfield pull. paper_id is the bare work id; every id
// (incl. each referenced_works entry) is normalized to bare form here.
export const mapWorkToPaper = op(function mapWorkToPaper(work: RawWork): Paper {
  return {
    paper_id: stripOpenAlexId(work.id),
    openalex_id: stripOpenAlexId(work.id),
    arxiv_id: normalizeArxivId(work),
    doi: stripDoi(work.doi),
    title: work.title ?? '(untitled)',
    abstract: reconstructAbstract(work.abstract_inverted_index),
    authors: mapAuthors(work),
    publication_date: work.publication_date ?? '',
    year: yearFrom(work.publication_date),
    arxiv_categories: workArxivCategories(work),
    topics: normalizeTopics(work.topics),
    referenced_works: (work.referenced_works ?? []).map(stripOpenAlexId),
    citation_count: work.cited_by_count ?? 0,
    is_open_access: Boolean(work.open_access?.is_oa),
  };
});

function yearFrom(date: string | null | undefined): number {
  if (!date) return 0;
  const y = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : 0;
}

// emit the v3.1 researchers shape. description + research_interests are
// LLM-generated (passed in); h-index/citation/works counts come from the
// author profile; topics are normalized author topics.
export const emitResearcher = op(function emitResearcher(
  author: RawAuthor,
  description: string,
  researchInterests: string[],
): Researcher {
  return {
    researcher_id: stripOpenAlexId(author.id),
    name: author.display_name,
    full_name: author.display_name,
    description,
    research_interests: researchInterests,
    topics: normalizeTopics(author.topics),
    works_count: author.works_count ?? 0,
    cited_by_count: author.cited_by_count ?? 0,
    h_index: author.summary_stats?.h_index ?? 0,
  };
});

// The candidate subfield set the LLM chooses from: every distinct
// primary_topic.subfield across the author's own works, plus the subfields of
// the author-profile topics as the thin-coverage fallback. Bare ids, deduped.
export type CandidateSubfield = { id: string; display_name: string; work_count: number };

export const collectCandidateSubfields = op(function collectCandidateSubfields(
  works: RawWork[],
  author: RawAuthor,
): CandidateSubfield[] {
  const counts = new Map<string, CandidateSubfield>();
  const add = (raw?: { id: string; display_name: string }) => {
    if (!raw?.id) return;
    const id = stripOpenAlexId(raw.id);
    const existing = counts.get(id);
    if (existing) existing.work_count++;
    else counts.set(id, { id, display_name: raw.display_name, work_count: 1 });
  };
  for (const w of works) add(w.primary_topic?.subfield);
  // Fallback signal (always included so a thin own-works tag set still yields
  // targets): the subfields behind the author-profile topics.
  for (const t of author.topics ?? []) add(t.subfield);
  return [...counts.values()].sort((a, b) => b.work_count - a.work_count);
});

// Apply the boundary recency window to candidate papers: drop anything outside
// [d, today] (the from_publication_date floor is enforced server-side; this also
// drops OpenAlex's occasional future-dated junk). Also drops the author's own
// works so publications and candidate papers stay disjoint id-spaces.
export const applyCandidateWindow = op(function applyCandidateWindow(
  papers: Paper[],
  win: RecencyWindow,
  ownWorkIds: Set<string>,
): Paper[] {
  return papers.filter(p => {
    if (!p.publication_date) return false;
    if (ownWorkIds.has(p.paper_id)) return false;
    return inWindow(p.publication_date, win);
  });
});
