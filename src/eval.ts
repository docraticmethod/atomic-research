import { op } from 'weave';
import { validateOutputArtifact, validateFeedSummary, validateGroundedProfile } from './schemas.js';
import type { ResearcherFeed, Researcher, FeedItem } from './schemas.js';
import { recencyWindow, type RecencyWindow } from './window.js';
import type { Logger } from './logger.js';

export type EvalResult = {
  passed: boolean;
  errors: string[];
};

const SUBSTANTIVE_MIN_LENGTH = 20;

export const evaluate = op(function evaluate(
  feeds: ResearcherFeed[],
  researchers: Researcher[],
  logger: Logger,
  win: RecencyWindow = recencyWindow(),
): EvalResult {
  const errors: string[] = [];

  // Schema gate — full artifact validates
  if (!validateOutputArtifact(feeds)) {
    for (const err of validateOutputArtifact.errors ?? []) {
      errors.push(`schema: ${err.instancePath} ${err.message}`);
    }
  }

  // Scale (v3.2): one confirmed author per run.
  if (feeds.length !== 1) {
    errors.push(`sanity: expected 1 researcher feed (single confirmed author), got ${feeds.length}`);
  }

  // Grounding contract: ok ⇒ validated profile present; unavailable ⇒ null
  // profile + 0 items (no partial profile, council did not run). The feed length
  // is the live candidate-pool size (variable), so no fixed-count gate.
  for (const rf of feeds) {
    const rid = rf.researcher_id;
    if (rf.grounding_status === 'ok') {
      if (!rf.grounded_profile) {
        errors.push(`sanity: researcher ${rid} grounding_status is ok but grounded_profile is null`);
      } else {
        if (!validateGroundedProfile(rf.grounded_profile)) {
          errors.push(`schema: researcher ${rid} grounded_profile invalid: ${JSON.stringify(validateGroundedProfile.errors)}`);
        }
        for (const c of rf.grounded_profile.research_components) {
          if (!c.source_paper_ids || c.source_paper_ids.length === 0) {
            errors.push(`sanity: researcher ${rid} grounded component "${c.name}" has empty source_paper_ids`);
          }
        }
        for (const s of rf.grounded_profile.research_subfield_preferences) {
          if (!s.source_paper_ids || s.source_paper_ids.length === 0) {
            errors.push(`sanity: researcher ${rid} grounded subfield "${s.name}" has empty source_paper_ids`);
          }
        }
      }
    } else {
      // grounding_status === 'unavailable'
      if (rf.grounded_profile !== null) {
        errors.push(`sanity: researcher ${rid} grounding_status is unavailable but grounded_profile is non-null (no partial profile allowed)`);
      }
      if (rf.feed.length !== 0) {
        errors.push(`sanity: researcher ${rid} grounding_status is unavailable but feed is non-empty (council must not run)`);
      }
    }
  }

  // NOTE (v3.2): the v3.1 cross-researcher-reuse gate and the coverage-spread
  // gate (checkCoverageRoles) are DROPPED — both asserted synthetic-fixture
  // properties. Over live data a paper may legitimately match multiple
  // researchers, and a single author's live feed may be all-accept or
  // all-reject. Every other grounding/council/ordering gate keeps its exact
  // v3.1 pass/fail predicate.

  // Per-researcher per-item checks — only for grounded (ok) researchers with a feed
  for (const rf of feeds) {
    if (rf.grounding_status !== 'ok') continue;
    const rid = rf.researcher_id;
    checkFeedOrder(rf.feed, rid, errors);
    checkCouncilFields(rf.feed, rid, errors);
    checkGroundingOnAccepted(rf.feed, rid, errors);
    checkSubfieldWeighing(rf.feed, rid, errors);
    checkSubstantiveVsSuperficial(rf.feed, rid, errors);
    checkNoSilentDrop(rf.feed, rid, errors);
    checkRecencyWindow(rf.feed, rid, errors, win);

    // feed_summary present (or degraded state)
    if (!rf.feed_summary) {
      errors.push(`sanity: researcher ${rid} has no feed_summary`);
    } else {
      if (!validateFeedSummary(rf.feed_summary)) {
        errors.push(`schema: researcher ${rid} feed_summary invalid`);
      }
      if (rf.feed_summary.summary_status === 'ok' && !rf.feed_summary.text.trim()) {
        errors.push(`sanity: researcher ${rid} feed_summary status is ok but text is empty`);
      }
    }
  }

  if (errors.length > 0) {
    logger.error('eval failed', { error_count: errors.length, errors });
  } else {
    logger.info('eval passed');
  }

  return { passed: errors.length === 0, errors };
});

const checkFeedOrder = op(function checkFeedOrder(feed: FeedItem[], rid: string, errors: string[]): void {
  const positions = feed.map(fi => fi.position).sort((a, b) => a - b);
  const expected = Array.from({ length: feed.length }, (_, i) => i + 1);
  if (JSON.stringify(positions) !== JSON.stringify(expected)) {
    errors.push(`sanity: researcher ${rid} positions are not 1–${feed.length} without gaps`);
  }

  // Verify sort order matches relevance_score desc → council_confidence desc → publication_date recency
  const reranked = [...feed].sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
    if (b.council_confidence !== a.council_confidence) return b.council_confidence - a.council_confidence;
    return new Date(b.publication_date).getTime() - new Date(a.publication_date).getTime();
  });

  reranked.forEach((exp, i) => {
    const actual = feed.find(fi => fi.paper_id === exp.paper_id);
    if (!actual || actual.position !== i + 1) {
      errors.push(`sanity: researcher ${rid} paper ${exp.paper_id} should be position ${i + 1}, got ${actual?.position ?? 'missing'}`);
    }
  });
});

const checkCouncilFields = op(function checkCouncilFields(feed: FeedItem[], rid: string, errors: string[]): void {
  for (const fi of feed) {
    if (fi.decision_status === 'ok') {
      if (typeof fi.relevance_decision !== 'boolean') {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} missing relevance_decision`);
      }
      if (typeof fi.relevance_score !== 'number' || fi.relevance_score < 0 || fi.relevance_score > 1) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} relevance_score out of [0,1]`);
      }
      if (typeof fi.council_confidence !== 'number' || fi.council_confidence < 0 || fi.council_confidence > 100) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} council_confidence out of [0,100]`);
      }
      if (!fi.relevance_reason?.trim()) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} missing relevance_reason`);
      }
      if (!fi.council_deliberation?.resolution?.trim()) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} missing council_deliberation.resolution`);
      }
    }
  }
});

const checkGroundingOnAccepted = op(function checkGroundingOnAccepted(feed: FeedItem[], rid: string, errors: string[]): void {
  for (const fi of feed) {
    if (fi.relevance_decision && fi.decision_status === 'ok') {
      // Accepted items must carry ≥1 matched_component with explanation + lineage
      if (!fi.matched_components || fi.matched_components.length === 0) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} accepted but matched_components is empty`);
      } else {
        for (const mc of fi.matched_components) {
          if (!mc.match_explanation?.trim()) {
            errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} matched_component "${mc.component}" has empty match_explanation`);
          }
          if (!mc.source_paper_ids || mc.source_paper_ids.length === 0) {
            errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} matched_component "${mc.component}" has empty source_paper_ids`);
          }
        }
      }
      // NOTE (v3.1): matched_subfields is NOT mandated non-empty on every accepted
      // item — subfield match is weighed inside deliberation (see checkSubfieldWeighing),
      // and a paper may be accepted on component/focus match alone.
    }
  }
});

const checkSubfieldWeighing = op(function checkSubfieldWeighing(feed: FeedItem[], rid: string, errors: string[]): void {
  for (const fi of feed) {
    if (fi.decision_status === 'ok') {
      const sw = fi.council_deliberation?.subfield_weighing ?? '';
      if (sw.trim().length < SUBSTANTIVE_MIN_LENGTH) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} council_deliberation.subfield_weighing is too short or missing`);
      }
    }
  }
});

const checkSubstantiveVsSuperficial = op(function checkSubstantiveVsSuperficial(feed: FeedItem[], rid: string, errors: string[]): void {
  for (const fi of feed) {
    if (fi.decision_status === 'ok') {
      const svs = fi.council_deliberation?.substantive_vs_superficial ?? '';
      if (svs.trim().length < SUBSTANTIVE_MIN_LENGTH) {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} council_deliberation.substantive_vs_superficial is too short or missing`);
      }
    }
  }
});

const checkNoSilentDrop = op(function checkNoSilentDrop(feed: FeedItem[], rid: string, errors: string[]): void {
  for (const fi of feed) {
    if (!fi.relevance_decision) {
      if (!fi.relevance_reason?.trim() && fi.decision_status === 'ok') {
        errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} rejected but relevance_reason (reject reasoning) is empty`);
      }
    }
    if (fi.decision_status !== 'ok' && fi.position === 0) {
      errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} has decision_status "${fi.decision_status}" but position is 0 — should be at a conservative position`);
    }
  }
});

const checkRecencyWindow = op(function checkRecencyWindow(feed: FeedItem[], rid: string, errors: string[], win: RecencyWindow): void {
  const lo = win.start.toISOString().slice(0, 10);
  const hi = win.end.toISOString().slice(0, 10);
  for (const fi of feed) {
    const d = new Date(fi.publication_date);
    if (d < win.start || d > win.end) {
      errors.push(`sanity: researcher ${rid} paper ${fi.paper_id} date ${fi.publication_date} is outside recency window ${lo}→${hi}`);
    }
  }
});
