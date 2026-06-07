import { op } from 'weave';
import type { Researcher, Publication } from '../schemas.js';

const EXTRACTION_SYSTEM_PROMPT = `You are a research profile extraction system. You read a researcher's full publication corpus and extract a structured profile of their work, grounded entirely in the papers they have actually written.

You extract two things:

1. **research_components** — 3–6 named thematic research threads that characterise this researcher's body of work. Each carries:
   - "name": a short, specific thread name
   - "description": what the research thread is about
   - "source_paper_ids": 2–4 publication_id values from the provided corpus that best evidence this thread
   - "explanation": why those specific papers evidence this component

2. **research_subfield_preferences** — 3–5 named subfields or research areas the researcher works in. Each carries:
   - "name": the subfield name
   - "description": what the subfield is
   - "source_paper_ids": 1–3 publication_id values evidencing this subfield
   - "explanation": why those papers place the researcher in this subfield

WORKED EXAMPLE —

INPUT (abbreviated to one paper):
RESEARCHER: Dr. Example Researcher
PUBLICATIONS:
[PUB-EX-01] Neural ODE Methods for Time Series (2023, NeurIPS)
Abstract: We apply neural ordinary differential equations to continuous-time forecasting, benchmarking against recurrent baselines across six datasets.

OUTPUT:
{"research_components":[{"name":"Neural ODE applications","description":"Applying neural ordinary differential equations to continuous-time forecasting and time-series prediction.","source_paper_ids":["PUB-EX-01"],"explanation":"PUB-EX-01 directly introduces and benchmarks neural ODE methods for time-series forecasting, establishing this as a core research thread."}],"research_subfield_preferences":[{"name":"Time series analysis","description":"Computational methods for modelling and forecasting temporal data.","source_paper_ids":["PUB-EX-01"],"explanation":"PUB-EX-01 demonstrates sustained methodological work in time-series forecasting."}]}

RULES:
- Return ONLY valid JSON. No markdown fences. No prose outside the JSON object.
- "source_paper_ids" must be EXACT publication_id values copied from the provided corpus. Do not invent, paraphrase, or alter ids. Citing an id that is not in the corpus is a critical error.
- Ground every component and subfield in real papers from the corpus. Do not assert a thread the papers do not support.`;

const APTNESS_SYSTEM_PROMPT = `You are an evidence-aptness auditor. You receive a researcher profile that another system extracted from a publication corpus. For each research component and subfield, you judge whether the cited source papers actually SUPPORT the claimed thread, or whether the lineage is weak or fabricated.

For each component/subfield, classify the evidence as:
- strong: the cited papers genuinely and directly support the claim
- weak: the cited papers are only tangentially related to the claim
- wrong: the cited papers do not support the claim at all (e.g. "cited for X but the paper is about Y")

Return JSON of this exact shape:
{"aptness_flags":[{"target":"<exact component or subfield name>","flag":"<one-sentence description of the concern>"}]}

Include an entry ONLY where there is a genuine "weak" or "wrong" concern. If all evidence is well-grounded, return {"aptness_flags":[]}.

You are advisory. You flag semantic mismatches between a claim and its cited evidence. You do NOT decide acceptance — you only surface concerns for inspection.

Return ONLY valid JSON. No markdown fences. No prose outside the JSON object.`;

function formatCorpus(publications: Publication[]): string {
  return publications
    .map(p => `[${p.publication_id}] ${p.title} (${p.year}, ${p.venue})\nAbstract: ${p.abstract}`)
    .join('\n---\n');
}

export const buildExtractionMessages = op(function buildExtractionMessages(
  researcher: Researcher,
  publications: Publication[],
): { system: string; user: string } {
  const corpus = formatCorpus(publications);

  const user = `RESEARCHER
ID: ${researcher.researcher_id}
Name: ${researcher.name}
Description: ${researcher.description}
Research interests: ${researcher.research_interests.join(', ')}

PUBLICATIONS CORPUS (${publications.length} papers):
${corpus}

Extract this researcher's research components and subfield preferences from the corpus above. Every source_paper_id must be an exact publication_id from this corpus. Return only valid JSON.`;

  return { system: EXTRACTION_SYSTEM_PROMPT, user };
});

export const buildAptnessMessages = op(function buildAptnessMessages(
  researcher: Researcher,
  extractedRaw: string,
): { system: string; user: string } {
  const user = `RESEARCHER: ${researcher.name} (${researcher.researcher_id})

EXTRACTED PROFILE TO AUDIT:
${extractedRaw}

Audit the evidence aptness of each component and subfield above. Flag any whose cited source papers do not genuinely support the claimed thread. Return only valid JSON.`;

  return { system: APTNESS_SYSTEM_PROMPT, user };
});
