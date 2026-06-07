import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { joinResearcher, assertNoIdSpaceConflict } from '../src/join.js';
import { sortFeed, assertRecencyWindow } from '../src/sequencer.js';
import type { FeedItem, GroundedProfile, Publication, Researcher, Paper, FeedItemSeed } from '../src/schemas.js';

describe('Phase 1 — join and sequencer', () => {
  describe('join — cross-file id resolution (per researcher, grounded)', () => {
    async function loadFixtures() {
      const [researchersRaw, papersRaw, publicationsRaw, feedItemsRaw] = await Promise.all([
        readFile('data/researchers.json', 'utf-8'),
        readFile('data/papers.json', 'utf-8'),
        readFile('data/publications.json', 'utf-8'),
        readFile('data/feed_items.json', 'utf-8'),
      ]);
      return {
        researchers: JSON.parse(researchersRaw) as Researcher[],
        papers: JSON.parse(papersRaw) as Paper[],
        publications: JSON.parse(publicationsRaw) as Publication[],
        feedItems: JSON.parse(feedItemsRaw) as FeedItemSeed[],
      };
    }

    // Build a minimal valid grounded profile from a researcher's real publications.
    function makeGroundedProfile(researcherId: string, pubs: Publication[]): GroundedProfile {
      const ids = pubs.map(p => p.publication_id);
      return {
        researcher_id: researcherId,
        grounding_status: 'ok',
        research_components: [
          { name: 'Component A', description: 'desc', source_paper_ids: ids.slice(0, 2), explanation: 'why', aptness_flags: [] },
        ],
        research_subfield_preferences: [
          { name: 'Subfield A', description: 'desc', source_paper_ids: ids.slice(0, 1), explanation: 'why', aptness_flags: [] },
        ],
      };
    }

    function forResearcher(rid: string, f: Awaited<ReturnType<typeof loadFixtures>>) {
      const researcher = f.researchers.find(r => r.researcher_id === rid)!;
      const pubs = f.publications.filter(p => p.researcher_id === rid);
      const publicationIds = new Set(pubs.map(p => p.publication_id));
      const feedItems = f.feedItems.filter(fi => fi.researcher_id === rid);
      const paperIds = new Set(feedItems.map(fi => fi.paper_id));
      const papers = f.papers.filter(p => paperIds.has(p.paper_id));
      const profile = makeGroundedProfile(rid, pubs);
      return { researcher, papers, profile, feedItems, publicationIds };
    }

    test('assertNoIdSpaceConflict passes — publications and papers are disjoint', async () => {
      const { papers, publications } = await loadFixtures();
      assert.doesNotThrow(() => assertNoIdSpaceConflict(papers, publications));
    });

    test('joinResearcher resolves without orphans for each researcher', async () => {
      const f = await loadFixtures();
      for (const r of f.researchers) {
        const { researcher, papers, profile, feedItems, publicationIds } = forResearcher(r.researcher_id, f);
        assert.doesNotThrow(() => joinResearcher(researcher, papers, profile, feedItems, publicationIds));
      }
    });

    test('each joined researcher has exactly 10 papers and 10 feed items', async () => {
      const f = await loadFixtures();
      for (const r of f.researchers) {
        const { researcher, papers, profile, feedItems, publicationIds } = forResearcher(r.researcher_id, f);
        const jr = joinResearcher(researcher, papers, profile, feedItems, publicationIds);
        assert.strictEqual(jr.papers.length, 10, `${r.researcher_id} has ${jr.papers.length} papers`);
        assert.strictEqual(jr.feedItems.length, 10, `${r.researcher_id} has ${jr.feedItems.length} feed items`);
      }
    });

    test('joinResearcher throws on a feed item with a foreign researcher_id', async () => {
      const f = await loadFixtures();
      const { researcher, papers, profile, feedItems, publicationIds } = forResearcher('RES-001', f);
      const bad = [...feedItems, { ...feedItems[0], id: 'FI-BAD', researcher_id: 'RES-999' }];
      assert.throws(() => joinResearcher(researcher, papers, profile, bad, publicationIds), /contamination|researcher_id/i);
    });

    test('joinResearcher throws on orphan paper_id in feed_items', async () => {
      const f = await loadFixtures();
      const { researcher, papers, profile, feedItems, publicationIds } = forResearcher('RES-001', f);
      const bad = [...feedItems, { ...feedItems[0], id: 'FI-BAD2', paper_id: 'PAP-DOES-NOT-EXIST' }];
      assert.throws(() => joinResearcher(researcher, papers, profile, bad, publicationIds), /orphan/i);
    });

    test('joinResearcher throws when a component source_paper_id is not in publications', async () => {
      const f = await loadFixtures();
      const { researcher, papers, profile, feedItems, publicationIds } = forResearcher('RES-001', f);
      const badProfile: GroundedProfile = {
        ...profile,
        research_components: [
          { name: 'Bad', description: 'd', source_paper_ids: ['PUB-DOES-NOT-EXIST'], explanation: 'e', aptness_flags: [] },
        ],
      };
      assert.throws(() => joinResearcher(researcher, papers, badProfile, feedItems, publicationIds), /not in publications/i);
    });

    test('assertNoIdSpaceConflict throws on a colliding id', () => {
      const papers = [{ paper_id: 'X-01' }] as Paper[];
      const publications = [{ publication_id: 'X-01' }] as Publication[];
      assert.throws(() => assertNoIdSpaceConflict(papers, publications), /id-space conflict/i);
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
        council_deliberation: { voices: [], substantive_vs_superficial: 'test', subfield_weighing: 'test', resolution: 'test' },
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
