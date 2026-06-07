# ARCHITECTURE.md

## Atomic Research — Paper Relevance Feed (v3): Component Architecture

This document specifies what components exist and how they wire together. It executes the **v3** STRATEGY.md; it does not relitigate decisions made there (the council reversal, model ID, the council-decides design, degraded-state contract, two-stage LLM call ordering, the decision model in §2a, observability stack).

**v3 supersede notice.** This ARCHITECTURE supersedes the prior (v2-aligned) architecture in full. The load-bearing change: **relevance is now DECIDED by a multi-agent LLM council, not computed by a deterministic LLM-free function.** The prior architecture's central inversion — "ranking and recommended action are deterministic, LLM-free pure functions; the LLM only explains" — is **deliberately reversed and removed.** Any component, schema field, or eval gate below that reintroduces a deterministic LLM-free relevance sequencer, a numeric admission threshold, a "component cleared" constant, or a `Read now / Save / Skip` action mapping is wrong and contradicts STRATEGY §0/§2a.

---

## 0. Architectural Confirmation & Adjustment

The agentic-harness template assumes the LLM produces the consequential judgment (triage, scoring, classification). **v3 aligns with that assumption** — the council *decides* relevance per (researcher, paper) pair. What remains deterministic is only the *display ordering*: a mechanical sort over the council's `relevance_score`. That sort is not a relevance decision and introduces no LLM-free relevance logic.

The template's per-case fan-out applies, adapted to the council shape:

| Template component | Disposition in this build |
|---|---|
| orchestrator.js | **Kept**, adapted — per researcher: fans out the council deliberation batch over the 10 papers → sorts by `relevance_score` desc → issues the post-decision `feed_summary` call → assembles records → runs eval. Enforces the §2c call ordering in code. |
| subagent.js | **Kept**, adapted — wraps the Anthropic Message Batches API (per-pair council deliberations) and a single post-decision call (feed_summary). |
| skills/primary.js | **Kept**, adapted — the council deliberation skill: it **decides** `relevance_decision`, `relevance_score`, `council_confidence`, produces `relevance_reason` and the full `council_deliberation` record. |
| skills/guardrail.js | **Dropped.** The conservative escalate-only guardrail wraps a single consequential judgment with an asymmetric-cost ramp; v3's consequential judgment is the council itself, whose **multi-voice deliberation + substantive-vs-superficial argument-down is the internal conservative check**, recorded in `council_deliberation`. The honesty requirement (a superficial match argued down, not rubber-stamped) is a council-prompt instruction + deterministic eval verification, not a two-pass escalate-only wrapper. The escalate-only enum has no referent here — there is no urgency to ratchet, only a relevance decision to argue. |
| skills/sequencer.js | **Kept as a pure function, LLM-free.** The domain verb (rank/feed) implies ordering, but ordering here is a mechanical sort over council outputs (`relevance_score` desc, tie-break confidence, then recency). This is `sequencer.ts` in the compute layer — it makes **no relevance decision** (STRATEGY §1, §2a). |
| eval.js | **Kept** — schema gate + sanity checks (council fields present, grounding/subfield fields populated, coverage roles per researcher, substantive-vs-superficial framing on the ambiguous case, display-order stability, no-silent-drop of reject-decision items, scale/join assertions). |
| memory.js | **Dropped for v1.** Batch call with deterministic retry (`maxRetries: 3`); no per-case failure-context replay. Degraded-state contract (Phase 4) handles failure surfacing instead. |
| logger.js | **Kept**, but **subordinate to the observability stack.** Weave (per-call) + W&B (per-run) are the primary instrumentation surface per STRATEGY §2; `logger.ts` provides a local JSONL trace alongside them. |

This is a deliberate, documented alignment with the council-decides reversal. The guardrail spec's escalate-only invariant does not apply: there is no urgency enum to ratchet — the council's own deliberation, captured per decision and traced in Weave, **is the auditability mechanism** that buys back the defensibility determinism gave up (STRATEGY §1, §4).

## 0a-a. Docker

Put the application in a Docker sandbox container so it is secure and Claude Code operates inside that sandbox. Build all Docker components first (STRATEGY §3 Phase 0): wire the five fixture files (INPUT) and the dashboard (OUTPUT); mount `.env` at runtime, do not bake it into the image.

---

## 0a. Observability Stack (cross-cutting, wired Phase 0)

Per STRATEGY §2 and §3, observability is a phase, not an afterthought, and in v3 it is **load-bearing for auditability** — the deliberation trace tree is the audit trail, not just telemetry. It is wired before any LLM call and decorated through Phase 2/5.

- **Weave (per-call).** `weave.init("<team>/atomic-research")` is called once at pipeline startup (`run.ts`), before any Anthropic call. It auto-instruments the Anthropic SDK so every per-pair council deliberation call and the feed_summary call appear in the trace tree. Team functions — the council orchestration logic and **every eval assertion** — are decorated `@weave.op()` so they sit in the same trace tree as the SDK calls. Because the council is non-deterministic, **this trace tree is the auditability mechanism**.
- **W&B (per-run).** One `wandb` run per fixture/prompt iteration logs the pipeline-level aggregate: per-researcher decision distributions, confidence distributions, accept/reject counts, batch-call metadata (latency, token count, per-pair decision status), and eval pass/fail results (Phase 5).
- **Secrets.** `WANDB_API_KEY` is read from a gitignored `.env`; confirmed in `.gitignore` before any commit. Never hardcoded, never committed. Mounted into Docker, not baked.
- **Cross-reference.** The Weave trace tree and the W&B run reference the same iteration (Phase 5 exit).

Application model for the built artifact's runtime calls is `claude-sonnet-4-6` (pinned snapshot, STRATEGY §2). This governs the artifact's runtime only — not the build session.

---

## 1. Pipeline Shape — Three Stages, File-Based Handoffs

Stage boundaries are files, not live connections. The pipeline writes; the server serves; the client reads.

**INPUT** — five versioned, id-joined fixtures at `data/researchers.json`, `data/papers.json`, `data/research_components.json`, `data/feed_items.json`, and `data/research_subfield_preferences.json`. Built and validated before any application component is written (Slice 0 / INPUT gate). Read by the pipeline; never modified during a run. Contains **3 researchers, 30 distinct papers (10 each, no cross-researcher reuse), 30 feed_items**, components and subfield preferences per researcher. Each paper carries a populated abstract; each component a populated `source_paper_ids` provenance; each researcher populated `description` / `research_interests` / `topics`. The synthetic `feed_items` already carry the council's decision fields; the runtime council reproduces/validates decisions over the same inputs (see §1a for the canonicality rule). **There is no numeric feed-admission cutoff** — every feed_item renders at its score position (STRATEGY §2a, no-silent-drop).

**PIPELINE** — `run.ts` + orchestrator + subagent + council skill + deterministic sequencer (sort only) + eval. Reads INPUT, produces OUTPUT. The per-pair council deliberation batch, the `relevance_score`-descending sort, the post-decision `feed_summary` call, schema validation, and assembly all happen here. Writes OUTPUT exactly once per run, after eval gates pass.

**OUTPUT** — single validated artifact at `public/output_data.json`. Written by `run.ts` after eval gates pass; never modified after write. The dashboard reads this file via the dashboard server.

No data flow between stages at render time. The dashboard renders finalized output; it does not decide relevance, sort, or call the LLM.

---

## 1a. Runtime Council vs. Fixture Decision Fields — Council Is Canonical

The synthetic `feed_items` ship with the council's decision fields pre-populated (so the fixtures are self-consistent and the INPUT gate can validate shapes without a live call). At runtime, however, **the runtime council is canonical.** The rule:

- **The runtime council overwrites the fixture decision fields.** For each (researcher, paper) pair, the OUTPUT artifact carries the *runtime* council's `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and `council_deliberation` — not the fixture-provided values. The fixture fields are seed/illustrative input, not an authority the runtime must match.
- **Divergence between fixture-provided and runtime-produced decisions is acceptable and is not an eval failure.** The council is non-deterministic by design (STRATEGY §0); requiring runtime output to match pre-populated fixture decisions would smuggle a deterministic relevance check back in, which §0/§2a forbid. Eval gates therefore assert that the *runtime* fields are present, well-formed, and internally consistent (display order matches runtime `relevance_score`, no-silent-drop, etc.) — **never** that they equal the fixture seed values.
- **The fixtures' coverage-role design still binds.** The must-surface / must-dismiss / ambiguous roles are properties of the *input* (profile, components, subfields, abstract) the council reasons over, so a well-functioning council reproduces those roles' intent (Phase 2A exit asserts the roles are reflected in the runtime decisions). This is an assertion about reasoning quality over the inputs, not a field-equality check against fixture seed values.

This is the explicit reconciliation rule: **runtime council canonical, fixture decisions are seed input, divergence is expected and not flagged.**

---

## 2. Output Schema

### 2.1 Per-feed-item contract

Proposed JSON shape for one feed item in a researcher's feed array. This is the per-item output contract Ajv enforces.

```json
{
  "feed_item_id": "FEED-R1-03",
  "researcher_id": "R1",
  "paper_id": "PAP-R1-03",
  "position": 1,
  "title": "...",
  "publication_date": "2026-02-14",
  "relevance_decision": true,
  "relevance_score": 0.87,
  "council_confidence": 82,
  "relevance_reason": "<council prose, grounded in abstract + matched component(s)/subfield(s)>",
  "matched_components": [
    {
      "component": "Sparse autoencoder feature steering",
      "source_paper_ids": ["PAP-R1-01", "PAP-R1-04"],
      "match_explanation": "<council prose>"
    }
  ],
  "matched_subfields": ["Mechanistic interpretability"],
  "council_deliberation": {
    "voices": [
      { "role": "<deliberation voice>", "argument": "<prose>", "leaning": "<for|against>" }
    ],
    "substantive_vs_superficial": "<argument distinguishing real advancement from surface keyword overlap>",
    "resolution": "<how the council reached its decision>"
  },
  "decision_status": "ok"
}
```

The example `publication_date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06), consistent with the window-eligibility assertion in §5 — every fixture, including this example, is in-window.

Field provenance:

- **Council-decided (Phase 2A, LLM):** `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and the full `council_deliberation` record. **The council decides these — there is no deterministic LLM-free relevance logic anywhere.** These are the *runtime* council's values, canonical over any fixture-provided seed (§1a).
- **Deterministic presentation-only (Phase 1, no LLM):** `position` — assigned by the mechanical sort over `relevance_score` descending (tie-break `council_confidence` desc, then `publication_date` recency). `position` is an ordering label, **not a relevance decision.**
- **Grounding/subfield fields — required and eval-locked:** for every accepted item (`relevance_decision: true`), `matched_components` must carry ≥1 entry with a populated `match_explanation` and a populated `source_paper_ids` provenance, and `matched_subfields` must be populated. These lock the grounding instruction (reason grounded in abstract + component provenance) and the subfield-as-explicit-factor requirement end-to-end; §5 asserts them.
- **`substantive_vs_superficial` — required in deliberation:** the council must distinguish substantive advancement of a research thread from surface keyword overlap. A paper whose apparent match overstates its true relevance must be **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test; eval verifies non-trivial deliberation is present for it (STRATEGY §3 Phase 2A).
- **No-silent-drop:** items with `relevance_decision: false` are **retained** and rendered at their `relevance_score` position with reject reasoning visible (STRATEGY §2a, §3 Phase 1/3).
- **Degraded-state (Phase 4):** `decision_status` ∈ `ok | unavailable | malformed`. When not `ok`, council prose fields carry a retryable placeholder and the item renders at a **conservative position**; the deterministic sort over available scores still holds for the rest of the feed.

### 2.2 Feed summary contract

The `feed_summary` is a separate per-researcher output region, not a per-item field. It is generated by a single post-decision call (Phase 2B), takes the decided, sorted feed as input, and degrades independently.

```json
{
  "feed_summary": {
    "text": "<council/editorial prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. When not `ok`, the summary region shows a retryable placeholder; the per-item feed renders in full regardless (STRATEGY §3 Phase 4). The output artifact is keyed by researcher: each researcher carries a `feed` array (the per-item contract above) and a `feed_summary` object.

### Model-call estimate

The pipeline uses the **Message Batches API** for council deliberations, **one deliberation request per (researcher, paper) pair**. Multiplying through every level: **3 researchers × 10 papers = 30 council calls**, submitted as batches (latency-insensitive by design, well within Batches API rate limits), **plus one post-decision `feed_summary` call per researcher = 3 calls**: **33 model calls total per run.** No nesting beyond this — a single structured response per pair carries the full council deliberation, decision fields, reason, and per-component/subfield explanations (no per-component sub-calls). The three feed_summary calls are issued *after* each researcher's council batch completes and *after* that feed is sorted. **Cap check:** the test-data sizing budget keeps runtime under ~5 min and burst under the rate ceiling; 33 batched calls clears that comfortably. REQUIREMENTS.md does not specify a numeric call/budget cap; the 33-call total is stated here as the concrete pipeline cost. Should REQUIREMENTS later introduce a cap, this is the value to verify against it.

---

## 2c. Call Ordering (architectural, enforced in code)

Per STRATEGY §1 and §3 Phase 2A/2B, call ordering is architectural, not incidental. **Per researcher:**

1. **Council deliberates the full 10-paper set first** — the batch of per-pair deliberation calls decides relevance. Each call receives the researcher's profile (`description`, `research_interests`, `topics`), the researcher's **research components with `source_paper_ids` provenance**, the researcher's **selected subfields**, and the candidate paper's **abstract** and metadata (never title-only; subfield match an explicit factor).
2. **Sort runs second** (deterministic) — the feed is ordered by `relevance_score` descending, tie-break `council_confidence` desc, then `publication_date` recency. This is a pure sort over completed council outputs; it makes no relevance decision.
3. **`feed_summary` runs third** — takes the decided, sorted feed as input. It is **not** a peer of the council batch and **must not** be issued before the council has finished that researcher's set and the sort has produced an order.

This ordering is enforced in code in `orchestrator.ts`: the summary call is unreachable before that researcher's council batch completes and the feed is sorted. The summary is never issued before the council decisions exist.

---

## 3. First Slice (smallest end-to-end)

Per template stage gates, adapted for the council build:

1. **Slice 0 — INPUT gate.** All five fixtures exist and validate against their field contracts (Ajv); cross-file id joins resolve orphan-free; per researcher, coverage roles honored (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread); every paper carries a populated abstract, every component a populated `source_paper_ids`, every researcher populated `description` / `research_interests` / `topics`; scale confirmed (3 researchers, 30 distinct papers, 30 feed_items, no cross-researcher reuse); all `publication_date` in-window; synthetic IDs obviously synthetic. `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes.
2. **First runnable slice:** `run.ts` → `subagent.ts` (council deliberation call for **one** (researcher, paper) pair) → `sequencer.ts` (sort that one-item feed) → `eval.ts` (schema gate) → write OUTPUT for that one pair.
3. Defer the full 30-pair batch, the per-researcher feed_summary calls, the substantive-vs-superficial ambiguous-case verification, coverage-role and no-drop assertions, and degraded-state handling until the one-pair path runs clean end-to-end.
4. **OUTPUT gate.** `public/output_data.json` validates against the output schema before the dashboard slice begins.
5. Dashboard is the final phase. It renders finalized output only.

---

## 4. New Dependencies

| Dependency | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic Message Batches API client (per-pair council deliberations) + per-researcher feed_summary calls |
| `ajv` | JSON Schema validation (five input fixtures + per-item output contract + feed_summary contract) |
| `typescript` + `tsx` (or `ts-node`) | Type-safe build per STRATEGY §2; run `.ts` directly |
| `weave` | Per-call observability; auto-instruments the Anthropic SDK; `@weave.op()` on council orchestration + every eval assertion (STRATEGY §2) |
| `wandb` | Per-run observability; one run per fixture/prompt iteration (STRATEGY §2) |

No other runtime dependencies. Styling is hand-authored CSS (STRATEGY §2). No production-pipeline libraries (OpenAlex/arXiv/embeddings explicitly out of scope).

---

## 5. Component Architecture

### Compute layer (deterministic, presentation-order only — NO relevance logic)

1. **sequencer.ts** — pure function, **LLM-free, ordering only.** Takes a researcher's 10 feed items *after the council has decided them*, returns the array ordered by:
   - `relevance_score` descending (the council's calibrated relevance — the only ordering signal).
   - Tie-break: `council_confidence` descending, then `publication_date` recency. A presentation-stability rule, not a relevance judgment.
   - Assigns the `position` label per item.
   - **No admission filter:** `relevance_decision: false` items are retained and ordered at their score position (no-silent-drop, STRATEGY §2a, §3 Phase 1).
   - **Recency gate, not ranking signal:** a window-eligibility assertion (2025-12-06 → 2026-06-06) verifies all fixtures are in-window; age within the window only ever serves as a final tie-break, never as a relevance signal.
   - **No relevance decision, no numeric admission threshold, no "component cleared" constant, no action mapping.** These v2 constructs are deleted (STRATEGY §2a, §6). The sequencer makes a *display order* and nothing more.
   - **`paper_id` independent of `researcher_id`:** the sort operates per researcher over explicit id-joined items; no logic assumes a paper belongs to exactly one researcher (STRATEGY §3 Phase 1).
   - Fully unit-tested for order stability, tie-break correctness, and the no-drop behavior.

2. **join.ts** — pure function, **LLM-free.** Implements the explicit, mechanical id-join: `feed_items.researcher_id` / `.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id` all resolve against their parents. The join is never inferred — asserts no orphans. By explicit id only; no single-ownership assumption for papers (STRATEGY §3 Phase 1).

### Pipeline layer

3. **orchestrator.ts** — sequences the run **per researcher**: invokes `join.ts` (deterministic) → fans out the council deliberation batch over that researcher's 10 papers via the subagent → sorts via `sequencer.ts` → issues the post-decision `feed_summary` call against the sorted feed → assembles per-item records (overwriting fixture seed decision fields with runtime council values, §1a) → runs eval → hands the validated artifact (per-researcher `feed` arrays + `feed_summary` objects) to `run.ts` for writing. Enforces the §2c call ordering in code: the summary call is unreachable before that researcher's council batch completes and the feed is sorted. The council orchestration functions are decorated `@weave.op()` (STRATEGY §3 Phase 2A).

4. **subagent.ts** — wraps the Anthropic Message Batches API (per-pair council deliberations) and the single per-researcher feed_summary call. Submits one deliberation request per (researcher, paper) pair, polls for completion, parses structured responses; issues each feed_summary as one post-decision call. Anthropic client initialized with `maxRetries: 3`. Each deliberation call receives the researcher's profile, components (with `source_paper_ids`), selected subfields, and the candidate paper's abstract + metadata — **never title-only.** The subagent does not decide ordering; it returns the council's decision fields, which the sequencer then sorts.

### Skills

5. **skills/council.ts** — the primary (and only) skill. Exports the four-part skill contract:
   - `name`: `"relevance-council"`.
   - `systemPrompt`: guidance + output schema for the council's structured decision. Includes:
     - The **decision instruction**: produce `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason`, and the full multi-voice `council_deliberation` record.
     - The **substantive-vs-superficial instruction**: the council must distinguish substantive advancement of a research thread from surface keyword overlap; a paper whose apparent match overstates its true relevance must be **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test — deliberation must show real reasoning, not a coin flip (STRATEGY §3 Phase 2A, §4 risk row).
     - The **explicit-factors instruction**: the council weighs component match, **subfield match** (an explicit factor), focus match, and the substantive-vs-superficial test — each a consideration *inside deliberation*, never a numeric gate.
     - The **grounding instruction**: reasoning is grounded in the abstract and matched-component `source_paper_ids` provenance and the researcher's selected subfields — never inferred from the title alone. Accepted items must emit populated `matched_components[].match_explanation`, `source_paper_ids`, and `matched_subfields` (eval-locked, §5).
   - `tools`: `[]` (none — structured deliberation generation).
   - `successCriteria.validate`: asserts all five council fields present and well-formed per pair; asserts the ambiguous coverage-role paper carries non-trivial substantive-vs-superficial deliberation; asserts subfield match is weighed where applicable.

   **No guardrail skill.** Per §0, the escalate-only guardrail has no referent: there is no urgency enum to ratchet — only a relevance decision to argue. The council's own multi-voice deliberation and argue-down discipline, recorded in `council_deliberation` and traced in Weave, are the internal conservative check. The honesty requirement is enforced by the council prompt + the deterministic eval check below, not a two-pass guardrail.

### Eval

6. **eval.ts** — gates, aggregate errors (no short-circuit). Each assertion is decorated `@weave.op()` so it appears in the Weave trace tree (STRATEGY §3 Phase 2A/5):
   - `validateSchema` — every fixture validates against its field contract (Ajv); every per-item output matches the per-item contract; every feed_summary matches its contract.
   - `sanityCheck`:
     - Every cross-file id reference resolves (`feed_items.researcher_id`/`.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id`) — no orphans.
     - Scale: exactly 3 researchers, 30 papers (10 distinct per researcher, **no cross-researcher reuse**), 30 feed_items.
     - Every feed_item carries all five council fields (decision, score, confidence, reason, deliberation).
     - **Grounding/subfield fields populated per accepted item:** every `relevance_decision: true` item carries ≥1 `matched_components` entry with a populated `match_explanation` and a populated `source_paper_ids` provenance, and a populated `matched_subfields` — locking the grounding instruction and the subfield-as-explicit-factor requirement end-to-end (STRATEGY §3 Phase 2A; §2.1 field provenance).
     - Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous).
     - **Substantive-vs-superficial reasoning present** in `council_deliberation` for the ambiguous case — apparent overstatements argued down, not rubber-stamped (STRATEGY §3 Phase 2A exit).
     - **Display order matches `relevance_score`-descending sort** (tie-break confidence, then recency), recomputed and compared.
     - **No-silent-drop:** every `relevance_decision: false` item present at its score position; no feed_item dropped or hidden.
     - `feed_summary` present per researcher (or its degraded state).
     - **Recency window assertion** — all fixtures in-window.
     - **Runtime-canonical, no fixture-equality check (§1a):** eval validates the *runtime* council fields for presence, well-formedness, and internal consistency; it **never** asserts runtime output equals the fixture-provided seed decisions — divergence is expected and not a failure.
   - On failure: errors aggregated and reported; OUTPUT not written.

### Log trace & observability

7. **logger.ts** — JSONL trace per run, `traceId` threaded through orchestrator → subagent → eval. Records batch submission, completion, feed_summary calls, eval results. Subordinate to the Weave/W&B observability stack (§0a), which is the primary instrumentation surface and the load-bearing audit trail.

### Application entry

8. **run.ts** — CLI entry. `node --import tsx src/run.ts [data/feed_items.json]`. Calls `weave.init` once at startup before any LLM call (§0a). On a clean run (eval gates pass), writes `public/output_data.json`, logs the W&B run (Phase 5), and exits. On eval failure, writes nothing and reports.

### Degraded-state handling (Phase 4)

9. **Degraded-state contract** — not a separate file but a cross-cutting behavior in `subagent.ts` + `orchestrator.ts`:
   - A feed item whose **council decision** could not be produced renders at a **conservative position** with `decision_status: "unavailable"` and an explicit "decision unavailable — retry" state.
   - Malformed model JSON for a pair is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `decision_status: "malformed"`.
   - **feed_summary failure is independent:** if a researcher's summary call fails, that researcher's per-item feed still renders in full; the summary region carries `summary_status: "unavailable"` (or `"malformed"`). The summary is never a single point of failure for the whole feed (STRATEGY §3 Phase 4).
   - No feed item is ever silently dropped or blanked — a decision failure renders a retryable placeholder at a conservative position, not an empty panel.

---

## 6. Dashboard Architecture

Four files with explicit responsibilities. The server validates the OUTPUT artifact at startup; if validation fails, the dashboard does not start. No partial-success state.

10. **dash-app-server.ts** — Node/Express. Reads `public/output_data.json`, validates it against the output schema (per-researcher `feed` arrays + `feed_summary` objects), exposes API endpoints to the client. The only component that touches the data file. ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server only starts when run directly, not when imported in tests.

11. **dash-app-client.ts** — consumes the server's API endpoints. Never reads the data file directly. Holds all rendering, researcher selection, feed-item selection, expansion, and scroll logic, including the feed summary region and its independent degraded state.

12. **dash-app.html** — markup only. No inline styles. No inline scripts beyond loading the client module.

13. **dash-app.css** — external stylesheet. Editorial visual treatment (dark background, bright legible type, serif paper titles) per STRATEGY §3 Phase 3 — a core deliverable, not deferred. No styling lives in HTML or JS.

---

## 7. Dashboard Layout Invariants

- **Panel structure:** two-panel (left feed, right detail) per STRATEGY §3 Phase 3.
- **Researcher selector:** 3 researchers selectable. **Default selection: first researcher, top-ranked feed item** (STRATEGY §3 Phase 3 exit).
- **Feed summary region:** rendered at the **top of the left panel**, above the ranked list — its own region with its own degraded state (STRATEGY §3 Phase 3). When `summary_status` ≠ `ok`, it shows "summary unavailable — retry" while the per-item list renders in full.
- **Left panel list:** lists the selected researcher's 10 feed items in `relevance_score` order (position 1→10), top to bottom, selectable, below the summary region. Each item shows position, title, top matched component label, and the council's `relevance_decision` (accept/reject visibly distinct). **Position 1 selected by default on load** (STRATEGY §3 Phase 3 exit).
- **Right panel:** displays the detail sub-sections for the selected feed item — `relevance_reason`, `relevance_decision`, `council_confidence`, the **inspectable `council_deliberation`**, matched component(s), and the researcher's matched subfield(s). A **researcher profile view** surfaces the researcher's selected subfields (`research_subfield_preferences`).
- **No-silent-drop in the UI:** items with `relevance_decision: false` render at their `relevance_score` position with reject reasoning visible — the demo shows the council *declining*, not only accepting (STRATEGY §3 Phase 3 exit).
- **Default expansion:** all right-panel sub-sections load **collapsed to their label** (STRATEGY §3 Phase 3 exit).
- **Independent scroll:** both panels scroll independently.
- **Collapsed minimum height:** fixed minimum height sufficient to show the section label.