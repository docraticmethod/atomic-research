import type { FeedItem } from './schemas.js';
import { recencyWindow, type RecencyWindow } from './window.js';

// The recency window is derived once per run from run-time ({d} = today − N days);
// it is NOT a hard-coded fixture span. The sequencer performs no candidate-pool
// filtering of any kind — the window is enforced solely at the fetch boundary.
// This assert is a belt-and-suspenders check that everything the sequencer sees
// is already in-window by construction.
export function assertRecencyWindow(
  items: { publication_date: string; paper_id: string }[],
  win: RecencyWindow = recencyWindow(),
): void {
  const out = items.filter(item => {
    const d = new Date(item.publication_date);
    return d < win.start || d > win.end;
  });
  if (out.length > 0) {
    const lo = win.start.toISOString().slice(0, 10);
    const hi = win.end.toISOString().slice(0, 10);
    throw new Error(
      `Recency window violation — papers outside ${lo}→${hi}: ${out.map(i => `${i.paper_id}(${i.publication_date})`).join(', ')}`,
    );
  }
}

// Pure presentation sort over council outputs — relevance_score desc, tie-break
// council_confidence desc, then publication_date recency. Makes no relevance
// decision; introduces no LLM-free relevance logic.
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
