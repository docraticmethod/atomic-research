import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TRACES_DIR = 'traces';

type Level = 'info' | 'warn' | 'error';

function write(logFile: string, traceId: string, level: Level, message: string, data?: unknown) {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    traceId,
    level,
    message,
  };
  if (data !== undefined) entry.data = data;
  appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

export function createLogger(traceId: string) {
  mkdirSync(TRACES_DIR, { recursive: true });
  const logFile = join(TRACES_DIR, `${traceId}.jsonl`);
  return {
    info:  (message: string, data?: unknown) => write(logFile, traceId, 'info',  message, data),
    warn:  (message: string, data?: unknown) => write(logFile, traceId, 'warn',  message, data),
    error: (message: string, data?: unknown) => write(logFile, traceId, 'error', message, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
