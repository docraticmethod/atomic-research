import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sequence, THRESHOLD } from '../src/sequencer.js';
import type { CandidatePaper } from '../src/schemas.js';

describe('Phase 1 — deterministic sequencer', () => {
  describe('fixture ranking', () => {
    let ranked: ReturnType<typeof sequence>;

    test('loads and sequences all 10 fixture papers', async () => {
      const raw = await readFile('data/candidate_papers.json', 'utf-8');
      const papers: CandidatePaper[] = JSON.parse(raw);
      ranked = sequence(papers);
      assert.strictEqual(ranked.length, 10);
    });

    test('ranks are 1–10 with no gaps or duplicates', () => {
      const ranks = ranked.map(p => p.rank).sort((a, b) => a - b);
      assert.deepStrictEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('rank order matches expected fixture ordering by max_component_similarity', () => {
      const expected = [
        { paper_id: 'PAP-03', rank: 1,  max: 0.87 },
        { paper_id: 'PAP-06', rank: 2,  max: 0.84 },
        { paper_id: 'PAP-01', rank: 3,  max: 0.82 },
        { paper_id: 'PAP-09', rank: 4,  max: 0.74 },
        { paper_id: 'PAP-02', rank: 5,  max: 0.71 },
        { paper_id: 'PAP-05', rank: 6,  max: 0.68 },
        { paper_id: 'PAP-07', rank: 7,  max: 0.63 },
        { paper_id: 'PAP-10', rank: 8,  max: 0.52 },
        { paper_id: 'PAP-04', rank: 9,  max: 0.45 },
        { paper_id: 'PAP-08', rank: 10, max: 0.38 },
      ];
      for (const { paper_id, rank, max } of expected) {
        const paper = ranked.find(p => p.paper_id === paper_id);
        assert.ok(paper, `${paper_id} missing from ranked output`);
        assert.strictEqual(paper.rank, rank, `${paper_id} wrong rank`);
        assert.strictEqual(paper.max_component_similarity, max, `${paper_id} wrong max_sim`);
      }
    });

    test('recommended_action mapping is correct for every paper', () => {
      const expected: Record<string, string> = {
        'PAP-03': 'Read now', 'PAP-06': 'Read now', 'PAP-01': 'Read now',
        'PAP-09': 'Save',     'PAP-02': 'Save',     'PAP-05': 'Save',     'PAP-07': 'Save',
        'PAP-10': 'Skip',     'PAP-04': 'Skip',     'PAP-08': 'Skip',
      };
      for (const paper of ranked) {
        assert.strictEqual(
          paper.recommended_action, expected[paper.paper_id],
          `${paper.paper_id} wrong action`,
        );
      }
    });

    test('components_cleared_count equals count of components >= THRESHOLD', () => {
      for (const paper of ranked) {
        const expected = paper.components.filter(c => c.component_similarity >= THRESHOLD).length;
        assert.strictEqual(
          paper.components_cleared_count, expected,
          `${paper.paper_id} wrong cleared count`,
        );
      }
    });

    test('cleared flag on each component matches THRESHOLD comparison', () => {
      for (const paper of ranked) {
        for (const c of paper.components) {
          const expectedCleared = c.component_similarity >= THRESHOLD;
          assert.strictEqual(
            c.cleared, expectedCleared,
            `${paper.paper_id} component "${c.component}" cleared flag wrong`,
          );
        }
      }
    });

    test('output is stable — sequencing the same input twice gives identical order', async () => {
      const raw = await readFile('data/candidate_papers.json', 'utf-8');
      const papers: CandidatePaper[] = JSON.parse(raw);
      const a = sequence(papers);
      const b = sequence(papers);
      assert.deepStrictEqual(
        a.map(p => p.paper_id),
        b.map(p => p.paper_id),
      );
    });
  });

  describe('tie-break logic', () => {
    const base: CandidatePaper = {
      paper_id: 'TIE-BASE',
      title: '',
      abstract: '',
      date: '2026-01-01',
      components: [{ component: 'x', component_similarity: 0.70, evidence: '' }],
    };

    test('tie-break 1: more cleared components wins', () => {
      const papers: CandidatePaper[] = [
        {
          ...base,
          paper_id: 'TIE-A',
          date: '2026-01-01',
          components: [
            { component: 'a', component_similarity: 0.70, evidence: '' },
            { component: 'b', component_similarity: 0.50, evidence: '' },
          ],
        },
        {
          ...base,
          paper_id: 'TIE-B',
          date: '2026-01-01',
          components: [
            { component: 'a', component_similarity: 0.70, evidence: '' },
            { component: 'b', component_similarity: 0.65, evidence: '' },
          ],
        },
      ];
      const result = sequence(papers);
      assert.strictEqual(result[0].paper_id, 'TIE-B', 'more cleared components should rank first');
      assert.strictEqual(result[1].paper_id, 'TIE-A');
    });

    test('tie-break 2: more recent date wins when cleared count is equal', () => {
      const papers: CandidatePaper[] = [
        {
          ...base,
          paper_id: 'TIE-OLD',
          date: '2025-12-15',
          components: [{ component: 'a', component_similarity: 0.70, evidence: '' }],
        },
        {
          ...base,
          paper_id: 'TIE-NEW',
          date: '2026-03-01',
          components: [{ component: 'a', component_similarity: 0.70, evidence: '' }],
        },
      ];
      const result = sequence(papers);
      assert.strictEqual(result[0].paper_id, 'TIE-NEW', 'more recent date should rank first');
      assert.strictEqual(result[1].paper_id, 'TIE-OLD');
    });
  });

  describe('action boundary values', () => {
    function makePaper(id: string, sim: number): CandidatePaper {
      return {
        paper_id: id,
        title: id,
        abstract: '',
        date: '2026-01-01',
        components: [{ component: 'x', component_similarity: sim, evidence: '' }],
      };
    }

    test('0.80 → Read now', () => {
      const [p] = sequence([makePaper('P', 0.80)]);
      assert.strictEqual(p.recommended_action, 'Read now');
    });

    test('0.60 → Save', () => {
      const [p] = sequence([makePaper('P', 0.60)]);
      assert.strictEqual(p.recommended_action, 'Save');
    });

    test('0.599 → Skip', () => {
      const [p] = sequence([makePaper('P', 0.599)]);
      assert.strictEqual(p.recommended_action, 'Skip');
    });

    test('0.799 → Save (not Read now)', () => {
      const [p] = sequence([makePaper('P', 0.799)]);
      assert.strictEqual(p.recommended_action, 'Save');
    });
  });
});
