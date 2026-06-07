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
  config: {
    trace_id: traceId,
    model: 'claude-sonnet-4-6',
    researchers: 3,
    papers_per_researcher: 10,
    total_papers: 30,
    grounding_enabled: true,
  },
});

logger.info('pipeline start', { traceId, weave_project: project });

try {
  const artifact = await orchestrate(logger);

  await mkdir('public', { recursive: true });
  await writeFile('public/output_data.json', JSON.stringify(artifact, null, 2));

  // W&B: per-researcher decision/confidence distributions, accept/reject counts
  const metrics: Record<string, number | boolean> = {
    eval_passed: true,
    total_feed_items: artifact.flatMap(r => r.feed).length,
  };

  for (const rf of artifact) {
    const rid = rf.researcher_id.replace('-', '_').toLowerCase();
    const accepted = rf.feed.filter(fi => fi.relevance_decision && fi.decision_status === 'ok');
    const rejected = rf.feed.filter(fi => !fi.relevance_decision && fi.decision_status === 'ok');
    const okItems = rf.feed.filter(fi => fi.decision_status === 'ok');
    const avgScore = okItems.length > 0
      ? okItems.reduce((s, fi) => s + fi.relevance_score, 0) / okItems.length
      : 0;
    const avgConf = okItems.length > 0
      ? okItems.reduce((s, fi) => s + fi.council_confidence, 0) / okItems.length
      : 0;

    metrics[`${rid}_accept_count`] = accepted.length;
    metrics[`${rid}_reject_count`] = rejected.length;
    metrics[`${rid}_avg_relevance_score`] = Math.round(avgScore * 1000) / 1000;
    metrics[`${rid}_avg_council_confidence`] = Math.round(avgConf * 10) / 10;
    metrics[`${rid}_summary_ok`] = rf.feed_summary.summary_status === 'ok' ? 1 : 0;
    metrics[`${rid}_decision_ok_count`] = okItems.length;
    metrics[`${rid}_decision_unavailable_count`] = rf.feed.filter(fi => fi.decision_status === 'unavailable').length;
    metrics[`${rid}_decision_malformed_count`] = rf.feed.filter(fi => fi.decision_status === 'malformed').length;

    // Grounding (Stage 1) metrics
    const gp = rf.grounded_profile;
    metrics[`${rid}_grounding_ok`] = rf.grounding_status === 'ok' ? 1 : 0;
    metrics[`${rid}_components_count`] = gp ? gp.research_components.length : 0;
    metrics[`${rid}_subfields_count`] = gp ? gp.research_subfield_preferences.length : 0;
    metrics[`${rid}_aptness_flags_total`] = gp
      ? [...gp.research_components, ...gp.research_subfield_preferences].reduce((n, x) => n + x.aptness_flags.length, 0)
      : 0;
  }

  wandb.log(metrics);

  logger.info('pipeline complete', {
    output: 'public/output_data.json',
    researchers: artifact.length,
    total_items: artifact.flatMap(r => r.feed).length,
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
