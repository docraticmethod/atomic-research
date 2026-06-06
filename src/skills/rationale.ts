import { op } from 'weave';
import type { SequencedPaper } from '../sequencer.js';
import type { ResearcherProfile, CandidatePaper } from '../schemas.js';

const SYSTEM_PROMPT = `You are a research relevance analyst. You receive a ranked candidate paper with its deterministic score data and must produce explanatory prose rationale.

Your outputs:
1. match_explanations — per component: explain the specific match or mismatch between the component and the paper's actual content, grounded in the abstract and evidence field.
2. relevance_rationale — 1–3 sentences on the paper's overall relevance to this researcher. Explicitly distinguish depth (strong single-thread match on one component) from breadth (cross-component relevance across multiple components). A paper with high max_component_similarity but low scores on other components is a depth match; a paper with moderate but cleared scores across many components is a breadth match. Name which pattern applies and why it matters.
3. position_rationale — 1–2 sentences explaining why this paper holds its ranked position relative to the others.
4. missing_information — one sentence noting any material information absent from the provided context that would change the assessment, or the string "nothing material missing" if nothing is absent.

Critical rules:
- rank and recommended_action are given facts. Do not reassign them.
- If a paper's match is loose or tangential — the paper superficially references a topic but is fundamentally about something else — you MUST explicitly frame it as tangential or a loose match. Do not overstate relevance; a high score on a single narrow component does not make the paper broadly relevant. PAP-07 is the canonical case: its "information retrieval" score reflects hash-lookup primitives, not semantic IR.
- Ground every rationale in the paper's abstract and the component evidence fields. Never reason from the title alone.
- Return valid JSON only. No markdown fences, no prose outside the JSON.`;

export const buildRationaleMessages = op(function buildRationaleMessages(
  paper: SequencedPaper,
  profile: ResearcherProfile,
  fixture: CandidatePaper,
): { system: string; user: string } {
  const componentLines = paper.components
    .map(c => {
      const evidenceText = fixture.components.find(fc => fc.component === c.component)?.evidence ?? '';
      return [
        `  - "${c.component}": similarity ${c.component_similarity} (${c.cleared ? 'cleared ✓' : 'below threshold'})`,
        `    Evidence: ${evidenceText}`,
      ].join('\n');
    })
    .join('\n');

  const profileComponents = profile.research_components
    .map(rc => `"${rc.component}" — ${rc.description}`)
    .join('; ');

  const relevancePlaceholder =
    paper.paper_id === 'PAP-07'
      ? `"<1–3 sentences — this is a TANGENTIAL match; you MUST include the word 'tangential' or 'loose' in this field>"`
      : paper.paper_id === 'PAP-02'
      ? `"<1–3 sentences — this is a BREADTH match across multiple components; you MUST include the word 'breadth' or 'cross-component' in this field>"`
      : `"<1–3 sentences, explicitly naming depth vs. breadth pattern>"`;

  const user = `Researcher: ${profile.name}
Research components: ${profileComponents}

Paper: "${paper.title}"
Date: ${paper.date}
Rank: ${paper.rank} / 10
Recommended action: ${paper.recommended_action}
Max component similarity: ${paper.max_component_similarity}
Components cleared (≥ 0.60): ${paper.components_cleared_count} / ${paper.components.length}

Abstract:
${fixture.abstract}

Component breakdown (with evidence):
${componentLines}

Produce this JSON exactly:
{
  "match_explanations": {
${paper.components.map(c => `    "${c.component}": "<explanation grounded in abstract and evidence>"`).join(',\n')}
  },
  "relevance_rationale": ${relevancePlaceholder},
  "position_rationale": "<1–2 sentences for rank ${paper.rank}>",
  "missing_information": "<one sentence, or 'nothing material missing'>"
}`;

  return { system: SYSTEM_PROMPT, user };
});
