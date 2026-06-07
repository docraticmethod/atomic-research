import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/eval.js';
import { createLogger } from '../src/logger.js';
import { sortFeed } from '../src/sequencer.js';
import { recencyWindow } from '../src/window.js';
import type { ResearcherFeed, FeedItem, Researcher } from '../src/schemas.js';

// Deterministic window so feed-item dates are evaluated against a fixed span
// regardless of the wall clock when tests run.
const TEST_WIN = recencyWindow(new Date('2026-06-07')); // ≈ 2025-12-09 → 2026-06-07

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} } as ReturnType<typeof createLogger>;
}

function makeFeedItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    feed_item_id: 'FI-TEST',
    researcher_id: 'A1',
    paper_id: 'W-TEST',
    position: 1,
    title: 'Test Paper',
    publication_date: '2026-01-15',
    relevance_decision: true,
    relevance_score: 0.8,
    council_confidence: 85,
    relevance_reason: 'Strong match on component X.',
    matched_components: [{ component: 'Test component', source_paper_ids: ['W-SRC-01'], match_explanation: 'Advances this component substantively.' }],
    matched_subfields: ['Artificial Intelligence'],
    council_deliberation: {
      voices: [
        { role: 'advocate', argument: 'Clearly relevant.', leaning: 'for' },
        { role: 'skeptic', argument: 'Checked — no superficial overlap.', leaning: 'for' },
      ],
      substantive_vs_superficial: 'The match is substantive: the paper contributes directly to the component, not just terminology.',
      subfield_weighing: 'Subfield match reinforced the decision alongside the component match.',
      resolution: 'Unanimous accept.',
    },
    decision_status: 'ok',
    ...overrides,
  };
}

function makeGroundedProfile(researcherId: string): ResearcherFeed['grounded_profile'] {
  return {
    researcher_id: researcherId,
    grounding_status: 'ok',
    research_components: [{ name: 'Test component', description: 'desc', source_paper_ids: ['W-SRC-01'], explanation: 'why', aptness_flags: [] }],
    research_subfield_preferences: [{ name: 'Test subfield', description: 'desc', source_paper_ids: ['W-SRC-01'], explanation: 'why', aptness_flags: [] }],
  };
}

function makeResearcher(id: string): Researcher {
  return {
    researcher_id: id, name: `Researcher ${id}`, full_name: `Full Name ${id}`,
    description: 'Test researcher.', research_interests: ['topic A'],
    topics: [{ id: 'T1', display_name: 'Topic A', score: 0.9 }],
    works_count: 10, cited_by_count: 100, h_index: 5,
  };
}

function makeValidFeed(researcherId: string, paperIdPrefix: string): ResearcherFeed {
  const items: FeedItem[] = [];
  const N = 6; // live candidate pool size is variable — no fixed count gate
  for (let i = 1; i <= N; i++) {
    const paperId = `${paperIdPrefix}-${String(i).padStart(2, '0')}`;
    const isReject = i >= 5;
    items.push(makeFeedItem({
      feed_item_id: `FI-${paperIdPrefix}-${i}`,
      researcher_id: researcherId,
      paper_id: paperId,
      relevance_score: isReject ? 0.15 : 1 - (i - 1) * 0.1,
      council_confidence: isReject ? 60 : 90 - (i - 1) * 5,
      relevance_decision: !isReject,
      matched_components: isReject ? [] : [{ component: 'Test component', source_paper_ids: ['W-SRC-01'], match_explanation: 'Substantive match on the core component.' }],
      matched_subfields: isReject ? [] : ['Test subfield'],
      council_deliberation: {
        voices: [
          { role: 'advocate', argument: isReject ? 'Not relevant.' : 'Clearly relevant.', leaning: isReject ? 'against' : 'for' },
          { role: 'skeptic', argument: isReject ? 'Confirmed off-topic.' : 'Checked — genuine match.', leaning: isReject ? 'against' : 'for' },
        ],
        substantive_vs_superficial: isReject
          ? 'Superficial: the paper only shares a keyword but does not advance any research component.'
          : 'Substantive: the paper directly extends the component with new methodology.',
        subfield_weighing: isReject
          ? 'Subfield match did not apply — the paper falls outside the selected subfields.'
          : 'Subfield match was a contributing factor alongside the component match.',
        resolution: isReject ? 'Reject — off-topic.' : 'Accept.',
      },
      relevance_reason: isReject ? 'Off-topic — clear dismiss.' : 'Strong component match.',
    }));
  }
  return {
    researcher_id: researcherId,
    researcher_name: `Researcher ${researcherId}`,
    grounding_status: 'ok',
    grounded_profile: makeGroundedProfile(researcherId),
    feed: sortFeed(items),
    feed_summary: { text: 'Summary of top papers.', summary_status: 'ok' },
  };
}

// v3.2: one confirmed author per run → a single-researcher artifact.
function makeValidArtifact(): [ResearcherFeed[], Researcher[]] {
  return [[makeValidFeed('A1', 'W-R1')], [makeResearcher('A1')]];
}

describe('Phase 2 — eval gate (v3.2, single author)', () => {
  test('eval passes with a correctly assembled single-author output', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, true, `eval failed: ${result.errors.join('; ')}`);
  });

  test('eval fails when there is not exactly 1 researcher feed', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const two = [...feeds, makeValidFeed('A2', 'W-R2')];
    const result = await evaluate(two, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('1 researcher feed')));
  });

  test('eval fails when an accepted item has empty matched_components', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const accepted = feeds[0].feed.find(fi => fi.relevance_decision && fi.decision_status === 'ok')!;
    accepted.matched_components = [];
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('matched_components')));
  });

  test('eval PASSES when an accepted item has empty matched_subfields (weighed, not mandated)', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const accepted = feeds[0].feed.find(fi => fi.relevance_decision && fi.decision_status === 'ok')!;
    accepted.matched_subfields = [];
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, true, `empty matched_subfields should pass: ${result.errors.join('; ')}`);
  });

  test('eval PASSES when the live feed is all-accept (no coverage-spread gate in v3.2)', async () => {
    const [feeds, researchers] = makeValidArtifact();
    for (const fi of feeds[0].feed) {
      fi.relevance_decision = true;
      fi.matched_components = [{ component: 'Test component', source_paper_ids: ['W-SRC-01'], match_explanation: 'Substantive.' }];
    }
    feeds[0].feed = sortFeed(feeds[0].feed);
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, true, `all-accept live feed should pass: ${result.errors.join('; ')}`);
  });

  test('eval fails when subfield_weighing is missing from a deliberation', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].council_deliberation.subfield_weighing = '';
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('subfield_weighing')));
  });

  test('eval fails when grounding_status is ok but grounded_profile is null', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].grounded_profile = null;
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('grounded_profile is null')));
  });

  test('eval passes for a grounding-degraded author (null profile, empty feed)', async () => {
    const researchers = [makeResearcher('A1')];
    const degraded: ResearcherFeed = {
      researcher_id: 'A1', researcher_name: 'Researcher A1',
      grounding_status: 'unavailable', grounded_profile: null, feed: [],
      feed_summary: { text: '', summary_status: 'unavailable' },
    };
    const result = await evaluate([degraded], researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, true, `degraded author should pass: ${result.errors.join('; ')}`);
  });

  test('eval fails when feed order does not match the relevance_score sort', async () => {
    const [feeds, researchers] = makeValidArtifact();
    const tmp = feeds[0].feed[0].position;
    feeds[0].feed[0].position = feeds[0].feed[1].position;
    feeds[0].feed[1].position = tmp;
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('position')));
  });

  test('eval fails when substantive_vs_superficial is missing', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].council_deliberation.substantive_vs_superficial = '';
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('substantive_vs_superficial')));
  });

  test('eval fails when a paper publication_date is outside the recency window', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].publication_date = '2025-01-01';
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('recency window')));
  });

  test('eval aggregates multiple errors without short-circuiting', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed[0].council_deliberation.substantive_vs_superficial = '';
    feeds[0].feed[1].council_deliberation.subfield_weighing = '';
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.length >= 2, `expected ≥2 errors, got: ${result.errors.join(' | ')}`);
  });

  test('eval passes when summary_status is unavailable (degraded state allowed)', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed_summary = { text: '', summary_status: 'unavailable' };
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, true, `degraded summary should pass: ${result.errors.join('; ')}`);
  });

  test('eval fails when summary_status is ok but text is empty', async () => {
    const [feeds, researchers] = makeValidArtifact();
    feeds[0].feed_summary = { text: '', summary_status: 'ok' };
    const result = await evaluate(feeds, researchers, silentLogger(), TEST_WIN);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('feed_summary')));
  });
});
