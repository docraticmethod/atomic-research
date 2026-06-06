import Anthropic from '@anthropic-ai/sdk';
import { buildRationaleMessages } from './skills/rationale.js';
import type { SequencedPaper } from './sequencer.js';
import type { ResearcherProfile } from './schemas.js';
import type { Logger } from './logger.js';

const MODEL = 'claude-sonnet-4-6';
const POLL_INTERVAL_MS = 10_000;

export type BatchResult = {
  paper_id: string;
  raw: string | null;
  error: string | null;
};

export async function runBatch(
  papers: SequencedPaper[],
  profile: ResearcherProfile,
  logger: Logger,
): Promise<BatchResult[]> {
  const client = new Anthropic({ maxRetries: 3 });

  const requests = papers.map(paper => {
    const { system, user } = buildRationaleMessages(paper, profile);
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
}
