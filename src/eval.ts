import { validateOutputPapers } from './schemas.js';
import type { OutputPaper } from './schemas.js';
import { THRESHOLD } from './sequencer.js';
import type { Logger } from './logger.js';

export type EvalResult = {
  passed: boolean;
  errors: string[];
};

const TANGENTIAL_TERMS = ['tangential', 'loose', 'peripheral', 'superficial', 'indirect'];

export function evaluate(papers: OutputPaper[], logger: Logger): EvalResult {
  const errors: string[] = [];

  // Schema gate — Ajv validates all 10 papers against the output contract
  if (!validateOutputPapers(papers)) {
    for (const err of validateOutputPapers.errors ?? []) {
      errors.push(`schema: ${err.instancePath} ${err.message}`);
    }
  }

  // Sanity: ranks 1–10, no gaps, no duplicates
  const ranks = papers.map(p => p.rank).sort((a, b) => a - b);
  if (JSON.stringify(ranks) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
    errors.push(`sanity: ranks are not 1–10 without gaps — got ${JSON.stringify(ranks)}`);
  }

  // Sanity: rank order matches deterministic rule (recompute and compare)
  const reranked = [...papers].sort((a, b) => {
    if (b.max_component_similarity !== a.max_component_similarity) {
      return b.max_component_similarity - a.max_component_similarity;
    }
    const aC = a.components.filter(c => c.component_similarity >= THRESHOLD).length;
    const bC = b.components.filter(c => c.component_similarity >= THRESHOLD).length;
    if (bC !== aC) return bC - aC;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
  reranked.forEach((expected, i) => {
    const actual = papers.find(p => p.paper_id === expected.paper_id);
    if (!actual || actual.rank !== i + 1) {
      errors.push(
        `sanity: ${expected.paper_id} should be rank ${i + 1}, got ${actual?.rank ?? 'missing'}`,
      );
    }
  });

  // Sanity: recommended_action mapping
  for (const p of papers) {
    const expected =
      p.max_component_similarity >= 0.80 ? 'Read now' :
      p.max_component_similarity >= THRESHOLD ? 'Save' :
      'Skip';
    if (p.recommended_action !== expected) {
      errors.push(
        `sanity: ${p.paper_id} action "${p.recommended_action}" expected "${expected}"`,
      );
    }
  }

  // Sanity: components_cleared_count
  for (const p of papers) {
    const expected = p.components.filter(c => c.component_similarity >= THRESHOLD).length;
    if (p.components_cleared_count !== expected) {
      errors.push(
        `sanity: ${p.paper_id} cleared_count ${p.components_cleared_count} expected ${expected}`,
      );
    }
  }

  // Sanity: PAP-07 tangential_flag and framing
  const pap07 = papers.find(p => p.paper_id === 'PAP-07');
  if (!pap07) {
    errors.push('sanity: PAP-07 missing from output');
  } else {
    if (!pap07.tangential_flag) {
      errors.push('sanity: PAP-07 tangential_flag must be true');
    }
    const combined = (pap07.relevance_rationale + ' ' + pap07.position_rationale).toLowerCase();
    if (!TANGENTIAL_TERMS.some(t => combined.includes(t))) {
      errors.push('sanity: PAP-07 rationale must contain tangential framing');
    }
  }

  if (errors.length > 0) {
    logger.error('eval failed', { error_count: errors.length, errors });
  } else {
    logger.info('eval passed');
  }

  return { passed: errors.length === 0, errors };
}
