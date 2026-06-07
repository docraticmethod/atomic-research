import express, { type Request, type Response } from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOutputArtifact } from './schemas.js';
import { searchAuthors } from './openalex-client.js';
import { createLogger } from './logger.js';
import type { OutputArtifact } from './schemas.js';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dir, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const OUTPUT_FILE = resolve(PUBLIC_DIR, 'output_data.json');
const LINK_STATE_FILE = resolve(PUBLIC_DIR, 'link_state.json');

const logger = createLogger('dash-server');

// ── In-process pipeline run state (the onboarding "scanning" surface) ──
type PipelineState = 'idle' | 'running' | 'done' | 'error';
let pipelineState: PipelineState = existsSync(OUTPUT_FILE) ? 'done' : 'idle';
let pipelineError = '';

// Re-read fresh each request so a just-finished pipeline run is reflected
// without a server restart. Returns null when output is missing/invalid.
function readArtifact(): OutputArtifact | null {
  if (!existsSync(OUTPUT_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8')) as unknown;
    if (!validateOutputArtifact(data as OutputArtifact)) {
      logger.error('output_data.json failed validation', { errors: validateOutputArtifact.errors });
      return null;
    }
    return data as OutputArtifact;
  } catch (err) {
    logger.error('output_data.json read failed', { error: String(err) });
    return null;
  }
}

function readLinkState(): { author_id?: string } | null {
  if (!existsSync(LINK_STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LINK_STATE_FILE, 'utf-8')) as { author_id?: string };
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── Onboarding: author search (the "is this you?" picker) ──
app.get('/api/authors', async (req: Request, res: Response) => {
  const query = String(req.query.search ?? '').trim();
  if (query.length < 2) {
    res.json({ results: [] });
    return;
  }
  const raw = await searchAuthors(query, logger);
  const results = raw.map(a => ({
    authorId: a.id.replace(/^https?:\/\/openalex\.org\//, ''),
    name: a.display_name,
    affiliation: a.last_known_institutions?.[0]?.display_name ?? null,
    paperCount: a.works_count,
    citationCount: a.cited_by_count,
  }));
  res.json({ results });
});

// ── Onboarding: confirm the link, persist the single author id, run pipeline ──
app.post('/api/link', (req: Request, res: Response) => {
  const authorId = String(req.body?.author_id ?? '').trim();
  if (!/^A\d+$/.test(authorId)) {
    res.status(400).json({ error: 'invalid author_id' });
    return;
  }
  if (pipelineState === 'running') {
    res.status(409).json({ error: 'a scan is already running' });
    return;
  }

  mkdirSync(PUBLIC_DIR, { recursive: true });
  // Clear any prior output so has_output flips false→true exactly when THIS run
  // finishes — the dashboard polls on output presence, not the child-exit flag.
  if (existsSync(OUTPUT_FILE)) rmSync(OUTPUT_FILE);
  writeFileSync(LINK_STATE_FILE, JSON.stringify({ author_id: authorId, linked_at: new Date().toISOString() }, null, 2));
  logger.info('author link confirmed — starting pipeline', { author_id: authorId });

  pipelineState = 'running';
  pipelineError = '';
  const child = spawn('npm', ['run', 'run:pipeline'], {
    cwd: ROOT,
    env: { ...process.env, LINKED_AUTHOR_ID: authorId },
    stdio: 'inherit',
  });
  child.on('exit', code => {
    pipelineState = code === 0 ? 'done' : 'error';
    if (code !== 0) pipelineError = `pipeline exited with code ${code}`;
    logger.info('pipeline child exited', { code, state: pipelineState });
  });
  child.on('error', err => {
    pipelineState = 'error';
    pipelineError = String(err);
    logger.error('pipeline child failed to start', { error: String(err) });
  });

  res.json({ started: true, author_id: authorId });
});

// ── Onboarding/router status ──
app.get('/api/status', (_req: Request, res: Response) => {
  const link = readLinkState();
  res.json({
    linked: Boolean(link?.author_id),
    author_id: link?.author_id ?? null,
    pipeline: pipelineState,
    pipeline_error: pipelineError || null,
    has_output: existsSync(OUTPUT_FILE),
  });
});

// ── Feed data (read fresh each request) ──
app.get('/api/artifact', (_req: Request, res: Response) => {
  const artifact = readArtifact();
  if (!artifact) {
    res.status(404).json({ error: 'no output yet — link an author to run the pipeline' });
    return;
  }
  res.json(artifact);
});

app.get('/api/feed/:researcher_id', (req: Request, res: Response) => {
  const artifact = readArtifact() ?? [];
  const rf = artifact.find(r => r.researcher_id === req.params.researcher_id);
  if (!rf) {
    res.status(404).json({ error: 'researcher not found' });
    return;
  }
  res.json(rf);
});

app.get('/api/researcher/:researcher_id/profile', (req: Request, res: Response) => {
  const artifact = readArtifact() ?? [];
  const rf = artifact.find(r => r.researcher_id === req.params.researcher_id);
  if (!rf) {
    res.status(404).json({ error: 'researcher not found' });
    return;
  }
  res.json({ grounding_status: rf.grounding_status, grounded_profile: rf.grounded_profile });
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(resolve(PUBLIC_DIR, 'dash-app.html'));
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = process.env.PORT ?? 4000;
  app.listen(PORT, () => {
    console.log(`Dashboard → http://localhost:${PORT}/dash-app.html`);
  });
}

export { app };
