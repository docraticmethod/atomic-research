import Anthropic from '@anthropic-ai/sdk';
import { op } from 'weave';
import { buildCouncilMessages } from './skills/council.js';
import type { Researcher, Paper, ResearchComponent, SubfieldPreference, FeedItem, FeedSummary, CouncilDeliberation, MatchedComponent } from './schemas.js';
import type { Logger } from './logger.js';

const MODEL = 'claude-sonnet-4-6';

export type CouncilBatchResult = {
  paper_id: string;
  raw: string | null;
  error: string | null;
};

export const runCouncilBatch = op(async function runCouncilBatch(
  researcher: Researcher,
  papers: Paper[],
  components: ResearchComponent[],
  subfields: SubfieldPreference[],
  logger: Logger,
): Promise<CouncilBatchResult[]> {
  const client = new Anthropic({ maxRetries: 3 });

  logger.info('submitting council calls', {
    researcher_id: researcher.researcher_id,
    count: papers.length,
    model: MODEL,
  });

  const results = await Promise.all(
    papers.map(async (paper): Promise<CouncilBatchResult> => {
      const { system, user } = await buildCouncilMessages(researcher, components, subfields, paper);
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const block = response.content[0];
        return {
          paper_id: paper.paper_id,
          raw: block.type === 'text' ? block.text : null,
          error: null,
        };
      } catch (err) {
        logger.error('council call failed', {
          researcher_id: researcher.researcher_id,
          paper_id: paper.paper_id,
          error: String(err),
        });
        return { paper_id: paper.paper_id, raw: null, error: String(err) };
      }
    }),
  );

  logger.info('council calls complete', {
    researcher_id: researcher.researcher_id,
    count: results.length,
    succeeded: results.filter(r => r.raw !== null).length,
    failed: results.filter(r => r.raw === null).length,
  });

  return results;
});

export function parseCouncilResult(
  raw: string | null,
  paperId: string,
  paper: Paper,
  feedItemId: string,
  researcherId: string,
  logger: Logger,
): FeedItem {
  const conservativePosition = 10;

  if (raw === null) {
    logger.warn('council decision unavailable', { paperId });
    return {
      feed_item_id: feedItemId,
      researcher_id: researcherId,
      paper_id: paperId,
      position: conservativePosition,
      title: paper.title,
      publication_date: paper.publication_date,
      relevance_decision: false,
      relevance_score: 0,
      council_confidence: 0,
      relevance_reason: 'Decision unavailable — retry',
      matched_components: [],
      matched_subfields: [],
      council_deliberation: {
        voices: [],
        substantive_vs_superficial: '',
        resolution: 'Decision unavailable — retry',
      },
      decision_status: 'unavailable',
    };
  }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const relevance_decision = Boolean(parsed.relevance_decision);
    const relevance_score = Number(parsed.relevance_score ?? 0);
    const council_confidence = Math.round(Number(parsed.council_confidence ?? 0));
    const relevance_reason = String(parsed.relevance_reason ?? '');
    const matched_components = (parsed.matched_components as MatchedComponent[] | undefined) ?? [];
    const matched_subfields = (parsed.matched_subfields as string[] | undefined) ?? [];
    const rawDelib = parsed.council_deliberation as Record<string, unknown> | undefined;

    const voices = (rawDelib?.voices as CouncilDeliberation['voices'] | undefined) ?? [];
    const svs = String(rawDelib?.substantive_vs_superficial ?? '').trim();
    const resolution = String(rawDelib?.resolution ?? '').trim();

    // Treat a structurally incomplete deliberation as malformed so it renders
    // as a retryable placeholder rather than silently passing a broken record.
    if (voices.length === 0 || svs.length === 0) {
      logger.error('council deliberation incomplete — voices or substantive_vs_superficial empty', {
        paperId,
        voices_count: voices.length,
        svs_len: svs.length,
        rawPreview: raw.slice(0, 400),
      });
      return {
        feed_item_id: feedItemId,
        researcher_id: researcherId,
        paper_id: paperId,
        position: conservativePosition,
        title: paper.title,
        publication_date: paper.publication_date,
        relevance_decision: false,
        relevance_score: 0,
        council_confidence: 0,
        relevance_reason: 'Decision malformed — retry',
        matched_components: [],
        matched_subfields: [],
        council_deliberation: {
          voices: [],
          substantive_vs_superficial: '',
          resolution: 'Decision malformed — retry',
        },
        decision_status: 'malformed',
      };
    }

    const council_deliberation: CouncilDeliberation = {
      voices,
      substantive_vs_superficial: svs,
      resolution,
    };

    return {
      feed_item_id: feedItemId,
      researcher_id: researcherId,
      paper_id: paperId,
      position: 0,
      title: paper.title,
      publication_date: paper.publication_date,
      relevance_decision,
      relevance_score,
      council_confidence,
      relevance_reason,
      matched_components,
      matched_subfields,
      council_deliberation,
      decision_status: 'ok',
    };
  } catch {
    logger.error('malformed council JSON', { paperId, rawPreview: raw.slice(0, 300) });
    return {
      feed_item_id: feedItemId,
      researcher_id: researcherId,
      paper_id: paperId,
      position: conservativePosition,
      title: paper.title,
      publication_date: paper.publication_date,
      relevance_decision: false,
      relevance_score: 0,
      council_confidence: 0,
      relevance_reason: 'Decision malformed — retry',
      matched_components: [],
      matched_subfields: [],
      council_deliberation: {
        voices: [],
        substantive_vs_superficial: '',
        resolution: 'Decision malformed — retry',
      },
      decision_status: 'malformed',
    };
  }
}

export const runFeedSummary = op(async function runFeedSummary(
  researcherName: string,
  sortedFeed: FeedItem[],
  logger: Logger,
): Promise<FeedSummary> {
  const client = new Anthropic({ maxRetries: 3 });

  const acceptedItems = sortedFeed.filter(fi => fi.relevance_decision && fi.decision_status === 'ok');
  const itemLines = sortedFeed
    .map(fi => {
      const verdict = fi.relevance_decision ? 'ACCEPT' : 'REJECT';
      return `  ${fi.position}. [${verdict}] "${fi.title}" — score: ${fi.relevance_score.toFixed(2)}, confidence: ${fi.council_confidence}`;
    })
    .join('\n');

  const prompt = `You are writing a brief editorial summary of a ranked research paper feed for a researcher.

Researcher: ${researcherName}

Here is the full decided, sorted feed (position 1 = highest relevance score):
${itemLines}

Write 2–3 sentences naming the 2–3 strongest papers (those accepted with the highest scores) and their collective significance to this researcher's work. Be specific about why these papers matter together, not just individually. Return plain prose — no JSON, no lists, no markdown.`;

  logger.info('issuing feed_summary call', {
    researcher: researcherName,
    model: MODEL,
    accepted: acceptedItems.length,
    total: sortedFeed.length,
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    const text = block.type === 'text' ? block.text.trim() : '';

    if (!text) {
      logger.warn('feed_summary returned empty text', { researcher: researcherName });
      return { text: '', summary_status: 'unavailable' };
    }

    logger.info('feed_summary complete', { researcher: researcherName });
    return { text, summary_status: 'ok' };
  } catch (err) {
    logger.error('feed_summary call failed', { researcher: researcherName, error: String(err) });
    return { text: '', summary_status: 'unavailable' };
  }
});
