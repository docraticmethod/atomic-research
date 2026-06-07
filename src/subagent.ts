import Anthropic from '@anthropic-ai/sdk';
import { op } from 'weave';
import { buildCouncilMessages } from './skills/council.js';
import { buildExtractionMessages, buildAptnessMessages } from './skills/grounding.js';
import { buildOnboardingMessages } from './skills/onboarding.js';
import type { RawAuthor } from './openalex-client.js';
import type { CandidateSubfield } from './fetch-boundary.js';
import type {
  Researcher, Paper, Publication, GroundedProfile,
  FeedItem, FeedSummary, CouncilDeliberation, MatchedComponent,
} from './schemas.js';
import type { Logger } from './logger.js';

const MODEL = 'claude-sonnet-4-6';

// ── Onboarding: LLM picks the candidate-pull subfields + writes the profile ──

export type ProfileSynthesis = {
  description: string;
  research_interests: string[];
  selected_subfields: { id: string; display_name: string; reason: string }[];
};

// Reads the author's own publications + the candidate (valid) OpenAlex subfields
// and returns the narrative profile plus the chosen pull subfields. Selections
// are filtered to the candidate id-set so an invented id can never reach the
// pull. Returns null on any failure (the orchestrator falls back deterministically).
export const runProfileSynthesis = op(async function runProfileSynthesis(
  author: RawAuthor,
  publications: Publication[],
  candidates: CandidateSubfield[],
  logger: Logger,
): Promise<ProfileSynthesis | null> {
  const client = new Anthropic({ maxRetries: 3 });
  const { system, user } = await buildOnboardingMessages(author, publications, candidates);

  logger.info('issuing profile-synthesis (subfield selection) call', {
    author_id: author.id,
    publications: publications.length,
    candidate_subfields: candidates.length,
    model: MODEL,
  });

  let raw: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1536,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = response.content[0];
    if (block.type !== 'text') return null;
    raw = block.text;
  } catch (err) {
    logger.error('profile-synthesis call failed', { author_id: author.id, error: String(err) });
    return null;
  }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const candidateIds = new Set(candidates.map(c => c.id));

    const selected = ((parsed.selected_subfields as ProfileSynthesis['selected_subfields'] | undefined) ?? [])
      .filter(s => s && typeof s.id === 'string' && candidateIds.has(s.id))
      .map(s => ({ id: s.id, display_name: String(s.display_name ?? ''), reason: String(s.reason ?? '') }));

    const description = String(parsed.description ?? '').trim();
    const research_interests = ((parsed.research_interests as string[] | undefined) ?? [])
      .filter(x => typeof x === 'string' && x.trim().length > 0);

    if (!description || selected.length === 0) {
      logger.warn('profile-synthesis incomplete — empty description or no valid subfield selected', {
        author_id: author.id,
        has_description: Boolean(description),
        selected_count: selected.length,
      });
      return null;
    }

    return { description, research_interests, selected_subfields: selected };
  } catch (err) {
    logger.error('profile-synthesis JSON malformed', { author_id: author.id, error: String(err), preview: raw.slice(0, 300) });
    return null;
  }
});

// ── Stage 1: grounding calls (single calls per researcher, not batched) ─────

// Call 1 — extraction. Reads the full publications corpus, emits a structured
// (but not yet validated) research profile as raw text for integrity.ts.
export const runGroundingExtraction = op(async function runGroundingExtraction(
  researcher: Researcher,
  publications: Publication[],
  logger: Logger,
): Promise<string | null> {
  const client = new Anthropic({ maxRetries: 3 });
  const { system, user } = await buildExtractionMessages(researcher, publications);

  logger.info('issuing grounding extraction call', {
    researcher_id: researcher.researcher_id,
    publications: publications.length,
    model: MODEL,
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : null;
  } catch (err) {
    logger.error('grounding extraction call failed', { researcher_id: researcher.researcher_id, error: String(err) });
    return null;
  }
});

// Call 2 — evidence-aptness validation. Audits Call 1's output for weak/fabricated
// semantic lineage. Advisory only (Layer 3) — never gates acceptance.
export const runAptnessValidation = op(async function runAptnessValidation(
  researcher: Researcher,
  extractedRaw: string,
  logger: Logger,
): Promise<string | null> {
  const client = new Anthropic({ maxRetries: 3 });
  const { system, user } = await buildAptnessMessages(researcher, extractedRaw);

  logger.info('issuing aptness validation call', { researcher_id: researcher.researcher_id, model: MODEL });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : null;
  } catch (err) {
    logger.error('aptness validation call failed', { researcher_id: researcher.researcher_id, error: String(err) });
    return null;
  }
});

// Layer-1 repair re-prompt. Re-issues extraction with the structural failure
// appended so the model can correct it. Throws on transport failure (the
// integrity loop logs and counts the attempt).
export const runGroundingRepair = op(async function runGroundingRepair(
  researcher: Researcher,
  publications: Publication[],
  failureReason: string,
  logger: Logger,
): Promise<string> {
  const client = new Anthropic({ maxRetries: 3 });
  const { system, user } = await buildExtractionMessages(researcher, publications);
  const repairUser = `${user}

PREVIOUS ATTEMPT FAILED VALIDATION: ${failureReason}
Fix the issue and return valid JSON only — no markdown fences, no prose outside the JSON object.`;

  logger.info('issuing grounding repair call', { researcher_id: researcher.researcher_id, reason: failureReason, model: MODEL });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: repairUser }],
  });
  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('repair call returned non-text content');
  }
  return block.text;
});

// ── Stage 2: council deliberation (one call per paper) ──────────────────────

export type CouncilBatchResult = {
  paper_id: string;
  raw: string | null;
  error: string | null;
};

export const runCouncilBatch = op(async function runCouncilBatch(
  researcher: Researcher,
  papers: Paper[],
  groundedProfile: GroundedProfile,
  logger: Logger,
): Promise<CouncilBatchResult[]> {
  const client = new Anthropic({ maxRetries: 3 });

  logger.info('submitting council calls', {
    researcher_id: researcher.researcher_id,
    count: papers.length,
    model: MODEL,
  });

  const results = await Promise.all(
    papers.map(async (paper): Promise<CouncilBatchResult> => {
      const { system, user } = await buildCouncilMessages(
        researcher,
        groundedProfile.research_components,
        groundedProfile.research_subfield_preferences,
        paper,
      );
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const block = response.content[0];
        return {
          paper_id: paper.paper_id,
          raw: block.type === 'text' ? block.text : null,
          error: null,
        };
      } catch (err) {
        logger.error('council call failed', {
          researcher_id: researcher.researcher_id,
          paper_id: paper.paper_id,
          error: String(err),
        });
        return { paper_id: paper.paper_id, raw: null, error: String(err) };
      }
    }),
  );

  logger.info('council calls complete', {
    researcher_id: researcher.researcher_id,
    count: results.length,
    succeeded: results.filter(r => r.raw !== null).length,
    failed: results.filter(r => r.raw === null).length,
  });

  return results;
});

function degradedItem(
  feedItemId: string,
  researcherId: string,
  paperId: string,
  paper: Paper,
  status: 'unavailable' | 'malformed',
  message: string,
): FeedItem {
  return {
    feed_item_id: feedItemId,
    researcher_id: researcherId,
    paper_id: paperId,
    position: 10,
    title: paper.title,
    publication_date: paper.publication_date,
    relevance_decision: false,
    relevance_score: 0,
    council_confidence: 0,
    relevance_reason: message,
    matched_components: [],
    matched_subfields: [],
    council_deliberation: {
      voices: [],
      substantive_vs_superficial: '',
      subfield_weighing: '',
      resolution: message,
    },
    decision_status: status,
  };
}

export function parseCouncilResult(
  raw: string | null,
  paperId: string,
  paper: Paper,
  feedItemId: string,
  researcherId: string,
  logger: Logger,
): FeedItem {
  if (raw === null) {
    logger.warn('council decision unavailable', { paperId });
    return degradedItem(feedItemId, researcherId, paperId, paper, 'unavailable', 'Decision unavailable — retry');
  }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const relevance_decision = Boolean(parsed.relevance_decision);
    const relevance_score = Number(parsed.relevance_score ?? 0);
    const council_confidence = Math.round(Number(parsed.council_confidence ?? 0));
    const relevance_reason = String(parsed.relevance_reason ?? '');
    const matched_components = (parsed.matched_components as MatchedComponent[] | undefined) ?? [];
    const matched_subfields = (parsed.matched_subfields as string[] | undefined) ?? [];
    const rawDelib = parsed.council_deliberation as Record<string, unknown> | undefined;

    const voices = (rawDelib?.voices as CouncilDeliberation['voices'] | undefined) ?? [];
    const svs = String(rawDelib?.substantive_vs_superficial ?? '').trim();
    const subfield_weighing = String(rawDelib?.subfield_weighing ?? '').trim();
    const resolution = String(rawDelib?.resolution ?? '').trim();

    // Treat a structurally incomplete deliberation as malformed so it renders
    // as a retryable placeholder rather than silently passing a broken record.
    if (voices.length === 0 || svs.length === 0 || subfield_weighing.length === 0) {
      logger.error('council deliberation incomplete — voices, substantive_vs_superficial, or subfield_weighing empty', {
        paperId,
        voices_count: voices.length,
        svs_len: svs.length,
        subfield_weighing_len: subfield_weighing.length,
        rawPreview: raw.slice(0, 400),
      });
      return degradedItem(feedItemId, researcherId, paperId, paper, 'malformed', 'Decision malformed — retry');
    }

    const council_deliberation: CouncilDeliberation = {
      voices,
      substantive_vs_superficial: svs,
      subfield_weighing,
      resolution,
    };

    return {
      feed_item_id: feedItemId,
      researcher_id: researcherId,
      paper_id: paperId,
      position: 0,
      title: paper.title,
      publication_date: paper.publication_date,
      relevance_decision,
      relevance_score,
      council_confidence,
      relevance_reason,
      matched_components,
      matched_subfields,
      council_deliberation,
      decision_status: 'ok',
    };
  } catch {
    logger.error('malformed council JSON', { paperId, rawPreview: raw.slice(0, 300) });
    return degradedItem(feedItemId, researcherId, paperId, paper, 'malformed', 'Decision malformed — retry');
  }
}

// ── Stage 2B: feed summary (post-decision, post-sort) ───────────────────────

export const runFeedSummary = op(async function runFeedSummary(
  researcherName: string,
  sortedFeed: FeedItem[],
  logger: Logger,
): Promise<FeedSummary> {
  const client = new Anthropic({ maxRetries: 3 });

  const acceptedItems = sortedFeed.filter(fi => fi.relevance_decision && fi.decision_status === 'ok');
  const itemLines = sortedFeed
    .map(fi => {
      const verdict = fi.relevance_decision ? 'ACCEPT' : 'REJECT';
      return `  ${fi.position}. [${verdict}] "${fi.title}" — score: ${fi.relevance_score.toFixed(2)}, confidence: ${fi.council_confidence}`;
    })
    .join('\n');

  const prompt = `You are writing a brief editorial summary of a ranked research paper feed for a researcher.

Researcher: ${researcherName}

Here is the full decided, sorted feed (position 1 = highest relevance score):
${itemLines}

Write 2–3 sentences naming the 2–3 strongest papers (those accepted with the highest scores) and their collective significance to this researcher's work. Be specific about why these papers matter together, not just individually. Return plain prose — no JSON, no lists, no markdown.`;

  logger.info('issuing feed_summary call', {
    researcher: researcherName,
    model: MODEL,
    accepted: acceptedItems.length,
    total: sortedFeed.length,
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    const text = block.type === 'text' ? block.text.trim() : '';

    if (!text) {
      logger.warn('feed_summary returned empty text', { researcher: researcherName });
      return { text: '', summary_status: 'unavailable' };
    }

    logger.info('feed_summary complete', { researcher: researcherName });
    return { text, summary_status: 'ok' };
  } catch (err) {
    logger.error('feed_summary call failed', { researcher: researcherName, error: String(err) });
    return { text: '', summary_status: 'unavailable' };
  }
});
