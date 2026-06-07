import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from '../src/join.js';
import { sortFeed, assertRecencyWindow } from '../src/sequencer.js';
import type { FeedItem } from '../src/schemas.js';

describe('Phase 1 — join and sequencer', () => {
  describe('join — cross-file id resolution', () => {
    async function loadFixtures() {
      const [researchersRaw, papersRaw, componentsRaw, feedItemsRaw, subfieldsRaw] = await Promise.all([
        readFile('data/researchers.json', 'utf-8'),
        readFile('data/papers.json', 'utf-8'),
        readFile('data/research_components.json', 'utf-8'),
        readFile('data/feed_items.json', 'utf-8'),
        readFile('data/research_subfield_preferences.json', 'utf-8'),
      ]);
      return {
        researchers: JSON.parse(researchersRaw),
        papers: JSON.parse(papersRaw),
        components: JSON.parse(componentsRaw),
        feedItems: JSON.parse(feedItemsRaw),
        subfields: JSON.parse(subfieldsRaw),
      };
    }

    test('join resolves without orphans — all fixtures', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      assert.doesNotThrow(() => join(researchers, papers, components, subfields, feedItems));
    });

    test('join returns 3 JoinedResearcher entries', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const joined = join(researchers, papers, components, subfields, feedItems);
      assert.strictEqual(joined.length, 3);
    });

    test('each joined researcher has exactly 10 papers and 10 feed items', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const joined = join(researchers, papers, components, subfields, feedItems);
      for (const jr of joined) {
        assert.strictEqual(jr.papers.length, 10, `${jr.researcher.researcher_id} has ${jr.papers.length} papers`);
        assert.strictEqual(jr.feedItems.length, 10, `${jr.researcher.researcher_id} has ${jr.feedItems.length} feed items`);
      }
    });

    test('no paper_id appears in more than one researcher set', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const joined = join(researchers, papers, components, subfields, feedItems);
      const seen = new Set<string>();
      for (const jr of joined) {
        for (const p of jr.papers) {
          assert.ok(!seen.has(p.paper_id), `paper_id "${p.paper_id}" appears in multiple researcher sets`);
          seen.add(p.paper_id);
        }
      }
    });

    test('each joined researcher has at least one component with source_paper_ids', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const joined = join(researchers, papers, components, subfields, feedItems);
      for (const jr of joined) {
        assert.ok(jr.components.length > 0, `${jr.researcher.researcher_id} has no components`);
        for (const c of jr.components) {
          assert.ok(c.source_paper_ids.length > 0, `component ${c.component_id} has no source_paper_ids`);
        }
      }
    });

    test('join throws on orphan researcher_id in feed_items', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const badFeedItems = [...feedItems, {
        id: 'FI-BAD-01',
        researcher_id: 'RES-999',
        paper_id: papers[0].paper_id,
        relevance_score: 0.5,
        relevance_decision: true,
        council_confidence: 70,
        relevance_reason: 'test',
        council_deliberation: { voices: [], substantive_vs_superficial: 'test', resolution: 'test' },
        council_version: 'v3',
        status: 'pending',
        surfaced_at: '2026-06-06T00:00:00Z',
      }];
      assert.throws(() => join(researchers, papers, components, subfields, badFeedItems), /orphan/i);
    });

    test('join throws on orphan paper_id in feed_items', async () => {
      const { researchers, papers, components, feedItems, subfields } = await loadFixtures();
      const badFeedItems = [...feedItems, {
        id: 'FI-BAD-02',
        researcher_id: researchers[0].researcher_id,
        paper_id: 'PAP-DOES-NOT-EXIST',
        relevance_score: 0.5,
        relevance_decision: true,
        council_confidence: 70,
        relevance_reason: 'test',
        council_deliberation: { voices: [], substantive_vs_superficial: 'test', resolution: 'test' },
        council_version: 'v3',
        status: 'pending',
        surfaced_at: '2026-06-06T00:00:00Z',
      }];
      assert.throws(() => join(researchers, papers, components, subfields, badFeedItems), /orphan/i);
    });
  });

  describe('sequencer — sortFeed', () => {
    function makeItem(overrides: Partial<FeedItem>): FeedItem {
      return {
        feed_item_id: 'FI-TEST',
        researcher_id: 'RES-001',
        paper_id: 'PAP-TEST',
        position: 0,
        title: 'Test',
        publication_date: '2026-01-01',
        relevance_decision: true,
        relevance_score: 0.5,
        council_confidence: 70,
        relevance_reason: 'test',
        matched_components: [],
        matched_subfields: [],
        council_deliberation: { voices: [], substantive_vs_superficial: 'test', resolution: 'test' },
        decision_status: 'ok',
        ...overrides,
      };
    }

    test('sortFeed assigns positions 1–N in order', () => {
      const items = [
        makeItem({ paper_id: 'A', relevance_score: 0.5 }),
        makeItem({ paper_id: 'B', relevance_score: 0.9 }),
        makeItem({ paper_id: 'C', relevance_score: 0.3 }),
      ];
      const sorted = sortFeed(items);
      assert.strictEqual(sorted[0].paper_id, 'B');
      assert.strictEqual(sorted[1].paper_id, 'A');
      assert.strictEqual(sorted[2].paper_id, 'C');
      assert.deepStrictEqual(sorted.map(i => i.position), [1, 2, 3]);
    });

    test('sortFeed tie-break 1: higher council_confidence wins', () => {
      const items = [
        makeItem({ paper_id: 'LOW', relevance_score: 0.8, council_confidence: 60 }),
        makeItem({ paper_id: 'HIGH', relevance_score: 0.8, council_confidence: 90 }),
      ];
      const sorted = sortFeed(items);
      assert.strictEqual(sorted[0].paper_id, 'HIGH');
    });

    test('sortFeed tie-break 2: more recent publication_date wins', () => {
      const items = [
        makeItem({ paper_id: 'OLD', relevance_score: 0.8, council_confidence: 70, publication_date: '2025-12-10' }),
        makeItem({ paper_id: 'NEW', relevance_score: 0.8, council_confidence: 70, publication_date: '2026-04-01' }),
      ];
      const sorted = sortFeed(items);
      assert.strictEqual(sorted[0].paper_id, 'NEW');
    });

    test('sortFeed — no-silent-drop: rejected items retained at their score position', () => {
      const items = [
        makeItem({ paper_id: 'ACC', relevance_score: 0.6, relevance_decision: true }),
        makeItem({ paper_id: 'REJ', relevance_score: 0.8, relevance_decision: false }),
      ];
      const sorted = sortFeed(items);
      assert.strictEqual(sorted.length, 2);
      assert.strictEqual(sorted[0].paper_id, 'REJ', 'rejected item with higher score should be position 1');
      assert.strictEqual(sorted[0].position, 1);
    });

    test('sortFeed is stable — same input produces same output', () => {
      const items = [
        makeItem({ paper_id: 'A', relevance_score: 0.8 }),
        makeItem({ paper_id: 'B', relevance_score: 0.6 }),
        makeItem({ paper_id: 'C', relevance_score: 0.4 }),
      ];
      const a = sortFeed(items).map(i => i.paper_id);
      const b = sortFeed(items).map(i => i.paper_id);
      assert.deepStrictEqual(a, b);
    });
  });

  describe('recency window assertion', () => {
    test('assertRecencyWindow passes for in-window papers', () => {
      assert.doesNotThrow(() => assertRecencyWindow([
        { paper_id: 'A', publication_date: '2026-01-01' },
        { paper_id: 'B', publication_date: '2025-12-06' },
        { paper_id: 'C', publication_date: '2026-06-06' },
      ]));
    });

    test('assertRecencyWindow throws for out-of-window paper', () => {
      assert.throws(() => assertRecencyWindow([
        { paper_id: 'BAD', publication_date: '2025-12-05' },
      ]), /Recency window violation/);
    });
  });
});
