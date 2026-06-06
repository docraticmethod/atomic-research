import type { CandidatePaper, RecommendedAction } from './schemas.js';

export const THRESHOLD = 0.60;

const WINDOW_START = new Date('2025-12-06');
const WINDOW_END   = new Date('2026-06-06');

export function assertRecencyWindow(papers: CandidatePaper[]): void {
  const out = papers.filter(p => {
    const d = new Date(p.date);
    return d < WINDOW_START || d > WINDOW_END;
  });
  if (out.length > 0) {
    throw new Error(
      `Recency window violation — papers outside 2025-12-06→2026-06-06: ${out.map(p => `${p.paper_id}(${p.date})`).join(', ')}`,
    );
  }
}

export type SequencedComponent = {
  component: string;
  component_similarity: number;
  cleared: boolean;
};

export type SequencedPaper = {
  paper_id: string;
  title: string;
  date: string;
  rank: number;
  max_component_similarity: number;
  recommended_action: RecommendedAction;
  components: SequencedComponent[];
  components_cleared_count: number;
};

function recommendedAction(maxSim: number): RecommendedAction {
  if (maxSim >= 0.80) return 'Read now';
  if (maxSim >= THRESHOLD) return 'Save';
  return 'Skip';
}

export function sequence(papers: CandidatePaper[]): SequencedPaper[] {
  assertRecencyWindow(papers);
  const enriched = papers.map(paper => {
    const sims = paper.components.map(c => c.component_similarity);
    const maxSim = Math.max(...sims);
    const clearedCount = paper.components.filter(c => c.component_similarity >= THRESHOLD).length;
    return {
      paper_id: paper.paper_id,
      title: paper.title,
      date: paper.date,
      max_component_similarity: maxSim,
      components_cleared_count: clearedCount,
      components: paper.components.map(c => ({
        component: c.component,
        component_similarity: c.component_similarity,
        cleared: c.component_similarity >= THRESHOLD,
      })),
    };
  });

  enriched.sort((a, b) => {
    if (b.max_component_similarity !== a.max_component_similarity) {
      return b.max_component_similarity - a.max_component_similarity;
    }
    if (b.components_cleared_count !== a.components_cleared_count) {
      return b.components_cleared_count - a.components_cleared_count;
    }
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return enriched.map((paper, i) => ({
    ...paper,
    rank: i + 1,
    recommended_action: recommendedAction(paper.max_component_similarity),
  }));
}
