import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { orchestrate } from './orchestrator.js';

const traceId = randomUUID();
const logger = createLogger(traceId);

logger.info('pipeline start', { traceId });

try {
  const output = await orchestrate(logger);
  await mkdir('public', { recursive: true });
  await writeFile('public/output_data.json', JSON.stringify(output, null, 2));
  logger.info('pipeline complete', { output: 'public/output_data.json', papers: output.length });
  console.log(`✓ output written → public/output_data.json  (traceId: ${traceId})`);
} catch (err) {
  logger.error('pipeline failed', { error: String(err) });
  console.error(`✗ pipeline failed (traceId: ${traceId}):`, err);
  process.exit(1);
}
