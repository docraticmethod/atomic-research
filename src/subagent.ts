import Anthropic from '@anthropic-ai/sdk';
import { op } from 'weave';
import { buildRationaleMessages } from './skills/rationale.js';
import type { SequencedPaper } from './sequencer.js';
import type { ResearcherProfile, CandidatePaper, FeedSummary } from './schemas.js';
import type { Logger } from './logger.js';

const MODEL = 'claude-sonnet-4-6';
const POLL_INTERVAL_MS = 10_000;

export type BatchResult = {
  paper_id: string;
  raw: string | null;
  error: string | null;
};

export const runBatch = op(async function runBatch(
  papers: SequencedPaper[],
  profile: ResearcherProfile,
  fixtures: CandidatePaper[],
  logger: Logger,
): Promise<BatchResult[]> {
  const client = new Anthropic({ maxRetries: 3 });

  const requests = papers.map(paper => {
    const fixture = fixtures.find(f => f.paper_id === paper.paper_id)!;
    const { system, user } = buildRationaleMessages(paper, profile, fixture);
    return {
      custom_id: paper.paper_id,
      params: {
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user' as const, content: user }],
      },
    };
  });

  logger.info('submitting batch', { count: requests.length, model: MODEL });
  const batch = await client.messages.batches.create({ requests });
  logger.info('batch submitted', { batch_id: batch.id });

  let status = batch.processing_status;
  while (status !== 'ended') {
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const current = await client.messages.batches.retrieve(batch.id);
    status = current.processing_status;
    logger.info('batch poll', {
      batch_id: batch.id,
      status,
      request_counts: current.request_counts,
    });
  }

  logger.info('batch complete, collecting results', { batch_id: batch.id });

  const results: BatchResult[] = [];
  const decoder = await client.messages.batches.results(batch.id);

  for await (const item of decoder) {
    if (item.result.type === 'succeeded') {
      const block = item.result.message.content[0];
      results.push({
        paper_id: item.custom_id,
        raw: block.type === 'text' ? block.text : null,
        error: null,
      });
    } else {
      logger.error('batch item did not succeed', {
        paper_id: item.custom_id,
        type: item.result.type,
      });
      results.push({
        paper_id: item.custom_id,
        raw: null,
        error: item.result.type,
      });
    }
  }

  logger.info('batch results collected', { count: results.length });
  return results;
});

export const runFeedSummary = op(async function runFeedSummary(
  sortedTopN: SequencedPaper[],
  logger: Logger,
): Promise<FeedSummary> {
  const client = new Anthropic({ maxRetries: 3 });

  const paperList = sortedTopN
    .map(p => `  ${p.rank}. "${p.title}" — ${p.recommended_action} (max similarity: ${p.max_component_similarity})`)
    .join('\n');

  const prompt = `You are summarising a ranked research paper feed for a researcher.

Here are the top papers in ranked order:
${paperList}

Write 2–3 sentences naming the 2–3 strongest papers and their collective significance to this researcher's work. Be specific about why these papers matter together, not just individually. Return plain prose — no JSON, no lists, no markdown.`;

  logger.info('issuing feed_summary call', { model: MODEL, paper_count: sortedTopN.length });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    const text = block.type === 'text' ? block.text.trim() : '';

    if (!text) {
      logger.warn('feed_summary call returned empty text');
      return { text: '', summary_status: 'unavailable' };
    }

    logger.info('feed_summary complete');
    return { text, summary_status: 'ok' };
  } catch (err) {
    logger.error('feed_summary call failed', { error: String(err) });
    return { text: '', summary_status: 'unavailable' };
  }
});
