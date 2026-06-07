import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate } from '../src/eval.js';
import { createLogger } from '../src/logger.js';
import { sortFeed } from '../src/sequencer.js';
import type { ResearcherFeed, FeedItem, Researcher } from '../src/schemas.js';

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  } as ReturnType<typeof createLogger>;
}

function makeFeedItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    feed_item_id: 'FI-TEST',
    researcher_id: 'RES-001',
    paper_id: 'PAP-TEST',
    position: 1,
    title: 'Test Paper',
    publication_date: '2026-01-15',
    relevance_decision: true,
    relevance_score: 0.8,
    council_confidence: 85,
    relevance_reason: 'Strong match on component X.',
    matched_components: [{
      component: 'Test component',
      source_paper_ids: ['PAP-R1-01'],
      match_explanation: 'The paper advances this component substantively.',
    }],
    matched_subfields: ['Mechanistic interpretability'],
    council_deliberation: {
      voices: [
        { role: 'advocate', argument: 'Clearly relevant.', leaning: 'for' },
        { role: 'skeptic', argument: 'Checked — no superficial overlap issue.', leaning: 'for' },
      ],
      substantive_vs_superficial: 'The match is substantive: the paper contributes directly to the component, not just sharing terminology.',
      resolution: 'Unanimous accept.',
    },
    decision_status: 'ok',
    ...overrides,
  };
}

function makeResearcher(id: string): Researcher {
  return {
    researcher_id: id,
    name: `Researcher ${id}`,
    full_name: `Full Name ${id}`,
    description: 'Test researcher.',
    research_interests: ['topic A'],
    topics: [{ id: 'T1', display_name: 'Topic A', score: 0.9 }],
  };
}

function makeValidFeed(researcherId: string, paperIdPrefix: string): ResearcherFeed {
  const items: FeedItem[] = [];
  for (let i = 1; i <= 10; i++) {
    const paperId = `${paperIdPrefix}-${String(i).padStart(2, '0')}`;
    const isReject = i >= 9;
    items.push(makeFeedItem({
      feed_item_id: `FI-${paperIdPrefix}-${i}`,
      researcher_id: researcherId,
      paper_id: paperId,
      relevance_score: isReject ? (i === 10 ? 0.02 : 0.15) : 1 - (i - 1) * 0.09,
      council_confidence: isReject ? (i === 10 ? 97 : 65) : 90 - (i - 1) * 5,
      relevance_decision: !isReject,
      matched_components: isReject ? [] : [{
        component: 'Test component',
        source_paper_ids: ['PAP-SRC-01'],
        match_explanation: 'Substantive match on the core component.',
      }],
      matched_subfields: isReject ? [] : ['Test subfield'],
      council_deliberation: {
        voices: [
          { role: 'advocate', argument: isReject ? 'Not relevant.' : 'Clearly relevant.', leaning: isReject ? 'against' : 'for' },
          { role: 'skeptic', argument: isReject ? 'Confirmed off-topic.' : 'Checked — genuine match.', leaning: isReject ? 'against' : 'for' },
        ],
        substantive_vs_superficial: isReject
          ? 'Superficial: the paper only shares a keyword but does not advance any research component.'
          : 'Substantive: the paper directly extends the component with new methodology.',
        resolution: isReject ? 'Reject — off-topic.' : 'Accept.',
      },
      relevance_reason: isReject ? 'Off-topic — clear dismiss.' : 'Strong component match.',
    }));
  }
  const sorted = sortFeed(items);
  return {
    researcher_id: researcherId,
    researcher_name: `Researcher ${researcherId}`,
    feed: sorted,
    feed_summary: { text: 'Summary of top papers.', summary_status: 'ok' },
  };
}

function makeValidArtifact(): [ResearcherFeed[], Researcher[]] {
  const feeds = [
    makeValidFeed('RES-001', 'PAP-R1'),
    makeValidFeed('RES-002', 'PAP-R2'),
    makeValidFeed('RES-003', 'PAP-R3'),
  ];
  const researchers = ['RES-001', 'RES-002', 'RES-003'].map(makeResearcher);
  return [feeds, researchers];
}

describe('Phase 2 — eval gate (v3)', () => {
  test('eval passes with a correctly assembled output', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, true, `eval failed: ${result.errors.join('; ')}`);
  });

  test('eval fails when fewer than 3 researcher feeds', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const result = await evaluate(feeds.slice(0, 2), researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('3 researcher feeds')));
  });

  test('eval fails when a researcher has fewer than 10 feed items', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed = feeds[0].feed.slice(0, 9);
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('feed items') && e.includes('10')));
  });

  test('eval fails when a paper_id appears in two researcher feeds', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[1].feed[0] = { ...feeds[0].feed[0], researcher_id: 'RES-002', feed_item_id: 'FI-DUP' };
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('cross-researcher reuse')));
  });

  test('eval fails when an accepted item has empty matched_components', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const accepted = feeds[0].feed.find(fi => fi.relevance_decision && fi.decision_status === 'ok')!;
    accepted.matched_components = [];
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('matched_components')));
  });

  test('eval fails when an accepted item has empty matched_subfields', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const accepted = feeds[0].feed.find(fi => fi.relevance_decision && fi.decision_status === 'ok')!;
    accepted.matched_subfields = [];
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('matched_subfields')));
  });

  test('eval fails when feed order does not match relevance_score sort', async () => {
    const [feeds, researchers] = makeValidArtifact();
    // Swap positions 1 and 2
    const tmp = feeds[0].feed[0].position;
    feeds[0].feed[0].position = feeds[0].feed[1].position;
    feeds[0].feed[1].position = tmp;
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('position')));
  });

  test('eval fails when no researcher has any accepted paper', async () => {
    const [feeds, researchers] = makeValidArtifact();
    for (const fi of feeds[0].feed) {
      fi.relevance_decision = false;
      fi.matched_components = [];
      fi.matched_subfields = [];
    }
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('must-surface')));
  });

  test('eval fails when substantive_vs_superficial is missing from a council deliberation', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].council_deliberation.substantive_vs_superficial = '';
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('substantive_vs_superficial')));
  });

  test('eval fails when a paper publication_date is outside the recency window', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].publication_date = '2025-01-01';
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('recency window')));
  });

  test('eval aggregates multiple errors without short-circuiting', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].council_deliberation.substantive_vs_superficial = '';
    feeds[1].feed[0].matched_components = [];
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.length >= 2, `expected ≥2 errors, got: ${result.errors.join(' | ')}`);
  });

  test('eval passes when a rejected item has no matched_components (no-silent-drop satisfied)', async () => {
    const [feeds, researchers] = makeValidArtifact();
    // Rejected items already have empty matched_components in makeValidFeed — should pass
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, true, `eval should pass: ${result.errors.join('; ')}`);
  });

  test('eval passes when summary_status is unavailable (degraded state allowed)', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed_summary = { text: '', summary_status: 'unavailable' };
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, true, `degraded summary should not fail eval: ${result.errors.join('; ')}`);
  });

  test('eval fails when summary_status is ok but text is empty', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed_summary = { text: '', summary_status: 'ok' };
    const result = await evaluate(feeds, researchers, silentLogger());
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('feed_summary')));
  });
});
