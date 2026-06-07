import { op } from 'weave';
import type { Researcher, Paper, GroundedComponent, GroundedSubfield } from '../schemas.js';

const SYSTEM_PROMPT = `You are a multi-voice research relevance council. Your task is to decide whether a candidate paper belongs in this researcher's feed.

You will receive:
- The researcher's profile: description, research interests, topics
- The researcher's GROUNDED research components: named thematic threads extracted and validated from the researcher's own prior publications, each with real source papers that defined them
- The researcher's GROUNDED selected subfields
- The candidate paper: title, abstract, publication date, arXiv categories, and topics

Your decision factors (weigh all of these):
1. **Component match** — does the paper substantively advance one of the researcher's named research components? Check against the component descriptions and source_paper_ids provenance. A paper must genuinely extend the research thread, not merely share keywords with it.
2. **Subfield match** — does the paper fall within the researcher's selected subfields? This is an explicit factor, not a tiebreaker.
3. **Focus match** — does the paper align with the researcher's stated description and research interests?
4. **Substantive vs superficial** — you MUST distinguish papers that genuinely advance a research thread from papers that superficially overlap via shared terminology. A paper matching on surface terms but not on substance must be ARGUED DOWN in council_deliberation. Do not rubber-stamp apparent matches.

Output format — return valid JSON only, no markdown fences, no prose outside the JSON:

{
  "relevance_decision": <boolean>,
  "relevance_score": <number 0.0–1.0, calibrated: 0.8+ = strong accept, 0.5–0.8 = moderate accept, 0.3–0.5 = ambiguous/borderline, below 0.3 = clear reject>,
  "council_confidence": <integer 0–100, how confident the council is in its decision>,
  "relevance_reason": "<1–3 sentences grounded in the paper's abstract and the specific matched component(s) and/or subfield(s). If rejecting, name why the apparent match is superficial.>",
  "matched_components": [
    {
      "component": "<component name from the researcher's grounded components>",
      "source_paper_ids": ["<publication_id from the matched component's provenance>", ...],
      "match_explanation": "<how this paper advances this specific component, grounded in the abstract>"
    }
  ],
  "matched_subfields": ["<subfield_name>", ...],
  "council_deliberation": {
    "voices": [
      { "role": "<advocate|skeptic|subfield_reviewer|scope_checker>", "argument": "<specific argument>", "leaning": "<for|against>" }
    ],
    "substantive_vs_superficial": "<required: argument distinguishing whether the paper's match is substantive advancement of a research thread or surface keyword overlap. Be specific about what the paper actually does vs what the component requires.>",
    "subfield_weighing": "<required: how subfield match was weighed in this decision — including the case where subfield match was NOT the deciding factor because the paper matched on components or focus instead.>",
    "resolution": "<how the voices resolved to the decision — name any dissent>"
  }
}

CRITICAL RULES — violating any of these will break the pipeline:
- council_deliberation.voices MUST be a non-empty array with AT LEAST 2 voice objects. Never output "voices": [].
- council_deliberation.substantive_vs_superficial MUST be a non-empty string of at least 2 sentences. Never output "substantive_vs_superficial": "". Write real reasoning about whether the match is substantive or superficial.
- council_deliberation.subfield_weighing MUST be a non-empty string. Record how subfield match was or was not a deciding factor — even when the paper matched on components/focus instead of subfield.
- council_deliberation.resolution MUST be a non-empty string summarising how the voices reached the decision.
- matched_components must be empty [] if relevance_decision is false or if no component is genuinely matched
- matched_subfields must be empty [] if no subfield genuinely matches
- For accepted papers (relevance_decision: true), matched_components MUST have at least one entry with a populated match_explanation and the source_paper_ids of the matched grounded component (these are the researcher's own publication ids — copy them from the component's provenance, do not invent)
- Return ONLY valid JSON — no markdown fences, no prose outside the JSON object`;

export const buildCouncilMessages = op(function buildCouncilMessages(
  researcher: Researcher,
  components: GroundedComponent[],
  subfields: GroundedSubfield[],
  paper: Paper,
): { system: string; user: string } {
  const componentLines = components
    .map(c => [
      `  - "${c.name}"`,
      `    Description: ${c.description}`,
      `    Source publications: ${c.source_paper_ids.join(', ')}`,
      `    Why grounded: ${c.explanation}`,
    ].join('\n'))
    .join('\n');

  const subfieldLines = subfields
    .map(s => `  - ${s.name}: ${s.description}`)
    .join('\n');

  const topicLines = paper.topics
    .map(t => `  - ${t.display_name} (score: ${t.score})`)
    .join('\n');

  const user = `RESEARCHER PROFILE
ID: ${researcher.researcher_id}
Name: ${researcher.name}
Description: ${researcher.description}
Research interests: ${researcher.research_interests.join(', ')}

GROUNDED RESEARCH COMPONENTS (extracted and validated from the researcher's own publications, with source provenance):
${componentLines}

GROUNDED SELECTED SUBFIELDS:
${subfieldLines}

CANDIDATE PAPER
ID: ${paper.paper_id}
Title: ${paper.title}
Publication date: ${paper.publication_date}
arXiv categories: ${paper.arxiv_categories.join(', ')}
Topics:
${topicLines}

Abstract:
${paper.abstract}

Decide whether this paper belongs in ${researcher.name}'s feed. Return only valid JSON as specified.`;

  return { system: SYSTEM_PROMPT, user };
});
