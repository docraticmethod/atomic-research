import { op } from 'weave';
import type { RawAuthor } from '../openalex-client.js';
import type { Publication } from '../schemas.js';
import type { CandidateSubfield } from '../fetch-boundary.js';

// ── Onboarding LLM step (v3.2 deliberate deviation) ─────────────────────────
//
// R-3.2-4 describes deterministic subfield derivation from primary_topic.subfield
// tags. Per the architect's direction, the LLM is instead the decider: it reads
// the author's own publications and CHOOSES which OpenAlex subfields to monitor
// for the candidate pull, and writes the narrative profile description. This is
// the "major pull" of the system — LLM inference grounded in the real corpus.
//
// Guard rails that keep this safe and valid:
//   - The LLM may ONLY select from the candidate subfield list (every entry is a
//     real, bare OpenAlex subfield id drawn from the author's own works +
//     author-profile topics), so every selected id is queryable.
//   - On any failure (LLM down, malformed, zero selections) the orchestrator
//     falls back to the deterministic top-N candidate subfields — the R-3.2-4
//     thin-coverage fallback path.

const SYSTEM_PROMPT = `You are a research-profile onboarding system. You read a scholar's OpenAlex author profile and their own publications, and you produce two things:

1. A narrative "description" (2–4 sentences, first person, like a scholar describing their own research focus) grounded ENTIRELY in the publications provided — never invented.
2. "research_interests": 5–10 short topical phrases capturing what they work on.
3. "selected_subfields": the 3–6 OpenAlex subfields whose RECENT literature this scholar would most want surfaced in a feed. You MUST choose only from the CANDIDATE SUBFIELDS list provided — copy the "id" and "display_name" verbatim. Prefer subfields that are central to the body of work (high work_count and clearly evidenced by the publication titles/abstracts) over incidental ones.

Return ONLY valid JSON of this exact shape — no markdown fences, no prose outside the JSON:
{
  "description": "<narrative>",
  "research_interests": ["<phrase>", ...],
  "selected_subfields": [
    { "id": "<exact candidate id>", "display_name": "<exact candidate display_name>", "reason": "<why this subfield matters to the scholar, grounded in their work>" }
  ]
}

RULES:
- "selected_subfields[].id" MUST be an exact id from the CANDIDATE SUBFIELDS list. Never invent a subfield id.
- Choose 3–6 subfields. If fewer than 3 candidates exist, select all of them.
- Ground everything in the provided publications. Do not assert interests the papers do not support.`;

function formatPublications(pubs: Publication[]): string {
  if (pubs.length === 0) return '(no publications available)';
  return pubs
    .slice(0, 50)
    .map(p => {
      const abs = p.abstract ? p.abstract.slice(0, 400) : '(no abstract available)';
      return `[${p.publication_id}] ${p.title} (${p.year})\n  ${abs}`;
    })
    .join('\n');
}

function formatCandidates(candidates: CandidateSubfield[]): string {
  if (candidates.length === 0) return '(none)';
  return candidates
    .map(c => `  - id: ${c.id} | ${c.display_name} | appears on ${c.work_count} of the author's works`)
    .join('\n');
}

export const buildOnboardingMessages = op(function buildOnboardingMessages(
  author: RawAuthor,
  publications: Publication[],
  candidates: CandidateSubfield[],
): { system: string; user: string } {
  const user = `AUTHOR
Name: ${author.display_name}
Works: ${author.works_count} · Citations: ${author.cited_by_count} · h-index: ${author.summary_stats?.h_index ?? 'n/a'}

PUBLICATIONS (${publications.length}, most recent first):
${formatPublications(publications)}

CANDIDATE SUBFIELDS (you may select ONLY from this list — copy ids verbatim):
${formatCandidates(candidates)}

Produce the description, research_interests, and selected_subfields (3–6, only from the candidate list). Return only valid JSON.`;

  return { system: SYSTEM_PROMPT, user };
});
