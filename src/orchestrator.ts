import { readFile } from 'node:fs/promises';
import { join } from './join.js';
import { sortFeed, assertRecencyWindow } from './sequencer.js';
import { runCouncilBatch, parseCouncilResult, runFeedSummary } from './subagent.js';
import { evaluate } from './eval.js';
import {
  validateResearchers,
  validatePapers,
  validateResearchComponents,
  validateSubfieldPreferences,
  validateFeedItemSeeds,
} from './schemas.js';
import type { OutputArtifact, ResearcherFeed } from './schemas.js';
import type { Logger } from './logger.js';

export async function orchestrate(logger: Logger): Promise<OutputArtifact> {
  const [researchersRaw, papersRaw, componentsRaw, feedItemsRaw, subfieldsRaw] = await Promise.all([
    readFile('data/researchers.json', 'utf-8'),
    readFile('data/papers.json', 'utf-8'),
    readFile('data/research_components.json', 'utf-8'),
    readFile('data/feed_items.json', 'utf-8'),
    readFile('data/research_subfield_preferences.json', 'utf-8'),
  ]);

  const researchers = JSON.parse(researchersRaw);
  const papers = JSON.parse(papersRaw);
  const components = JSON.parse(componentsRaw);
  const feedItemSeeds = JSON.parse(feedItemsRaw);
  const subfields = JSON.parse(subfieldsRaw);

  if (!validateResearchers(researchers)) {
    throw new Error(`researchers.json invalid: ${JSON.stringify(validateResearchers.errors)}`);
  }
  if (!validatePapers(papers)) {
    throw new Error(`papers.json invalid: ${JSON.stringify(validatePapers.errors)}`);
  }
  if (!validateResearchComponents(components)) {
    throw new Error(`research_components.json invalid: ${JSON.stringify(validateResearchComponents.errors)}`);
  }
  if (!validateSubfieldPreferences(subfields)) {
    throw new Error(`research_subfield_preferences.json invalid: ${JSON.stringify(validateSubfieldPreferences.errors)}`);
  }
  if (!validateFeedItemSeeds(feedItemSeeds)) {
    throw new Error(`feed_items.json invalid: ${JSON.stringify(validateFeedItemSeeds.errors)}`);
  }

  logger.info('fixtures loaded and validated', {
    researchers: researchers.length,
    papers: papers.length,
    components: components.length,
    feedItems: feedItemSeeds.length,
    subfields: subfields.length,
  });

  assertRecencyWindow(papers);

  const joined = join(researchers, papers, components, subfields, feedItemSeeds);
  logger.info('cross-file joins complete, no orphans');

  const researcherFeeds: ResearcherFeed[] = [];

  for (const { researcher, papers: researcherPapers, components: researcherComponents, subfields: researcherSubfields, feedItems: researcherFeedItems } of joined) {
    logger.info('starting council batch', {
      researcher_id: researcher.researcher_id,
      papers: researcherPapers.length,
    });

    // Phase 2A: council deliberates over all 10 papers for this researcher
    const batchResults = await runCouncilBatch(
      researcher,
      researcherPapers,
      researcherComponents,
      researcherSubfields,
      logger,
    );

    // Map batch results to FeedItems, overwriting fixture seed decision fields
    const feedItemMap = new Map(researcherFeedItems.map(fi => [fi.paper_id, fi]));
    const paperMap = new Map(researcherPapers.map(p => [p.paper_id, p]));

    const feedItems = batchResults.map(result => {
      const paper = paperMap.get(result.paper_id)!;
      const seed = feedItemMap.get(result.paper_id)!;
      return parseCouncilResult(
        result.raw,
        result.paper_id,
        paper,
        seed.id,
        researcher.researcher_id,
        logger,
      );
    });

    // Phase 1 / post-council: sort by relevance_score desc (pure presentation sort)
    const sorted = sortFeed(feedItems);

    logger.info('council + sort complete', {
      researcher_id: researcher.researcher_id,
      order: sorted.map(fi => `${fi.position}:${fi.paper_id}:${fi.relevance_score.toFixed(2)}`),
    });

    // Phase 2B: feed summary — only reachable after council batch completes and feed is sorted
    const feed_summary = await runFeedSummary(researcher.name, sorted, logger);

    researcherFeeds.push({
      researcher_id: researcher.researcher_id,
      researcher_name: researcher.name,
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
