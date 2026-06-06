import { readFile } from 'node:fs/promises';
import { sequence } from './sequencer.js';
import { runBatch } from './subagent.js';
import { parseRationale } from './parse-rationale.js';
import { evaluate } from './eval.js';
import { validateCandidatePapers, validateResearcherProfile } from './schemas.js';
import type { OutputPaper, CandidatePaper, ResearcherProfile } from './schemas.js';
import type { Logger } from './logger.js';

export async function orchestrate(logger: Logger): Promise<OutputPaper[]> {
  const [profileRaw, papersRaw] = await Promise.all([
    readFile('data/researcher_profile.json', 'utf-8'),
    readFile('data/candidate_papers.json', 'utf-8'),
  ]);

  const profile = JSON.parse(profileRaw) as ResearcherProfile;
  const papers = JSON.parse(papersRaw) as CandidatePaper[];

  if (!validateResearcherProfile(profile)) {
    throw new Error(`researcher_profile.json invalid: ${JSON.stringify(validateResearcherProfile.errors)}`);
  }
  if (!validateCandidatePapers(papers)) {
    throw new Error(`candidate_papers.json invalid: ${JSON.stringify(validateCandidatePapers.errors)}`);
  }

  logger.info('fixtures loaded', { papers: papers.length });

  const sequenced = sequence(papers);
  logger.info('sequencing complete', {
    order: sequenced.map(p => `${p.rank}:${p.paper_id}:${p.recommended_action}`),
  });

  const batchResults = await runBatch(sequenced, profile, logger);

  const output: OutputPaper[] = sequenced.map(paper => {
    const hit = batchResults.find(r => r.paper_id === paper.paper_id);
    const rationale = parseRationale(hit?.raw ?? null, paper.paper_id, logger);

    return {
      paper_id: paper.paper_id,
      rank: paper.rank,
      title: paper.title,
      date: paper.date,
      max_component_similarity: paper.max_component_similarity,
      recommended_action: paper.recommended_action,
      components: paper.components.map(c => ({
        component: c.component,
        component_similarity: c.component_similarity,
        cleared: c.cleared,
        match_explanation: rationale.matchExplanations[c.component] ?? '',
      })),
      components_cleared_count: paper.components_cleared_count,
      relevance_rationale: rationale.relevanceRationale,
      position_rationale: rationale.positionRationale,
      tangential_flag: rationale.tangentialFlag,
      missing_information: null,
      rationale_status: rationale.status,
    };
  });

  const evalResult = evaluate(output, logger);
  if (!evalResult.passed) {
    throw new Error(`eval failed:\n${evalResult.errors.join('\n')}`);
  }

  return output;
}
