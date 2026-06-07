// The deterministic boundary recency window. `{d} = today − N days` for a fixed
// N — a single boundary-level constant computed once per run from run-time,
// applied identically to every subfield candidate pull. It controls candidate-
// pool size only and touches no grounding, council, or eval *decision* logic.
// The sequencer never filters on it; it is enforced solely at the fetch boundary
// (the pull's from_publication_date:{d} floor, plus a today upper-bound that
// drops OpenAlex's occasional future-dated junk so the window holds by
// construction). publication_date recency is only ever a final sort tie-break.

export const RECENCY_DAYS = 180; // "papers from the last 6 months"

export type RecencyWindow = {
  start: Date; // today − N days  (the {d} floor)
  end: Date; // today           (upper bound; future-dated works are dropped)
  floorISO: string; // {d} as YYYY-MM-DD for the OpenAlex from_publication_date filter
  ceilISO: string; // today as YYYY-MM-DD for the to_publication_date filter (bounds out future-dated junk)
};

function atMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Computed once per run from the current date. Pass an explicit `now` in tests
// for determinism.
export function recencyWindow(now: Date = new Date()): RecencyWindow {
  const end = atMidnight(now);
  const start = new Date(end.getTime() - RECENCY_DAYS * 24 * 60 * 60 * 1000);
  const floorISO = start.toISOString().slice(0, 10);
  const ceilISO = end.toISOString().slice(0, 10);
  return { start, end, floorISO, ceilISO };
}

export function inWindow(publicationDate: string, win: RecencyWindow): boolean {
  const d = new Date(publicationDate);
  return d >= win.start && d <= win.end;
}
