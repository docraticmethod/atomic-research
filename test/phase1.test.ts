import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { joinResearcher, assertNoIdSpaceConflict } from '../src/join.js';
import { sortFeed, assertRecencyWindow } from '../src/sequencer.js';
import { recencyWindow } from '../src/window.js';
import type { FeedItem, GroundedProfile, Publication, Researcher, Paper } from '../src/schemas.js';

function researcher(): Researcher {
  return {
    researcher_id: 'A1', name: 'Jane', full_name: 'Jane', description: 'x',
    research_interests: ['ai'], topics: [], works_count: 1, cited_by_count: 1, h_index: 1,
  };
}

function publication(id: string): Publication {
  return {
    publication_id: id, researcher_id: 'A1', openalex_id: id, title: 't', abstract: 'a',
    authors: [{ name: 'Jane', openalex_id: 'A1' }], year: 2024, venue: '',
    arxiv_categories: [], topics: [], citation_count: 0,
  };
}

function paper(id: string, date = '2026-05-01'): Paper {
  return {
    paper_id: id, openalex_id: id, arxiv_id: '', doi: '', title: 't', abstract: 'a',
    authors: [{ name: 'X', openalex_id: 'A2' }], publication_date: date, year: 2026,
    arxiv_categories: [], topics: [], referenced_works: [], citation_count: 0, is_open_access: true,
  };
}

function grounded(sourceIds: string[]): GroundedProfile {
  return {
    researcher_id: 'A1', grounding_status: 'ok',
    research_components: [{ name: 'C', description: 'd', source_paper_ids: sourceIds, explanation: 'e', aptness_flags: [] }],
    research_subfield_preferences: [{ name: 'S', description: 'd', source_paper_ids: sourceIds, explanation: 'e', aptness_flags: [] }],
  };
}

describe('Phase 1 — join (boundary output, no feed seeds)', () => {
  test('grounded source_paper_ids resolve into publications — no orphans', () => {
    const pubs = [publication('W10'), publication('W11')];
    const pubIds = new Set(pubs.map(p => p.publication_id));
    const joined = joinResearcher(researcher(), [paper('W900')], grounded(['W10']), pubIds);
    assert.strictEqual(joined.papers.length, 1);
  });

  test('throws when a source_paper_id is not in the publications id-space', () => {
    const pubIds = new Set(['W10']);
    assert.throws(() => joinResearcher(researcher(), [paper('W900')], grounded(['W_ORPHAN']), pubIds), /not in publications/);
  });

  test('throws when a grounded source_paper_id resolves into the candidate papers id-space', () => {
    const pubIds = new Set(['W10']);
    // source id W900 is a candidate paper, not a publication
    assert.throws(() => joinResearcher(researcher(), [paper('W900')], grounded(['W900']), pubIds), /must resolve into publications/);
  });

  test('assertNoIdSpaceConflict throws when papers and publications share an id', () => {
    assert.throws(() => assertNoIdSpaceConflict([paper('W5')], [publication('W5')]), /id-space conflict/);
  });
});

describe('Phase 1 — sequencer (pure ordering)', () => {
  function fi(overrides: Partial<FeedItem>): FeedItem {
    return {
      feed_item_id: 'f', researcher_id: 'A1', paper_id: 'p', position: 0, title: 't',
      publication_date: '2026-05-01', relevance_decision: true, relevance_score: 0.5,
      council_confidence: 50, relevance_reason: 'r', matched_components: [], matched_subfields: [],
      council_deliberation: { voices: [], substantive_vs_superficial: '', subfield_weighing: '', resolution: '' },
      decision_status: 'ok', ...overrides,
    };
  }

  test('sorts by relevance_score desc, then confidence desc, then recency; assigns 1..n', () => {
    const items = [
      fi({ paper_id: 'low', relevance_score: 0.2 }),
      fi({ paper_id: 'hi', relevance_score: 0.9 }),
      fi({ paper_id: 'midA', relevance_score: 0.5, council_confidence: 60, publication_date: '2026-01-01' }),
      fi({ paper_id: 'midB', relevance_score: 0.5, council_confidence: 60, publication_date: '2026-05-01' }),
    ];
    const sorted = sortFeed(items);
    assert.deepStrictEqual(sorted.map(s => s.paper_id), ['hi', 'midB', 'midA', 'low']);
    assert.deepStrictEqual(sorted.map(s => s.position), [1, 2, 3, 4]);
  });

  test('reject-decision items are retained at their score position (no silent drop)', () => {
    const sorted = sortFeed([fi({ paper_id: 'rej', relevance_decision: false, relevance_score: 0.1 }), fi({ paper_id: 'acc', relevance_score: 0.8 })]);
    assert.deepStrictEqual(sorted.map(s => s.paper_id), ['acc', 'rej']);
  });
});

describe('Phase 1 — derived recency window', () => {
  test('assertRecencyWindow passes in-window and throws out-of-window', () => {
    const win = recencyWindow(new Date('2026-06-07'));
    assert.doesNotThrow(() => assertRecencyWindow([{ paper_id: 'p', publication_date: '2026-05-01' }], win));
    assert.throws(() => assertRecencyWindow([{ paper_id: 'q', publication_date: '2024-01-01' }], win), /Recency window/);
  });
});
