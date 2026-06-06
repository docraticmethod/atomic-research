import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate } from '../src/eval.js';
import { sequence } from '../src/sequencer.js';
import { createLogger } from '../src/logger.js';
import type { OutputPaper, CandidatePaper } from '../src/schemas.js';

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  };
}

async function buildValidOutput(): Promise<OutputPaper[]> {
  const raw = await readFile('data/candidate_papers.json', 'utf-8');
  const papers: CandidatePaper[] = JSON.parse(raw);
  const sequenced = sequence(papers);

  return sequenced.map(p => ({
    paper_id: p.paper_id,
    rank: p.rank,
    title: p.title,
    date: p.date,
    max_component_similarity: p.max_component_similarity,
    recommended_action: p.recommended_action,
    components: p.components.map(c => ({
      ...c,
      match_explanation: 'test explanation',
    })),
    components_cleared_count: p.components_cleared_count,
    relevance_rationale: p.paper_id === 'PAP-07'
      ? 'This paper presents a tangential match — it touches information retrieval superficially but is primarily about blockchain provenance.'
      : p.paper_id === 'PAP-02'
      ? 'This is a breadth match — the paper spans multiple components including citation network analysis and scientific document embeddings, giving it cross-component relevance.'
      : 'Strong relevance rationale.',
    position_rationale: p.paper_id === 'PAP-07'
      ? 'Ranked here due to a loose connection; the match is peripheral.'
      : 'Positioned correctly.',
    tangential_flag: p.paper_id === 'PAP-07',
    missing_information: 'nothing material missing',
    rationale_status: 'ok',
  }));
}

describe('Phase 2 — eval gate', () => {
  test('eval passes with a correctly assembled output', async () => {
    const output = await buildValidOutput();
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, true, `eval failed: ${result.errors.join('; ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('eval fails when PAP-07 tangential_flag is false', async () => {
    const output = await buildValidOutput();
    const pap07 = output.find(p => p.paper_id === 'PAP-07')!;
    pap07.tangential_flag = false;
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('PAP-07') && e.includes('tangential_flag')));
  });

  test('eval fails when PAP-07 rationale lacks tangential framing', async () => {
    const output = await buildValidOutput();
    const pap07 = output.find(p => p.paper_id === 'PAP-07')!;
    pap07.relevance_rationale = 'Great match for all components.';
    pap07.position_rationale  = 'High relevance across the board.';
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('PAP-07') && e.includes('tangential framing')));
  });

  test('eval fails when a rank is wrong', async () => {
    const output = await buildValidOutput();
    output[0].rank = 99;
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('rank')));
  });

  test('eval fails when recommended_action is wrong', async () => {
    const output = await buildValidOutput();
    const paper = output.find(p => p.recommended_action === 'Read now')!;
    paper.recommended_action = 'Skip';
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('action')));
  });

  test('eval fails when components_cleared_count is wrong', async () => {
    const output = await buildValidOutput();
    output[0].components_cleared_count = 999;
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('cleared_count')));
  });

  test('eval aggregates multiple errors without short-circuiting', async () => {
    const output = await buildValidOutput();
    const pap07 = output.find(p => p.paper_id === 'PAP-07')!;
    pap07.tangential_flag = false;
    pap07.relevance_rationale = 'Perfect match.';
    pap07.position_rationale  = 'High relevance.';
    output[0].recommended_action = 'Skip';
    const result = await evaluate(output, silentLogger() as ReturnType<typeof createLogger>);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.length >= 2, `expected ≥2 errors, got: ${result.errors.join(' | ')}`);
  });
});
