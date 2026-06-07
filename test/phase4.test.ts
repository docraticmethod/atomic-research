import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCouncilResult } from '../src/subagent.js';
import { createLogger } from '../src/logger.js';
import type { Paper } from '../src/schemas.js';

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  } as ReturnType<typeof createLogger>;
}

const logger = silentLogger();

const dummyPaper: Paper = {
  paper_id: 'W1000101',
  openalex_id: 'W1000101',
  arxiv_id: '2602.00101',
  doi: '10.1234/test',
  title: 'Test Paper Title',
  abstract: 'Test abstract.',
  authors: [{ name: 'Test Author', openalex_id: 'A1' }],
  publication_date: '2026-01-15',
  year: 2026,
  arxiv_categories: ['cs.LG'],
  topics: [{ id: 'T1', display_name: 'Topic', score: 0.9 }],
  referenced_works: [],
  citation_count: 0,
  is_open_access: true,
};

describe('Phase 4 — degraded-state hardening (v3)', () => {
  describe('parseCouncilResult', () => {
    test('null raw → decision_status: unavailable, conservative position, relevance_decision: false', () => {
      const result = parseCouncilResult(null, 'PAP-R1-01', dummyPaper, 'FI-R1-01', 'RES-001', logger);
      assert.strictEqual(result.decision_status, 'unavailable');
      assert.strictEqual(result.relevance_decision, false);
      assert.strictEqual(result.relevance_score, 0);
      assert.strictEqual(result.council_confidence, 0);
      assert.ok(result.position >= 1, 'conservative position should be >= 1');
      assert.ok(result.title === dummyPaper.title, 'title preserved even on failure');
    });

    test('invalid JSON → decision_status: malformed, conservative position', () => {
      const result = parseCouncilResult('{ not valid json }', 'PAP-R1-01', dummyPaper, 'FI-R1-01', 'RES-001', logger);
      assert.strictEqual(result.decision_status, 'malformed');
      assert.strictEqual(result.relevance_decision, false);
      assert.ok(result.position >= 1, 'conservative position should be >= 1');
    });

    test('valid JSON → decision_status: ok, fields populated', () => {
      const raw = JSON.stringify({
        relevance_decision: true,
        relevance_score: 0.87,
        council_confidence: 82,
        relevance_reason: 'Strong match on sparse autoencoder component.',
        matched_components: [{
          component: 'Sparse autoencoder feature steering',
          source_paper_ids: ['PAP-R1-01', 'PAP-R1-04'],
          match_explanation: 'The paper advances SAE steering methodology.',
        }],
        matched_subfields: ['Mechanistic interpretability'],
        council_deliberation: {
          voices: [
            { role: 'advocate', argument: 'Directly relevant.', leaning: 'for' },
          ],
          substantive_vs_superficial: 'Substantive: the paper contributes the SAE steering methodology itself.',
          subfield_weighing: 'Subfield match reinforced the component-driven accept.',
          resolution: 'Accept.',
        },
      });
      const result = parseCouncilResult(raw, 'PAP-R1-01', dummyPaper, 'FI-R1-01', 'RES-001', logger);
      assert.strictEqual(result.decision_status, 'ok');
      assert.strictEqual(result.relevance_decision, true);
      assert.strictEqual(result.relevance_score, 0.87);
      assert.strictEqual(result.council_confidence, 82);
      assert.strictEqual(result.relevance_reason, 'Strong match on sparse autoencoder component.');
      assert.strictEqual(result.matched_components.length, 1);
      assert.strictEqual(result.matched_subfields[0], 'Mechanistic interpretability');
      assert.ok(result.council_deliberation.substantive_vs_superficial.length > 0);
    });

    test('valid JSON for rejected paper → decision_status: ok, relevance_decision: false', () => {
      const raw = JSON.stringify({
        relevance_decision: false,
        relevance_score: 0.05,
        council_confidence: 95,
        relevance_reason: 'Off-topic — GPU scheduling has no connection to mechanistic interpretability.',
        matched_components: [],
        matched_subfields: [],
        council_deliberation: {
          voices: [
            { role: 'skeptic', argument: 'No connection whatsoever.', leaning: 'against' },
          ],
          substantive_vs_superficial: 'No overlap of any kind between GPU scheduling and mechanistic interpretability.',
          subfield_weighing: 'No subfield match; the paper is outside all selected subfields.',
          resolution: 'Reject.',
        },
      });
      const result = parseCouncilResult(raw, 'PAP-R1-10', dummyPaper, 'FI-R1-10', 'RES-001', logger);
      assert.strictEqual(result.decision_status, 'ok');
      assert.strictEqual(result.relevance_decision, false);
      assert.strictEqual(result.relevance_score, 0.05);
      assert.strictEqual(result.council_confidence, 95);
      assert.strictEqual(result.matched_components.length, 0);
    });

    test('valid JSON with markdown fence → stripped and parsed correctly', () => {
      const raw = '```json\n' + JSON.stringify({
        relevance_decision: true,
        relevance_score: 0.7,
        council_confidence: 75,
        relevance_reason: 'Relevant.',
        matched_components: [{
          component: 'Circuit analysis',
          source_paper_ids: ['PAP-R1-02'],
          match_explanation: 'Matches circuit analysis component.',
        }],
        matched_subfields: ['Mechanistic interpretability'],
        council_deliberation: {
          voices: [{ role: 'advocate', argument: 'Yes.', leaning: 'for' }],
          substantive_vs_superficial: 'Substantive match — the paper contributes to circuit analysis.',
          subfield_weighing: 'Subfield match was secondary; the component match drove the accept.',
          resolution: 'Accept.',
        },
      }) + '\n```';
      const result = parseCouncilResult(raw, 'PAP-R1-02', dummyPaper, 'FI-R1-02', 'RES-001', logger);
      assert.strictEqual(result.decision_status, 'ok');
      assert.strictEqual(result.relevance_decision, true);
    });

    test('field id and researcher_id are preserved from arguments, not parsed JSON', () => {
      const raw = JSON.stringify({
        relevance_decision: true,
        relevance_score: 0.8,
        council_confidence: 80,
        relevance_reason: 'Relevant.',
        matched_components: [{ component: 'X', source_paper_ids: ['P'], match_explanation: 'Y' }],
        matched_subfields: ['S'],
        council_deliberation: { voices: [{ role: 'advocate', argument: 'Yes.', leaning: 'for' }], substantive_vs_superficial: 'Substantive.', subfield_weighing: 'Weighed.', resolution: 'Accept.' },
      });
      const result = parseCouncilResult(raw, 'PAP-R1-03', dummyPaper, 'FI-R1-CUSTOM', 'RES-001', logger);
      assert.strictEqual(result.feed_item_id, 'FI-R1-CUSTOM');
      assert.strictEqual(result.researcher_id, 'RES-001');
      assert.strictEqual(result.paper_id, 'PAP-R1-03');
      assert.strictEqual(result.title, dummyPaper.title);
      assert.strictEqual(result.publication_date, dummyPaper.publication_date);
    });

    test('unavailable item has title and date preserved from paper', () => {
      const result = parseCouncilResult(null, 'PAP-R1-01', dummyPaper, 'FI-R1-01', 'RES-001', logger);
      assert.strictEqual(result.title, dummyPaper.title);
      assert.strictEqual(result.publication_date, dummyPaper.publication_date);
    });
  });
});
