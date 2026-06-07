import { op } from 'weave';
import type { Logger } from './logger.js';

// ── The polite-pool OpenAlex HTTP client (the fetch boundary's network half) ──
//
// Every request carries mailto + a self-identifying User-Agent (the "polite
// pool", ~100 req/s). An optional OPENALEX_API_KEY raises limits further but is
// NEVER required — the build must run without it. First-page-only (per_page=50,
// no cursor paging). Every call degrades to [] / null on any error and never
// throws upward (degrade-to-empty). The boundary makes no LLM calls.

const BASE = 'https://api.openalex.org';
const MAILTO = process.env.OPENALEX_MAILTO ?? 'feed@atomicresearch.ca';
const USER_AGENT = `AtomicResearch/3.2 (mailto:${MAILTO})`;
const PER_PAGE = 50;

// ── Raw OpenAlex shapes (only the fields we select) ─────────────────────────

export type RawAuthorMatch = {
  id: string;
  display_name: string;
  works_count: number;
  cited_by_count: number;
  last_known_institutions?: { display_name?: string }[] | null;
};

export type RawTopic = {
  id: string;
  display_name: string;
  count?: number;
  score?: number;
  subfield?: { id: string; display_name: string };
  field?: { id: string; display_name: string };
};

export type RawAuthor = {
  id: string;
  display_name: string;
  works_count: number;
  cited_by_count: number;
  summary_stats?: { h_index?: number; i10_index?: number };
  topics?: RawTopic[];
};

export type RawWork = {
  id: string;
  title?: string | null;
  publication_date?: string | null;
  doi?: string | null;
  ids?: Record<string, string> | null;
  primary_topic?: {
    id?: string;
    display_name?: string;
    subfield?: { id: string; display_name: string };
    field?: { id: string; display_name: string };
  } | null;
  topics?: RawTopic[];
  abstract_inverted_index?: Record<string, number[]> | null;
  referenced_works?: string[] | null;
  authorships?: { author: { id: string; display_name: string } }[] | null;
  open_access?: { is_oa?: boolean } | null;
  primary_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  locations?: { landing_page_url?: string | null; pdf_url?: string | null }[] | null;
  cited_by_count?: number;
};

// ── Per-run fetch metrics (logged to W&B; every degrade is counted) ─────────

export type FetchMetrics = {
  endpoint_calls: number;
  endpoint_degrades: number;
};

export function newFetchMetrics(): FetchMetrics {
  return { endpoint_calls: 0, endpoint_degrades: 0 };
}

const WORK_SELECT = [
  'id', 'title', 'publication_date', 'doi', 'ids', 'primary_topic', 'topics',
  'abstract_inverted_index', 'referenced_works', 'authorships', 'open_access',
  'primary_location', 'locations', 'cited_by_count',
].join(',');

function withCommon(url: URL): URL {
  url.searchParams.set('mailto', MAILTO);
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) url.searchParams.set('api_key', apiKey);
  return url;
}

// The single base fetcher. Returns parsed JSON or null on ANY failure
// (network error, non-2xx, malformed body). Never throws — degrade-to-empty.
async function getJson(url: URL, logger: Logger, metrics?: FetchMetrics): Promise<any | null> {
  if (metrics) metrics.endpoint_calls++;
  const final = withCommon(new URL(url.toString()));
  try {
    const res = await fetch(final.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      if (metrics) metrics.endpoint_degrades++;
      logger.warn('openalex non-2xx — degrading', { url: redact(final), status: res.status });
      return null;
    }
    return await res.json();
  } catch (err) {
    if (metrics) metrics.endpoint_degrades++;
    logger.warn('openalex request failed — degrading', { url: redact(final), error: String(err) });
    return null;
  }
}

// Strip the api_key from a URL before it ever reaches a log line.
function redact(url: URL): string {
  const u = new URL(url.toString());
  if (u.searchParams.has('api_key')) u.searchParams.set('api_key', 'REDACTED');
  return u.toString();
}

// ── Endpoint methods (each @weave.op so the fetch is in the trace tree) ──────

// /authors?search= — relevance-ranked matches for the "is this you?" picker.
export const searchAuthors = op(async function searchAuthors(
  query: string,
  logger: Logger,
  metrics?: FetchMetrics,
): Promise<RawAuthorMatch[]> {
  const url = new URL(`${BASE}/authors`);
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('select', 'id,display_name,works_count,cited_by_count,last_known_institutions');
  const data = await getJson(url, logger, metrics);
  return (data?.results as RawAuthorMatch[] | undefined) ?? [];
});

// /authors/{id} — the full author profile on confirm.
export const getAuthor = op(async function getAuthor(
  authorId: string,
  logger: Logger,
  metrics?: FetchMetrics,
): Promise<RawAuthor | null> {
  const url = new URL(`${BASE}/authors/${authorId}`);
  url.searchParams.set('select', 'id,display_name,works_count,cited_by_count,summary_stats,topics');
  return (await getJson(url, logger, metrics)) as RawAuthor | null;
});

// /works?filter=author.id:{id} — the researcher's own works → publications corpus.
export const getWorksByAuthor = op(async function getWorksByAuthor(
  authorId: string,
  logger: Logger,
  metrics?: FetchMetrics,
): Promise<RawWork[]> {
  const url = new URL(`${BASE}/works`);
  url.searchParams.set('filter', `author.id:${authorId}`);
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('select', WORK_SELECT);
  const data = await getJson(url, logger, metrics);
  return (data?.results as RawWork[] | undefined) ?? [];
});

// /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d},to_publication_date:{today}
// — the recurring candidate pull, one call per selected subfield. First page only.
// Both date bounds are sent server-side: the floor is the {d} recency window;
// the ceiling (today) excludes OpenAlex's future-dated junk that would otherwise
// dominate the publication_date:desc sort and starve the in-window candidate pool.
export const getWorksBySubfield = op(async function getWorksBySubfield(
  subfieldId: string,
  dateFloor: string,
  dateCeil: string,
  logger: Logger,
  metrics?: FetchMetrics,
): Promise<RawWork[]> {
  const url = new URL(`${BASE}/works`);
  url.searchParams.set('filter', `primary_topic.subfield.id:${subfieldId},from_publication_date:${dateFloor},to_publication_date:${dateCeil}`);
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('select', WORK_SELECT);
  const data = await getJson(url, logger, metrics);
  return (data?.results as RawWork[] | undefined) ?? [];
});
