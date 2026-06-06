import type { SequencedPaper } from '../sequencer.js';
import type { ResearcherProfile } from '../schemas.js';

const SYSTEM_PROMPT = `You are a research relevance analyst. You receive a ranked candidate paper with its deterministic score data and must produce explanatory prose rationale.

Your outputs:
1. match_explanations — per component: explain the specific match or mismatch between the component and the paper's likely content.
2. relevance_rationale — 1–3 sentences on the paper's overall relevance to this researcher.
3. position_rationale — 1–2 sentences explaining why this paper holds its ranked position relative to the others.

Critical rules:
- rank and recommended_action are given facts. Do not reassign them.
- If a paper's match is loose or tangential — the paper superficially references a topic but is fundamentally about something else — you MUST explicitly frame it as tangential or a loose match. Do not overstate relevance; a high score on a single narrow component does not make the paper broadly relevant.
- Be specific. Ground rationale in what the paper is actually about, as inferred from its title.
- Return valid JSON only. No markdown fences, no prose outside the JSON.`;

export function buildRationaleMessages(
  paper: SequencedPaper,
  profile: ResearcherProfile,
): { system: string; user: string } {
  const componentLines = paper.components
    .map(c => `  - "${c.component}": ${c.component_similarity} (${c.cleared ? 'cleared ✓' : 'below threshold'})`)
    .join('\n');

  const profileComponents = profile.research_components
    .map(rc => `"${rc.component}" — ${rc.description}`)
    .join('; ');

  const user = `Researcher: ${profile.name}
Research components: ${profileComponents}

Paper: "${paper.title}"
Date: ${paper.date}
Rank: ${paper.rank} / 10
Recommended action: ${paper.recommended_action}
Max component similarity: ${paper.max_component_similarity}
Components cleared (≥ 0.60): ${paper.components_cleared_count} / ${paper.components.length}

Component breakdown:
${componentLines}

Produce this JSON exactly:
{
  "match_explanations": {
${paper.components.map(c => `    "${c.component}": "<explanation>"`).join(',\n')}
  },
  "relevance_rationale": "<1–3 sentences>",
  "position_rationale": "<1–2 sentences for rank ${paper.rank}>"
}`;

  return { system: SYSTEM_PROMPT, user };
}
