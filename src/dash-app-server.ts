import express, { type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOutputArtifact } from './schemas.js';
import type { OutputArtifact } from './schemas.js';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT_FILE = resolve(__dir, '../public/output_data.json');
const PUBLIC_DIR  = resolve(__dir, '../public');

function loadArtifact(): OutputArtifact {
  let raw: string;
  try {
    raw = readFileSync(OUTPUT_FILE, 'utf-8');
  } catch {
    const msg = `output_data.json not found at ${OUTPUT_FILE} — run the pipeline first (npm run run:pipeline)`;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  }

  const data: unknown = JSON.parse(raw);
  if (!validateOutputArtifact(data as OutputArtifact)) {
    const msg = `output_data.json failed validation: ${JSON.stringify(validateOutputArtifact.errors)}`;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  }

  return data as OutputArtifact;
}

const artifact = loadArtifact();

const app = express();
app.use(express.static(PUBLIC_DIR));

// Returns the full artifact (array of ResearcherFeed)
app.get('/api/artifact', (_req: Request, res: Response) => {
  res.json(artifact);
});

// Returns one researcher's feed by researcher_id
app.get('/api/feed/:researcher_id', (req: Request, res: Response) => {
  const rf = artifact.find(r => r.researcher_id === req.params.researcher_id);
  if (!rf) {
    res.status(404).json({ error: 'researcher not found' });
    return;
  }
  res.json(rf);
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
