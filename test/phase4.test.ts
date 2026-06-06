import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRationale } from '../src/parse-rationale.js';
import { sequence } from '../src/sequencer.js';
import { evaluate } from '../src/eval.js';
import { createLogger } from '../src/logger.js';
import type { CandidatePaper, OutputPaper } from '../src/schemas.js';

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  };
}

const logger = silentLogger() as ReturnType<typeof createLogger>;

describe('Phase 4 — degraded-state hardening', () => {
  describe('parseRationale', () => {
    test('null raw → status: unavailable, empty fields', () => {
      const result = parseRationale(null, 'PAP-01', logger);
      assert.strictEqual(result.status, 'unavailable');
      assert.strictEqual(result.relevanceRationale, '');
      assert.strictEqual(result.positionRationale, '');
      assert.deepStrictEqual(result.matchExplanations, {});
      assert.strictEqual(result.tangentialFlag, false);
    });

    test('invalid JSON → status: malformed, empty fields', () => {
      const result = parseRationale('{ not valid json }', 'PAP-01', logger);
      assert.strictEqual(result.status, 'malformed');
      assert.strictEqual(result.relevanceRationale, '');
      assert.strictEqual(result.tangentialFlag, false);
    });

    test('valid JSON → status: ok, fields populated', () => {
      const raw = JSON.stringify({
        match_explanations: { 'information retrieval': 'Strong alignment.' },
        relevance_rationale: 'Highly relevant paper.',
        position_rationale: 'Ranked first due to highest similarity.',
      });
      const result = parseRationale(raw, 'PAP-03', logger);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.relevanceRationale, 'Highly relevant paper.');
      assert.strictEqual(result.positionRationale, 'Ranked first due to highest similarity.');
      assert.strictEqual(result.matchExplanations['information retrieval'], 'Strong alignment.');
    });

    test('PAP-07 with tangential terms → tangential_flag: true', () => {
      const raw = JSON.stringify({
        match_explanations: {},
        relevance_rationale: 'This is a tangential match; the paper is primarily about blockchain.',
        position_rationale: 'Ranked here because the match is loose.',
      });
      const result = parseRationale(raw, 'PAP-07', logger);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.tangentialFlag, true);
    });

    test('PAP-07 without tangential terms → tangential_flag: false', () => {
      const raw = JSON.stringify({
        match_explanations: {},
        relevance_rationale: 'Good match on information retrieval.',
        position_rationale: 'Correct rank.',
      });
      const result = parseRationale(raw, 'PAP-07', logger);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.tangentialFlag, false);
    });

    test('non-PAP-07 with tangential terms → tangential_flag: false', () => {
      const raw = JSON.stringify({
        match_explanations: {},
        relevance_rationale: 'This is a tangential match.',
        position_rationale: 'Loose connection.',
      });
      const result = parseRationale(raw, 'PAP-01', logger);
      assert.strictEqual(result.tangentialFlag, false);
    });
  });

  describe('output contract under simulated LLM failure', () => {
    async function buildOutputWithFailures(failingIds: string[]): Promise<OutputPaper[]> {
      const raw = await readFile('data/candidate_papers.json', 'utf-8');
      const papers: CandidatePaper[] = JSON.parse(raw);
      const sequenced = sequence(papers);

      return sequenced.map(p => {
        const failed = failingIds.includes(p.paper_id);
        const rationale = parseRationale(failed ? null : JSON.stringify({
          match_explanations: Object.fromEntries(p.components.map(c => [c.component, 'explanation'])),
          relevance_rationale: p.paper_id === 'PAP-07'
            ? 'This is a tangential match — the paper is superficially related.'
            : p.paper_id === 'PAP-02'
            ? 'This is a breadth match — cross-component relevance across citation network analysis and scientific document embeddings.'
            : 'Relevant paper.',
          position_rationale: p.paper_id === 'PAP-07'
            ? 'Ranked here; loose connection.'
            : 'Correct rank.',
          missing_information: 'nothing material missing',
        }), p.paper_id, logger);

        return {
          paper_id: p.paper_id,
          rank: p.rank,
          title: p.title,
          date: p.date,
          max_component_similarity: p.max_component_similarity,
          recommended_action: p.recommended_action,
          components: p.components.map(c => ({
            ...c,
            match_explanation: rationale.matchExplanations[c.component] ?? '',
          })),
          components_cleared_count: p.components_cleared_count,
          relevance_rationale: rationale.relevanceRationale,
          position_rationale: rationale.positionRationale,
          tangential_flag: rationale.tangentialFlag,
          missing_information: rationale.missingInformation,
          rationale_status: rationale.status,
        };
      });
    }

    test('failed rationale for non-PAP-07 paper → rationale_status unavailable, deterministic fields intact', async () => {
      const output = await buildOutputWithFailures(['PAP-01']);
      const pap01 = output.find(p => p.paper_id === 'PAP-01')!;
      assert.strictEqual(pap01.rationale_status, 'unavailable');
      assert.strictEqual(pap01.rank, 3, 'rank must be unchanged');
      assert.strictEqual(pap01.recommended_action, 'Read now', 'action must be unchanged');
      assert.strictEqual(pap01.max_component_similarity, 0.82, 'max_sim must be unchanged');
    });

    test('failed rationale → all 10 papers still present at correct ranks', async () => {
      const output = await buildOutputWithFailures(['PAP-03', 'PAP-08']);
      assert.strictEqual(output.length, 10);
      const ranks = output.map(p => p.rank).sort((a, b) => a - b);
      assert.deepStrictEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('eval still passes when non-PAP-07 papers have unavailable rationale', async () => {
      const output = await buildOutputWithFailures(['PAP-01', 'PAP-06']);
      const result = await evaluate(output, logger);
      assert.strictEqual(result.passed, true, `eval failed: ${result.errors.join('; ')}`);
    });
  });
});
