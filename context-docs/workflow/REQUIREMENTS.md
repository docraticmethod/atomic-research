# REQUIREMENTS.md

# Atomic Research — Paper Relevance Feed (v3)

## 0. Supersede notice and the one principle that changed

**This document supersedes the v2 REQUIREMENTS.md in full.** Where v2 and v3 conflict, v3 governs. Downstream layers (STRATEGY, ARCHITECTURE, SYSTEM_INSTRUCTIONS) are regenerated from this document.

**The principle that changed — read this first.** v2's load-bearing rule was: *ranking and the recommended action are deterministic, LLM-free pure functions; the LLM produces only explanatory prose.* **v3 reverses this deliberately.** In v3, relevance is **decided by a multi-agent council** — the council produces the relevance decision (yes/no), a confidence score, and a full deliberation record. This is an intentional, requirements-level reversal, not a drift. Any downstream design that reintroduces a deterministic, LLM-free relevance sequencer is wrong and contradicts this document.

**Consequence, stated honestly:** a deciding council is non-deterministic and harder to audit than v2's pure function. The mitigation is the **`council_deliberation` record** — the full reasoning is captured per decision and traced in Weave (see Observability), so a decision can be inspected and defended after the fact. The deliberation record is not optional polish; it is the audit trail that buys back the defensibility the determinism gave up.

## Context

A small set of academic researchers, each scanning recent literature, who need a fast answer to "why is this paper relevant to me, right now?" For each researcher, a **council** of LLM agents deliberates over each candidate paper against that researcher's profile, research components, and selected subfields, and decides whether the paper belongs in the feed — with a confidence score, a human-readable reason, and a full deliberation record. The result renders in the **existing v2 two-panel dashboard**, unchanged as an output surface. It runs as a hackathon prototype on the architect's own machine. It is **not** validated against any third party, processes no real researcher identity or non-public data, and makes no claim of citation-graph accuracy. **All data is synthetic, at small demo scale.**

## Inputs

Five synthetic JSON fixture files, **normalized and id-joined**, mirroring the core tables of the project's relational schema. They are the canonical input — there is no live data fetch in v3.

- `researchers.json` — one object per researcher (identity and signal fields).
- `papers.json` — the candidate papers (one object per paper).
- `research_components.json` — the thematic threads in each researcher's body of work, each traceable to the papers that defined it.
- `feed_items.json` — one object per (researcher, paper) pair: the council's decision, confidence, reason, and deliberation.
- `research_subfield_preferences.json` — the OpenAlex subfield selections each researcher made at onboarding.

All cross-file references are by id: `feed_items`, `research_components`, and `research_subfield_preferences` carry a `researcher_id` matching `researchers.json`, and `feed_items` carries a `paper_id` matching `papers.json`. The join must be explicit and mechanical — never inferred.

**Scale:** **3 researchers, 10 distinct papers each (30 papers total), 30 feed_items.** Papers are distinct per researcher in v3 — no paper appears in more than one researcher's set. `paper_id` is nonetheless independent of `researcher_id` (a paper is identified on its own terms), so no logic may assume a paper belongs to exactly one researcher.

**Temporal scope:** currentDate is 2026-06-06. All synthetic papers carry a `publication_date` within the trailing 6-month window (2025-12-06 → 2026-06-06).

**Completeness expectations:** Real feeds are uneven. The fixtures must reflect this: per researcher, at least one clear must-surface paper, at least one clear must-dismiss paper, and at least one genuinely ambiguous paper where the council's deliberation is non-trivial.

**Data shape:** Synthetic rows are shaped to *look like* OpenAlex-sourced data — realistic `openalex_id` / `arxiv_id` strings, `arxiv_categories`, `topics`, reconstructed abstracts — but no live OpenAlex/arXiv ingestion occurs, and no embeddings are computed. Vector columns from the underlying schema are omitted in v3; relevance is decided by the council, not by vector similarity.

## The council (relevance decision framework)

For each (researcher, paper) pair, a council of LLM agents deliberates and decides. The council reads, as context:

- the researcher's identity and free-text focus (`description`, `research_interests`, `topics`),
- the researcher's **research components** (the thematic threads, each with its `source_paper_ids` provenance),
- the researcher's **selected subfields** (`research_subfield_preferences`) — **subfield match is a factor the council weighs in its decision**,
- the candidate paper's title, abstract, categories, and topics.

The council produces, per pair:

- `relevance_decision` — boolean, the council's yes/no verdict on whether the paper belongs in the feed.
- `relevance_score` — numeric 0–1, the council's calibrated relevance.
- `council_confidence` — integer 0–100, the council's confidence in its own decision.
- `relevance_reason` — a concise human-readable explanation, grounded in the paper's abstract and the matched component(s) and/or subfield(s).
- `council_deliberation` — the full structured reasoning record (the multiple agent voices / considerations that produced the verdict). This is the audit trail.

**Decision factors (what the council weighs):**
- **Component match** — does the paper substantively advance one of the researcher's thematic threads (not merely share keywords)?
- **Subfield match** — does the paper fall within the researcher's selected OpenAlex subfields?
- **Focus match** — does the paper align with the researcher's stated current focus / interests?
- **Substantive-vs-superficial** — a paper matching on surface terms but not on substance must be argued down by the council, with that reasoning preserved in the deliberation. (This generalizes v2's "tangential" honesty rule: any paper whose apparent match overstates its true relevance must be caught in deliberation, not rubber-stamped.)

## Test data

**Fixture-scope philosophy:** Real-world variability at demo scale. The synthetic data must give the council genuinely uneven material to deliberate over — clear accepts, clear rejects, and hard ambiguous cases per researcher — because the council's value is in *adjudicating* mixed signals, and that is only demonstrated when the signals are mixed.

**Coverage requirements (per researcher):**
- A must-surface paper: strong component + subfield + focus alignment; high confidence accept.
- A must-dismiss paper: off-topic across components, subfields, and focus; high confidence reject.
- An ambiguous paper: strong on one axis, weak on another (e.g. on-subfield but off-component, or keyword-matching but substantively tangential) — the council's deliberation must show real reasoning, not a coin flip.
- A spread of mid-tier cases requiring genuine judgment.

**Size cap:** 3 researchers, 30 papers (10 each), 30 feed_items, plus components and subfield preferences per researcher.

**Source and privacy:** Synthetic. No real researcher, paper, author, or institution. Synthetic OpenAlex-style identifiers must be obviously synthetic and must not collide with real OpenAlex IDs.

### Fixture field contracts

**`researchers.json`** — array of:
```json
{
  "researcher_id": "RES-001",
  "name": "...",
  "full_name": "...",
  "description": "researcher's plain-text statement of focus",
  "research_interests": ["...", "..."],
  "topics": [{ "id": "T...", "display_name": "...", "score": 0.0 }]
}
```

**`papers.json`** — array of:
```json
{
  "paper_id": "PAP-...",
  "openalex_id": "W...synthetic",
  "arxiv_id": "....synthetic",
  "title": "...",
  "abstract": "reconstructed-style abstract text",
  "authors": [{ "name": "...", "openalex_id": "A...synthetic" }],
  "publication_date": "2026-..-..",
  "year": 2026,
  "arxiv_categories": ["cs.LG", "cs.AI"],
  "topics": [{ "id": "T...", "display_name": "...", "score": 0.0 }],
  "citation_count": 0,
  "is_open_access": true
}
```

**`research_components.json`** — array of:
```json
{
  "component_id": "RC-...",
  "researcher_id": "RES-001",
  "name": "...",
  "description": "LLM-style description of the thematic thread",
  "source_paper_ids": ["PAP-...", "PAP-..."],
  "is_active": true
}
```
`source_paper_ids` makes the component **traceable** to the papers that defined it — this is the v2.1 traceability fix, structural rather than asserted.

**`research_subfield_preferences.json`** — array of:
```json
{
  "id": "SFP-...",
  "researcher_id": "RES-001",
  "subfield_id": "subfields/....",
  "subfield_name": "...",
  "field_id": "fields/..",
  "field_name": "..."
}
```

**`feed_items.json`** — array of (one per researcher × paper = 30 rows):
```json
{
  "id": "FI-...",
  "researcher_id": "RES-001",
  "paper_id": "PAP-...",
  "relevance_score": 0.0,
  "relevance_reason": "<council prose, grounded in abstract + matched component/subfield>",
  "relevance_decision": true,
  "council_confidence": 0,
  "council_deliberation": { "...": "full structured reasoning record" },
  "council_version": "v3",
  "status": "pending",
  "surfaced_at": "2026-..-..T..:..:..Z"
}
```
`status` lifecycle: `pending → saved | dismissed`. In v3 the synthetic rows are `pending`; save/dismiss is a dashboard interaction.

## Outputs

**Per researcher feed** (rendered in the dashboard): the researcher's `feed_items`, ordered by `relevance_score` descending, each carrying the council's decision, confidence, reason, and a way to inspect the deliberation. Items the council decided against (`relevance_decision: false`) are **not dropped** — they render at their score position with their reject reasoning visible, so the demo shows the council *declining*, not just accepting.

**Per-feed editorial summary (`feed_summary`):** a single council-generated narrative per researcher naming the 2–3 strongest papers and their collective significance. It is a **post-decision call** — it runs after the council has decided the full set for that researcher and takes the decided, sorted feed as input. It is covered by the degraded-state contract: if it fails, the per-item feed still renders in full.

## Output surface

**Reuse the existing v2 two-panel dashboard, unchanged in structure.**
- Left panel: per-researcher ranked feed (feed_items in `relevance_score` order), each selectable; with a researcher selector since there are now 3 researchers.
- Left panel top: the `feed_summary` editorial region, with its own degraded state.
- Right panel: detail for the selected feed item — relevance reason, decision, confidence, the council deliberation (inspectable), the matched component(s), and the researcher's matched subfield(s).
- **Researcher profile view** surfaces the researcher's selected subfields (`research_subfield_preferences`) — these are shown in the profile, in addition to being consumed by the council.
- Default selection: first researcher, top-ranked feed item. Detail sections collapsed to label on load. Panels scroll independently.
- **Visual treatment:** the v2 editorial dark theme with serif titles is retained as a required deliverable — not re-litigated, not demoted to stretch.

## Implementation

**LLM commitment.** v3 is LLM-driven. The council decisions (decision, score, confidence, reason, deliberation) and the per-researcher `feed_summary` are produced by LLM calls. **This is the reversal named in §0: the LLM now decides relevance, it does not merely explain a precomputed score.**

**Council-call context (required):** each council deliberation receives the researcher's profile, research components (with `source_paper_ids`), selected subfields, and the candidate paper's abstract and metadata. The council never reasons from the title alone, and subfield match is an explicit factor.

**Call ordering:** per researcher, the council decides the full paper set first; the `feed_summary` call runs **after** that researcher's decisions are complete, on the decided and sorted feed. The summary call must be unreachable before the council has finished that researcher's set.

**Target application model:** `claude-sonnet-4-6` (pinned snapshot; dateless format but not an evergreen pointer — bump deliberately). The council's multiple deliberations per researcher are not latency-sensitive; prefer the Message Batches API where the call structure allows, to halve token cost.

**Model-ID scope note:** this identifier governs the application's runtime API calls, not the Claude Code session that builds the application.

**Degraded-state contract (required, carried from v2).** When any LLM call fails, times out, or returns malformed/partial output, no surface renders a blank panel and no feed item is silently dropped.
- A feed item whose council decision could not be produced renders at a conservative position with an explicit "decision unavailable — retry" state.
- If a researcher's `feed_summary` fails, that researcher's per-item feed still renders in full; the summary region shows "summary unavailable — retry".
- Malformed JSON from any model call is caught, logged via the observability layer, and surfaced as a retryable error on the relevant panel.

**Observability (Weave + W&B, carried from v2 — now load-bearing for auditability).**
- **Weave traces the calls.** `weave.init("<team>/atomic-research")` once at startup; the Anthropic SDK is auto-instrumented so every council deliberation and every `feed_summary` call is traced — inputs, outputs, latency, token cost. **Because the council now *decides* (non-deterministic), the Weave trace tree of each deliberation is part of the audit trail, not just telemetry.** Decorate the council's own orchestration functions and every eval assertion with `@weave.op()`.
- **W&B logs the run.** One run per fixture/prompt iteration logs the aggregate: per-researcher decision distributions, confidence distributions, accept/reject counts, batch-call metadata, and eval pass/fail.
- **Secrets:** `WANDB_API_KEY` read from a **gitignored `.env`**, mounted into the Docker container (not baked into the image), never hardcoded, never committed. Confirm `.env` is gitignored before any commit.

**Docker sandbox (carried from v2).** The application runs inside a Docker sandbox; build the container before application code. The five fixture files (INPUT) and the dashboard output (OUTPUT) are wired into the container; `.env` is mounted, not baked.

**Eval gates.** Aggregate all errors; on any failure, OUTPUT is not written. Each assertion is a `@weave.op()`. At minimum:
- Every fixture file validates against its field contract (Ajv).
- Every cross-file id reference resolves (`feed_items.researcher_id` and `.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id`) — no orphans.
- Exactly 3 researchers, 30 papers (10 distinct per researcher, no cross-researcher paper reuse), 30 feed_items.
- Every feed_item carries all council fields (decision, score, confidence, reason, deliberation).
- Per researcher, coverage roles are present (≥1 must-surface, ≥1 must-dismiss, ≥1 ambiguous).
- `feed_summary` present per researcher (or its degraded state).

**Other dependencies:** `@anthropic-ai/sdk`, `ajv`, `typescript`/`tsx`, `weave`, `wandb`. The five fixtures are canonical input — no external fetch, no embeddings, no live OpenAlex/arXiv calls in v3.