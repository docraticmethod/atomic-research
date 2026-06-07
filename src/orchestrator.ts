import { readFile } from 'node:fs/promises';
import { assertNoIdSpaceConflict, joinResearcher } from './join.js';
import { sortFeed, assertRecencyWindow } from './sequencer.js';
import {
  runGroundingExtraction, runAptnessValidation, runGroundingRepair,
  runCouncilBatch, parseCouncilResult, runFeedSummary,
} from './subagent.js';
import { runIntegrityModel } from './integrity.js';
import { evaluate } from './eval.js';
import {
  validateResearchers,
  validatePublications,
  validatePapers,
  validateFeedItemSeeds,
} from './schemas.js';
import type {
  OutputArtifact, ResearcherFeed,
  Researcher, Publication, Paper, FeedItemSeed,
} from './schemas.js';
import type { Logger } from './logger.js';

export async function orchestrate(logger: Logger): Promise<OutputArtifact> {
  // ── Phase 0: load + validate the four input fixtures ──
  // research_components.json / research_subfield_preferences.json are NOT loaded —
  // they are Stage-1 output, produced by grounding below.
  const [researchersRaw, publicationsRaw, papersRaw, feedItemsRaw] = await Promise.all([
    readFile('data/researchers.json', 'utf-8'),
    readFile('data/publications.json', 'utf-8'),
    readFile('data/papers.json', 'utf-8'),
    readFile('data/feed_items.json', 'utf-8'),
  ]);

  const researchers = JSON.parse(researchersRaw) as Researcher[];
  const publications = JSON.parse(publicationsRaw) as Publication[];
  const papers = JSON.parse(papersRaw) as Paper[];
  const feedItemSeeds = JSON.parse(feedItemsRaw) as FeedItemSeed[];

  if (!validateResearchers(researchers)) {
    throw new Error(`researchers.json invalid: ${JSON.stringify(validateResearchers.errors)}`);
  }
  if (!validatePublications(publications)) {
    throw new Error(`publications.json invalid: ${JSON.stringify(validatePublications.errors)}`);
  }
  if (!validatePapers(papers)) {
    throw new Error(`papers.json invalid: ${JSON.stringify(validatePapers.errors)}`);
  }
  if (!validateFeedItemSeeds(feedItemSeeds)) {
    throw new Error(`feed_items.json invalid: ${JSON.stringify(validateFeedItemSeeds.errors)}`);
  }

  // publications and candidate papers are never conflated — assert disjoint id-spaces
  assertNoIdSpaceConflict(papers, publications);

  logger.info('fixtures loaded and validated', {
    researchers: researchers.length,
    publications: publications.length,
    papers: papers.length,
    feedItems: feedItemSeeds.length,
  });

  assertRecencyWindow(papers);

  const researcherFeeds: ResearcherFeed[] = [];

  for (const researcher of researchers) {
    const rid = researcher.researcher_id;
    const researcherPubs = publications.filter(p => p.researcher_id === rid);
    const publicationIds = new Set(researcherPubs.map(p => p.publication_id));

    // ── Stage 1: grounding (extraction → aptness → integrity model) ──
    logger.info('starting grounding', { researcher_id: rid, publications: researcherPubs.length });

    const call1Raw = await runGroundingExtraction(researcher, researcherPubs, logger);
    const call2Raw = call1Raw ? await runAptnessValidation(researcher, call1Raw, logger) : null;
    const repairFn = (reason: string) => runGroundingRepair(researcher, researcherPubs, reason, logger);

    const groundedProfile = await runIntegrityModel(
      call1Raw ?? '',
      call2Raw,
      rid,
      publicationIds,
      logger,
      repairFn,
    );

    // ── Grounding gate: the council is unreachable on a degraded profile ──
    if (groundedProfile === null) {
      logger.warn('grounding degraded — skipping council for this researcher', { researcher_id: rid });
      researcherFeeds.push({
        researcher_id: rid,
        researcher_name: researcher.name,
        grounding_status: 'unavailable',
        grounded_profile: null,
        feed: [],
        feed_summary: { text: '', summary_status: 'unavailable' },
      });
      continue;
    }

    // ── Phase 1: per-researcher join (papers + feed items + grounded profile) ──
    const researcherFeedItems = feedItemSeeds.filter(fi => fi.researcher_id === rid);
    const researcherPaperIds = new Set(researcherFeedItems.map(fi => fi.paper_id));
    const researcherPapers = papers.filter(p => researcherPaperIds.has(p.paper_id));

    const joined = joinResearcher(researcher, researcherPapers, groundedProfile, researcherFeedItems, publicationIds);

    // ── Stage 2A: council deliberates over the grounded profile ──
    logger.info('starting council batch', { researcher_id: rid, papers: joined.papers.length });
    const batchResults = await runCouncilBatch(researcher, joined.papers, groundedProfile, logger);

    const feedItemMap = new Map(joined.feedItems.map(fi => [fi.paper_id, fi]));
    const paperMap = new Map(joined.papers.map(p => [p.paper_id, p]));

    const feedItems = batchResults.map(result => {
      const paper = paperMap.get(result.paper_id)!;
      const seed = feedItemMap.get(result.paper_id)!;
      return parseCouncilResult(result.raw, result.paper_id, paper, seed.id, rid, logger);
    });

    // ── Phase 1 (presentation sort): relevance_score desc, pure ordering ──
    const sorted = sortFeed(feedItems);
    logger.info('council + sort complete', {
      researcher_id: rid,
      order: sorted.map(fi => `${fi.position}:${fi.paper_id}:${fi.relevance_score.toFixed(2)}`),
    });

    // ── Stage 2B: feed summary — only after council completes and feed is sorted ──
    const feed_summary = await runFeedSummary(researcher.name, sorted, logger);

    researcherFeeds.push({
      researcher_id: rid,
      researcher_name: researcher.name,
      grounding_status: 'ok',
      grounded_profile: groundedProfile,
      feed: sorted,
      feed_summary,
    });
  }

  const evalResult = await evaluate(researcherFeeds, researchers, logger);
  if (!evalResult.passed) {
    throw new Error(`eval failed:\n${evalResult.errors.join('\n')}`);
  }

  return researcherFeeds;
}
