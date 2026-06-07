import 'dotenv/config';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { init as weaveInit, login as weaveLogin } from 'weave';
import wandb from '@wandb/sdk';
import { createLogger } from './logger.js';
import { orchestrate } from './orchestrator.js';

const traceId = randomUUID();
const logger = createLogger(traceId);

// ── Resolve the single confirmed author link (the sole human decision) ──
// The dashboard persists the confirmed OpenAlex author id to public/link_state.json
// (or it can be supplied via LINKED_AUTHOR_ID). The fetch is unreachable-past
// until the link is confirmed.
async function resolveAuthorId(): Promise<string | null> {
  if (process.env.LINKED_AUTHOR_ID) return process.env.LINKED_AUTHOR_ID.trim();
  try {
    const raw = await readFile('public/link_state.json', 'utf-8');
    const state = JSON.parse(raw) as { author_id?: string };
    return state.author_id?.trim() || null;
  } catch {
    return null;
  }
}

const authorId = await resolveAuthorId();
if (!authorId) {
  console.error('✗ no confirmed author link — set LINKED_AUTHOR_ID or link via the dashboard first');
  logger.error('no confirmed author link; fetch is unreachable-past until link is confirmed');
  process.exit(1);
}

// weave.init must run before any Anthropic OR OpenAlex call — the ESM hook
// registered via --import=weave/instrument auto-instruments @anthropic-ai/sdk;
// the OpenAlex client + transforms are @weave.op so the fetch is traced too.
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
    author_id: authorId,
    data_source: 'openalex-live',
  },
});

logger.info('pipeline start', { traceId, weave_project: project, author_id: authorId });

try {
  const { artifact, metrics: pm } = await orchestrate(logger, authorId);

  await mkdir('public', { recursive: true });
  await writeFile('public/output_data.json', JSON.stringify(artifact, null, 2));

  const metrics: Record<string, number | boolean | string> = {
    eval_passed: true,
    total_feed_items: artifact.flatMap(r => r.feed).length,
    // ── Fetch-boundary metrics (new in v3.2) ──
    fetch_endpoint_calls: pm.endpoint_calls,
    fetch_endpoint_degrades: pm.endpoint_degrades,
    fetch_works_pulled: pm.works_pulled,
    fetch_subfields_selected: pm.subfields_selected,
    fetch_subfield_selection_source: pm.subfield_selection_source,
    fetch_candidate_papers_raw: pm.candidate_papers_raw,
    fetch_candidate_papers_in_window: pm.candidate_papers_in_window,
    fetch_candidate_papers_deduped: pm.candidate_papers_deduped,
    fetch_dedup_collapses: pm.dedup_collapses,
    fetch_abstract_null_count: pm.abstract_null_count,
  };

  for (const rf of artifact) {
    const rid = rf.researcher_id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const okItems = rf.feed.filter(fi => fi.decision_status === 'ok');
    const accepted = okItems.filter(fi => fi.relevance_decision);
    const rejected = okItems.filter(fi => !fi.relevance_decision);
    const avgScore = okItems.length > 0 ? okItems.reduce((s, fi) => s + fi.relevance_score, 0) / okItems.length : 0;
    const avgConf = okItems.length > 0 ? okItems.reduce((s, fi) => s + fi.council_confidence, 0) / okItems.length : 0;

    metrics[`${rid}_accept_count`] = accepted.length;
    metrics[`${rid}_reject_count`] = rejected.length;
    metrics[`${rid}_avg_relevance_score`] = Math.round(avgScore * 1000) / 1000;
    metrics[`${rid}_avg_council_confidence`] = Math.round(avgConf * 10) / 10;
    metrics[`${rid}_summary_ok`] = rf.feed_summary.summary_status === 'ok' ? 1 : 0;
    metrics[`${rid}_decision_ok_count`] = okItems.length;
    metrics[`${rid}_decision_unavailable_count`] = rf.feed.filter(fi => fi.decision_status === 'unavailable').length;
    metrics[`${rid}_decision_malformed_count`] = rf.feed.filter(fi => fi.decision_status === 'malformed').length;

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

// wandb.finish() can reject on flush/network issues at the very end; that must
// not turn a successful run (output already written) into a non-zero exit.
try {
  await wandb.finish();
} catch (err) {
  logger.warn('wandb.finish failed (non-fatal — output already written)', { error: String(err) });
}
// weave/wandb keep handles open which can hold the event loop and prevent the
// process from exiting; exit explicitly so a dashboard-spawned run completes and
// its child 'exit' fires promptly.
process.exit(0);
