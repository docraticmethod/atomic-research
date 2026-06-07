import { assertNoIdSpaceConflict, joinResearcher } from './join.js';
import { sortFeed, assertRecencyWindow } from './sequencer.js';
import { recencyWindow } from './window.js';
import {
  getAuthor, getWorksByAuthor, getWorksBySubfield,
  newFetchMetrics, type FetchMetrics,
} from './openalex-client.js';
import {
  mapWorkToPublication, mapWorkToPaper, emitResearcher,
  collectCandidateSubfields, dedupeCascade, applyCandidateWindow,
  stripOpenAlexId,
} from './fetch-boundary.js';
import {
  runGroundingExtraction, runAptnessValidation, runGroundingRepair,
  runCouncilBatch, parseCouncilResult, runFeedSummary, runProfileSynthesis,
} from './subagent.js';
import { runIntegrityModel } from './integrity.js';
import { evaluate } from './eval.js';
import { validateResearchers, validatePublications, validatePapers } from './schemas.js';
import type {
  OutputArtifact, ResearcherFeed, Researcher, Paper,
} from './schemas.js';
import type { Logger } from './logger.js';

// Aggregate fetch/pipeline metrics surfaced to W&B for the run.
export type PipelineMetrics = FetchMetrics & {
  works_pulled: number;
  subfields_selected: number;
  subfield_selection_source: 'llm' | 'deterministic_fallback';
  candidate_papers_raw: number;
  candidate_papers_in_window: number;
  candidate_papers_deduped: number;
  dedup_collapses: number;
  abstract_null_count: number;
};

export type OrchestrationResult = {
  artifact: OutputArtifact;
  metrics: PipelineMetrics;
};

// A degraded single-researcher feed — the "no new papers available — retry" face.
// Used when the author fetch totally fails or grounding ends degraded; never a
// crash, never a partial profile.
function degradedFeed(researcherId: string, researcherName: string): ResearcherFeed {
  return {
    researcher_id: researcherId,
    researcher_name: researcherName,
    grounding_status: 'unavailable',
    grounded_profile: null,
    feed: [],
    feed_summary: { text: '', summary_status: 'unavailable' },
  };
}

export async function orchestrate(logger: Logger, authorId: string): Promise<OrchestrationResult> {
  const win = recencyWindow();
  const fetchMetrics = newFetchMetrics();
  const ridBare = stripOpenAlexId(authorId) || authorId;

  const metrics: PipelineMetrics = {
    ...fetchMetrics,
    works_pulled: 0,
    subfields_selected: 0,
    subfield_selection_source: 'deterministic_fallback',
    candidate_papers_raw: 0,
    candidate_papers_in_window: 0,
    candidate_papers_deduped: 0,
    dedup_collapses: 0,
    abstract_null_count: 0,
  };

  // ── Stage 0: confirm-author-link is upstream (dashboard); fetch the profile ──
  logger.info('fetch boundary: author profile', { author_id: ridBare });
  const rawAuthor = await getAuthor(ridBare, logger, fetchMetrics);
  if (!rawAuthor) {
    logger.error('author profile unavailable — emitting degraded feed (no crash)', { author_id: ridBare });
    Object.assign(metrics, fetchMetrics);
    return { artifact: [degradedFeed(ridBare, ridBare)], metrics };
  }

  // ── R-3.2-3: own works → publications corpus (the only input to grounding) ──
  const rawWorks = await getWorksByAuthor(ridBare, logger, fetchMetrics);
  const publications = await Promise.all(rawWorks.map(w => mapWorkToPublication(w, ridBare)));
  metrics.works_pulled = publications.length;

  if (!validatePublications(publications)) {
    logger.error('transformed publications failed schema', { errors: validatePublications.errors });
  }

  // ── Onboarding LLM step: choose the candidate-pull subfields + write profile ──
  const candidates = await collectCandidateSubfields(rawWorks, rawAuthor);
  const synth = await runProfileSynthesis(rawAuthor, publications, candidates, logger);

  // Deterministic fallback (R-3.2-4 thin-coverage path): top candidate subfields.
  const description = synth?.description
    ?? `Researcher working across ${candidates.slice(0, 3).map(c => c.display_name).join(', ') || 'multiple fields'}.`;
  const researchInterests = (synth?.research_interests && synth.research_interests.length > 0)
    ? synth.research_interests
    : [...new Set(candidates.map(c => c.display_name))].slice(0, 8);
  const selectedSubfields = (synth?.selected_subfields && synth.selected_subfields.length > 0)
    ? synth.selected_subfields
    : candidates.slice(0, 5).map(c => ({ id: c.id, display_name: c.display_name, reason: 'deterministic fallback (top own-works subfield)' }));

  metrics.subfields_selected = selectedSubfields.length;
  metrics.subfield_selection_source = synth ? 'llm' : 'deterministic_fallback';
  logger.info('subfields selected for candidate pull', {
    source: metrics.subfield_selection_source,
    subfields: selectedSubfields.map(s => `${s.id}:${s.display_name}`),
  });

  const researcher: Researcher = await emitResearcher(rawAuthor, description, researchInterests);
  if (!validateResearchers([researcher])) {
    logger.error('transformed researcher failed schema', { errors: validateResearchers.errors });
  }

  // ── R-3.2-5: candidate papers from the recurring subfield pull (one call/sf) ──
  const candidateRaw: Paper[] = [];
  for (const sf of selectedSubfields) {
    const works = await getWorksBySubfield(sf.id, win.floorISO, win.ceilISO, logger, fetchMetrics);
    const mapped = await Promise.all(works.map(mapWorkToPaper));
    candidateRaw.push(...mapped);
    logger.info('subfield pull', { subfield: sf.id, name: sf.display_name, pulled: mapped.length });
  }
  metrics.candidate_papers_raw = candidateRaw.length;

  const ownWorkIds = new Set(publications.map(p => p.publication_id));
  const inWindowPapers = await applyCandidateWindow(candidateRaw, win, ownWorkIds);
  metrics.candidate_papers_in_window = inWindowPapers.length;

  let papers = await dedupeCascade(inWindowPapers);
  metrics.dedup_collapses = inWindowPapers.length - papers.length;

  // Optional demo cap on council fan-out. By default the council deliberates the
  // FULL candidate set (spec behavior — can be hundreds of LLM calls). Set
  // CANDIDATE_CAP=N for fast, cheap demo runs. Logged, never a silent truncation.
  const cap = Number(process.env.CANDIDATE_CAP ?? '0');
  if (cap > 0 && papers.length > cap) {
    logger.warn('candidate pool capped for demo (CANDIDATE_CAP)', { from: papers.length, to: cap, dropped: papers.length - cap });
    papers = papers.slice(0, cap);
  }

  metrics.candidate_papers_deduped = papers.length;
  metrics.abstract_null_count =
    papers.filter(p => p.abstract === null).length + publications.filter(p => p.abstract === null).length;

  if (!validatePapers(papers)) {
    logger.error('transformed papers failed schema', { errors: validatePapers.errors });
  }

  // Boundary invariants: disjoint id-spaces, all candidates in-window by construction.
  assertNoIdSpaceConflict(papers, publications);
  assertRecencyWindow(papers, win);

  Object.assign(metrics, fetchMetrics); // copy final endpoint_calls/degrades

  logger.info('fetch boundary complete', {
    researcher_id: ridBare,
    publications: publications.length,
    candidate_papers: papers.length,
    endpoint_calls: fetchMetrics.endpoint_calls,
    endpoint_degrades: fetchMetrics.endpoint_degrades,
  });

  // ── Stage 1: grounding (extraction → aptness → integrity model) — UNCHANGED ──
  const publicationIds = new Set(publications.map(p => p.publication_id));
  logger.info('starting grounding', { researcher_id: ridBare, publications: publications.length });

  const call1Raw = await runGroundingExtraction(researcher, publications, logger);
  const call2Raw = call1Raw ? await runAptnessValidation(researcher, call1Raw, logger) : null;
  const repairFn = (reason: string) => runGroundingRepair(researcher, publications, reason, logger);

  const groundedProfile = await runIntegrityModel(call1Raw ?? '', call2Raw, ridBare, publicationIds, logger, repairFn);

  // ── Grounding gate: the council is unreachable on a degraded profile ──
  if (groundedProfile === null) {
    logger.warn('grounding degraded — skipping council', { researcher_id: ridBare });
    return { artifact: [degradedFeed(ridBare, researcher.name)], metrics };
  }

  // ── Phase 1: join (candidate papers + grounded profile, no feed seeds) ──
  const joined = joinResearcher(researcher, papers, groundedProfile, publicationIds);

  // ── Stage 2A: council deliberates the FULL candidate set over the profile ──
  logger.info('starting council batch', { researcher_id: ridBare, papers: joined.papers.length });
  const batchResults = await runCouncilBatch(researcher, joined.papers, groundedProfile, logger);

  const paperMap = new Map(joined.papers.map(p => [p.paper_id, p]));
  const feedItems = batchResults.map(result => {
    const paper = paperMap.get(result.paper_id)!;
    const feedItemId = `feed-${ridBare}-${result.paper_id}`; // generated — feed items are council OUTPUT
    return parseCouncilResult(result.raw, result.paper_id, paper, feedItemId, ridBare, logger);
  });

  // ── Phase 1 (presentation sort): relevance_score desc, pure ordering ──
  const sorted = sortFeed(feedItems);
  logger.info('council + sort complete', {
    researcher_id: ridBare,
    items: sorted.length,
    accepted: sorted.filter(fi => fi.relevance_decision && fi.decision_status === 'ok').length,
  });

  // ── Stage 2B: feed summary — only after council completes and feed is sorted ──
  const feed_summary = await runFeedSummary(researcher.name, sorted, logger);

  const researcherFeeds: ResearcherFeed[] = [{
    researcher_id: ridBare,
    researcher_name: researcher.name,
    grounding_status: 'ok',
    grounded_profile: groundedProfile,
    feed: sorted,
    feed_summary,
  }];

  const evalResult = await evaluate(researcherFeeds, [researcher], logger, win);
  if (!evalResult.passed) {
    throw new Error(`eval failed:\n${evalResult.errors.join('\n')}`);
  }

  return { artifact: researcherFeeds, metrics };
}
