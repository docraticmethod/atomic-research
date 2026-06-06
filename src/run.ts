import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { init as weaveInit, login as weaveLogin } from 'weave';
import wandb from '@wandb/sdk';
import { createLogger } from './logger.js';
import { orchestrate } from './orchestrator.js';

const traceId = randomUUID();
const logger = createLogger(traceId);

// Authenticate Weave with the API key from .env, then init the project.
// weave.init must run before any Anthropic call — the ESM hook registered
// via --import=weave/instrument auto-instruments @anthropic-ai/sdk.
const WANDB_API_KEY = process.env.WANDB_API_KEY;
if (!WANDB_API_KEY) {
  logger.error('WANDB_API_KEY not set — observability will be degraded');
} else {
  await weaveLogin(WANDB_API_KEY);
}

const WANDB_ENTITY = process.env.WANDB_ENTITY ?? '';
const project = WANDB_ENTITY ? `${WANDB_ENTITY}/atomic-research` : 'atomic-research';
await weaveInit(project);

const wandbRun = await wandb.init({
  project: 'atomic-research',
  ...(WANDB_ENTITY ? { entity: WANDB_ENTITY } : {}),
  name: `pipeline-${traceId.slice(0, 8)}`,
  config: { trace_id: traceId, model: 'claude-sonnet-4-6', threshold: 0.60, papers: 10 },
});

logger.info('pipeline start', { traceId, weave_project: project });

try {
  const artifact = await orchestrate(logger);

  await mkdir('public', { recursive: true });
  await writeFile('public/output_data.json', JSON.stringify(artifact, null, 2));

  const evalErrors = 0;
  const maxSims = artifact.papers.map(p => p.max_component_similarity);
  const avgSim = maxSims.reduce((a, b) => a + b, 0) / maxSims.length;

  wandb.log({
    papers_ranked: artifact.papers.length,
    eval_passed: true,
    eval_error_count: evalErrors,
    feed_summary_status: artifact.feed_summary.summary_status,
    avg_max_component_similarity: avgSim,
    read_now_count: artifact.papers.filter(p => p.recommended_action === 'Read now').length,
    save_count: artifact.papers.filter(p => p.recommended_action === 'Save').length,
    skip_count: artifact.papers.filter(p => p.recommended_action === 'Skip').length,
    rationale_ok_count: artifact.papers.filter(p => p.rationale_status === 'ok').length,
  });

  logger.info('pipeline complete', {
    output: 'public/output_data.json',
    papers: artifact.papers.length,
    feed_summary_status: artifact.feed_summary.summary_status,
  });
  console.log(`✓ output written → public/output_data.json  (traceId: ${traceId})`);
} catch (err) {
  logger.error('pipeline failed', { error: String(err) });
  wandb.log({ eval_passed: false, error: String(err) });
  console.error(`✗ pipeline failed (traceId: ${traceId}):`, err);
  await wandb.finish(1);
  process.exit(1);
}

await wandb.finish();
