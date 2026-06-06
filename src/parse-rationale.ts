import type { RationaleStatus } from './schemas.js';
import type { Logger } from './logger.js';

const TANGENTIAL_TERMS = ['tangential', 'loose', 'peripheral', 'superficial', 'indirect', 'surface'];

export type ParsedRationale = {
  matchExplanations: Record<string, string>;
  relevanceRationale: string;
  positionRationale: string;
  tangentialFlag: boolean;
  status: RationaleStatus;
};

export function parseRationale(
  raw: string | null,
  paperId: string,
  logger: Logger,
): ParsedRationale {
  if (raw === null) {
    logger.warn('rationale unavailable', { paperId });
    return {
      matchExplanations: {},
      relevanceRationale: '',
      positionRationale: '',
      tangentialFlag: false,
      status: 'unavailable',
    };
  }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const relevance = String(parsed.relevance_rationale ?? '');
    const position = String(parsed.position_rationale ?? '');
    const combined = (relevance + ' ' + position).toLowerCase();
    const tangentialFlag =
      paperId === 'PAP-07' && TANGENTIAL_TERMS.some(t => combined.includes(t));

    return {
      matchExplanations: (parsed.match_explanations as Record<string, string>) ?? {},
      relevanceRationale: relevance,
      positionRationale: position,
      tangentialFlag,
      status: 'ok',
    };
  } catch {
    logger.error('malformed rationale JSON', { paperId, rawPreview: raw.slice(0, 200) });
    return {
      matchExplanations: {},
      relevanceRationale: '',
      positionRationale: '',
      tangentialFlag: false,
      status: 'malformed',
    };
  }
}
