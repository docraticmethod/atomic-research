import type { Researcher, Paper, Publication, GroundedProfile, FeedItemSeed } from './schemas.js';

export type JoinedResearcher = {
  researcher: Researcher;
  papers: Paper[];
  groundedProfile: GroundedProfile;
  feedItems: FeedItemSeed[];
};

// Asserts the candidate `papers` id-space and the `publications` id-space are
// disjoint. The two are never conflated — different roles, different files.
// Called once at startup from the orchestrator.
export function assertNoIdSpaceConflict(papers: Paper[], publications: Publication[]): void {
  const paperIds = new Set(papers.map(p => p.paper_id));
  const pubIds = new Set(publications.map(p => p.publication_id));

  const collisions: string[] = [];
  for (const id of paperIds) {
    if (pubIds.has(id)) collisions.push(id);
  }
  if (collisions.length > 0) {
    throw new Error(
      `id-space conflict: ${collisions.length} id(s) appear in both papers and publications: ${collisions.join(', ')}`,
    );
  }
}

// Pure, LLM-free join for a single researcher. Resolves the researcher's feed
// items against the candidate papers, and verifies the grounded profile's
// source_paper_ids resolve into the publications id-space (belt-and-suspenders
// over integrity.ts Layer 2). Never inferred — asserts no orphans.
export function joinResearcher(
  researcher: Researcher,
  papers: Paper[],
  groundedProfile: GroundedProfile,
  feedItems: FeedItemSeed[],
  publicationIds: Set<string>,
): JoinedResearcher {
  const rid = researcher.researcher_id;
  const errors: string[] = [];

  // Papers: no duplicate ids within this researcher's set
  const paperIds = new Set<string>();
  for (const p of papers) {
    if (paperIds.has(p.paper_id)) {
      errors.push(`join: researcher ${rid} has duplicate paper_id "${p.paper_id}"`);
    }
    paperIds.add(p.paper_id);
  }

  // Feed items belong to this researcher and resolve to a candidate paper
  for (const fi of feedItems) {
    if (fi.researcher_id !== rid) {
      errors.push(`join: feed item ${fi.id} has researcher_id "${fi.researcher_id}" but is filed under "${rid}" (cross-researcher contamination)`);
    }
    if (!paperIds.has(fi.paper_id)) {
      errors.push(`join: researcher ${rid} feed item ${fi.id} has orphan paper_id "${fi.paper_id}"`);
    }
  }

  // Grounded components/subfields: source_paper_ids resolve into publications,
  // never into the candidate papers id-space.
  for (const c of groundedProfile.research_components) {
    for (const id of c.source_paper_ids) {
      if (!publicationIds.has(id)) {
        errors.push(`join: researcher ${rid} component "${c.name}" has source_paper_id "${id}" not in publications`);
      }
      if (paperIds.has(id)) {
        errors.push(`join: researcher ${rid} component "${c.name}" source_paper_id "${id}" resolves into candidate papers — must resolve into publications only`);
      }
    }
  }
  for (const s of groundedProfile.research_subfield_preferences) {
    for (const id of s.source_paper_ids) {
      if (!publicationIds.has(id)) {
        errors.push(`join: researcher ${rid} subfield "${s.name}" has source_paper_id "${id}" not in publications`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`join: orphan/contamination references found:\n${errors.join('\n')}`);
  }

  return { researcher, papers, groundedProfile, feedItems };
}
