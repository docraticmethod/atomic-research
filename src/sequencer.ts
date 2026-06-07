import type { FeedItem } from './schemas.js';

export const WINDOW_START = new Date('2025-12-06');
export const WINDOW_END = new Date('2026-06-06');

export function assertRecencyWindow(items: { publication_date: string; paper_id: string }[]): void {
  const out = items.filter(item => {
    const d = new Date(item.publication_date);
    return d < WINDOW_START || d > WINDOW_END;
  });
  if (out.length > 0) {
    throw new Error(
      `Recency window violation — papers outside 2025-12-06→2026-06-06: ${out.map(i => `${i.paper_id}(${i.publication_date})`).join(', ')}`,
    );
  }
}

export function sortFeed(items: FeedItem[]): FeedItem[] {
  const sorted = [...items].sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    if (b.council_confidence !== a.council_confidence) {
      return b.council_confidence - a.council_confidence;
    }
    return new Date(b.publication_date).getTime() - new Date(a.publication_date).getTime();
  });

  return sorted.map((item, i) => ({ ...item, position: i + 1 }));
}
