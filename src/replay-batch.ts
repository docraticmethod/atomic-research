// One-off: replays an already-completed batch without resubmitting to the API.
// Usage: tsx src/replay-batch.ts <batch_id> [traceId]
import 'dotenv/config';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from './logger.js';
import { sequence } from './sequencer.js';
import { parseRationale } from './parse-rationale.js';
import { evaluate } from './eval.js';
import {
  validateCandidatePapers,
  validateResearcherProfile,
} from './schemas.js';
import type { CandidatePaper, ResearcherProfile, OutputPaper } from './schemas.js';

const batchId  = process.argv[2];
const traceId  = process.argv[3] ?? randomUUID();

if (!batchId) {
  console.error('Usage: tsx src/replay-batch.ts <batch_id>');
  process.exit(1);
}

const logger = createLogger(traceId);
logger.info('replay start', { batchId, traceId });

const client = new Anthropic({ maxRetries: 3 });

const [profileRaw, papersRaw] = await Promise.all([
  readFile('data/researcher_profile.json', 'utf-8'),
  readFile('data/candidate_papers.json', 'utf-8'),
]);
const profile = JSON.parse(profileRaw) as ResearcherProfile;
const papers  = JSON.parse(papersRaw) as CandidatePaper[];

if (!validateResearcherProfile(profile)) throw new Error('profile invalid');
if (!validateCandidatePapers(papers))   throw new Error('papers invalid');

const sequenced = sequence(papers);

logger.info('fetching batch results', { batchId });
const decoder = await client.messages.batches.results(batchId);

const rawResults: Record<string, string | null> = {};
for await (const item of decoder) {
  if (item.result.type === 'succeeded') {
    const block = item.result.message.content[0];
    rawResults[item.custom_id] = block.type === 'text' ? block.text : null;
  } else {
    logger.error('batch item not succeeded', { paperId: item.custom_id, type: item.result.type });
    rawResults[item.custom_id] = null;
  }
}

logger.info('results collected', { count: Object.keys(rawResults).length });

const output: OutputPaper[] = sequenced.map(paper => {
  const rationale = parseRationale(rawResults[paper.paper_id] ?? null, paper.paper_id, logger);
  return {
    paper_id:               paper.paper_id,
    rank:                   paper.rank,
    title:                  paper.title,
    date:                   paper.date,
    max_component_similarity: paper.max_component_similarity,
    recommended_action:     paper.recommended_action,
    components: paper.components.map(c => ({
      component:            c.component,
      component_similarity: c.component_similarity,
      cleared:              c.cleared,
      match_explanation:    rationale.matchExplanations[c.component] ?? '',
    })),
    components_cleared_count: paper.components_cleared_count,
    relevance_rationale:    rationale.relevanceRationale,
    position_rationale:     rationale.positionRationale,
    tangential_flag:        rationale.tangentialFlag,
    missing_information:    null,
    rationale_status:       rationale.status,
  };
});

const evalResult = evaluate(output, logger);
if (!evalResult.passed) {
  console.error('✗ eval failed:');
  evalResult.errors.forEach(e => console.error(' ', e));
  process.exit(1);
}

await mkdir('public', { recursive: true });
await writeFile('public/output_data.json', JSON.stringify(output, null, 2));
logger.info('replay complete', { output: 'public/output_data.json' });
console.log(`✓ output written → public/output_data.json  (traceId: ${traceId})`);
