import type { Researcher, Paper, ResearchComponent, SubfieldPreference, FeedItemSeed } from './schemas.js';

export type JoinedResearcher = {
  researcher: Researcher;
  papers: Paper[];
  components: ResearchComponent[];
  subfields: SubfieldPreference[];
  feedItems: FeedItemSeed[];
};

export function join(
  researchers: Researcher[],
  papers: Paper[],
  components: ResearchComponent[],
  subfields: SubfieldPreference[],
  feedItems: FeedItemSeed[],
): JoinedResearcher[] {
  const errors: string[] = [];

  const paperById = new Map<string, Paper>(papers.map(p => [p.paper_id, p]));
  const researcherIds = new Set<string>(researchers.map(r => r.researcher_id));

  // Verify every researcher_id in components resolves
  for (const c of components) {
    if (!researcherIds.has(c.researcher_id)) {
      errors.push(`research_components: component_id ${c.component_id} has orphan researcher_id "${c.researcher_id}"`);
    }
    for (const pid of c.source_paper_ids) {
      if (!paperById.has(pid)) {
        errors.push(`research_components: component_id ${c.component_id} has orphan source_paper_id "${pid}"`);
      }
    }
  }

  // Verify every researcher_id in subfields resolves
  for (const s of subfields) {
    if (!researcherIds.has(s.researcher_id)) {
      errors.push(`research_subfield_preferences: id ${s.id} has orphan researcher_id "${s.researcher_id}"`);
    }
  }

  // Verify every researcher_id and paper_id in feed_items resolves
  for (const fi of feedItems) {
    if (!researcherIds.has(fi.researcher_id)) {
      errors.push(`feed_items: id ${fi.id} has orphan researcher_id "${fi.researcher_id}"`);
    }
    if (!paperById.has(fi.paper_id)) {
      errors.push(`feed_items: id ${fi.id} has orphan paper_id "${fi.paper_id}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`join: orphan references found:\n${errors.join('\n')}`);
  }

  return researchers.map(researcher => {
    const rid = researcher.researcher_id;
    const researcherFeedItems = feedItems.filter(fi => fi.researcher_id === rid);
    const researcherPaperIds = new Set(researcherFeedItems.map(fi => fi.paper_id));
    const researcherPapers = papers.filter(p => researcherPaperIds.has(p.paper_id));

    return {
      researcher,
      papers: researcherPapers,
      components: components.filter(c => c.researcher_id === rid),
      subfields: subfields.filter(s => s.researcher_id === rid),
      feedItems: researcherFeedItems,
    };
  });
}
