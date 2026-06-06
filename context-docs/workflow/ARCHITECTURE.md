# ARCHITECTURE.md

## Atomic Research — Paper Relevance Feed: Component Architecture

This document specifies what components exist and how they wire together. It executes STRATEGY.md; it does not relitigate decisions made there (model ID, deterministic ranking, degraded-state contract, the 0.60 threshold constant, two-stage LLM call ordering, the two-threshold model in §2a).

---

## 0. Architectural Confirmation & Adjustment

The agentic-harness template assumes the LLM produces the consequential judgment (triage, scoring, classification) and a guardrail enforces conservative bias on that judgment. **This scenario inverts that assumption.** Here:

- **Ranking and recommended action are deterministic, LLM-free pure functions** over frozen fixtures (STRATEGY §1, §3 Phase 1).
- **The LLM produces only explanatory prose** — three rationale types per paper, plus the post-ranking feed summary. It never decides rank or action.

Consequently, the architecture **adapts the template** as follows:

| Template component | Disposition in this build |
|---|---|
| orchestrator.js | **Kept**, adapted — sequences deterministic compute → batch LLM call → post-ranking summary call → assembly. Does not fan out one subagent per case. |
| subagent.js | **Kept**, adapted — wraps the Anthropic Batches API (per-paper rationales) and a single post-ranking call (feed summary), not a per-case tool-use loop. |
| skills/primary.js | **Kept**, adapted — the rationale-generation skill (prose only, no ranking). |
| skills/guardrail.js | **Dropped.** No consequential LLM judgment to wrap. The honesty requirement (PAP-07 tangential flag) is a prompt instruction + deterministic verification check, not a two-pass escalate-only guardrail. The escalate-only invariant has no referent when the LLM decides nothing. |
| skills/sequencer.js | **Kept as a pure function, LLM-free.** The domain verb (rank) implies ordering, but ordering is mechanical here. This is `sequencer.ts` in the compute layer, not a skill. |
| eval.js | **Kept** — schema gate + sanity checks (rank stability, action-mapping correctness, PAP-07 tangential flag present, PAP-02 breadth framing, missing-info note presence). |
| memory.js | **Dropped for v1.** Batch call with deterministic retry; no per-case failure-context replay needed. Degraded-state contract (Phase 4) handles failure surfacing instead. |
| logger.js | **Kept**, but **subordinate to the observability stack.** Weave (per-call) + W&B (per-run) are the primary instrumentation surface per STRATEGY §2; `logger.ts` provides a local JSONL trace alongside them. |

This is a deliberate, documented divergence. The guardrail spec does not apply because no LLM judgment is consequential.

## 0a-a. Docker

Put the application in docker sandbox container so that its is secure and claude code has to operate in that sandbox. build all docker components first. 

---

## 0a. Observability Stack (cross-cutting, wired Phase 0)

Per STRATEGY §2 and §3, observability is a phase, not an afterthought. It is wired before any LLM call and decorated through Phase 2/5.

- **Weave (per-call).** `weave.init("<team>/atomic-research")` is called once at pipeline startup (`run.ts`), before any Anthropic call. It auto-instruments the Anthropic SDK so every per-paper rationale call and the feed_summary call appear in the trace tree. Team functions — the depth/breadth framing logic and every eval assertion — are decorated `@weave.op()` so they appear in the same trace tree as the SDK calls.
- **W&B (per-run).** One `wandb` run per fixture/prompt iteration logs the pipeline-level aggregate: ranked output, component-similarity distributions, batch-call metadata (latency, token count, per-paper rationale status), and eval pass/fail results (Phase 5).
- **Secrets.** `WANDB_API_KEY` is read from a gitignored `.env`; confirmed in `.gitignore` before any commit. Never hardcoded, never committed.
- **Cross-reference.** The Weave trace tree and the W&B run reference the same iteration (Phase 5 exit).

Application model for the built artifact's runtime calls is `claude-sonnet-4-6` (pinned snapshot, STRATEGY §2). This governs the artifact's runtime only — not the build session.

---

## 1. Pipeline Shape — Three Stages, File-Based Handoffs

Stage boundaries are files, not live connections. The pipeline writes; the server serves; the client reads.

**INPUT** — versioned fixtures at `data/researcher_profile.json` and `data/candidate_papers.json`. Built and validated before any application component is written (Slice 0 / INPUT gate). Read by the pipeline; never modified during a run. Contains one researcher profile (populated `publications` array) and 10 candidate papers with frozen `component_similarity` scores, each paper carrying a populated abstract, each component a populated `evidence` field. **All 10 fixtures are treated as pre-admitted canonical input** — the fixture set is the post-pre-filter result; no numeric feed-admission cutoff is applied (STRATEGY §2a).

**PIPELINE** — `run.ts` + orchestrator + subagent + rationale skill + deterministic sequencer + eval. Reads INPUT, produces OUTPUT. Deterministic ranking/action assignment, the per-paper batch LLM call, the post-ranking feed_summary call, schema validation, and assembly all happen here. Writes OUTPUT exactly once per run, after eval gates pass.

**OUTPUT** — single validated artifact at `public/output_data.json`. Written by `run.ts` after eval gates pass; never modified after write. The dashboard reads this file via the dashboard server.

No data flow between stages at render time. The dashboard renders finalized output; it does not score, rank, or call the LLM.

---

## 2. Output Schema

### 2.1 Per-paper contract

Proposed JSON shape for one paper in the output array. This is the per-paper output contract Ajv enforces.

```json
{
  "paper_id": "PAP-03",
  "rank": 1,
  "title": "...",
  "date": "2026-02-14",
  "max_component_similarity": 0.87,
  "recommended_action": "Read now",
  "components": [
    {
      "component": "Sparse autoencoder feature steering",
      "component_similarity": 0.87,
      "cleared": true,
      "match_explanation": "<LLM prose>"
    },
    {
      "component": "RLHF reward modeling",
      "component_similarity": 0.42,
      "cleared": false,
      "match_explanation": "<LLM prose>"
    }
  ],
  "components_cleared_count": 1,
  "relevance_rationale": "<LLM prose, depth/breadth framed>",
  "position_rationale": "<LLM prose>",
  "tangential_flag": false,
  "missing_information": "<note or 'nothing material missing'>",
  "rationale_status": "ok"
}
```

The example `date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06), consistent with the window-eligibility assertion in §5 — every fixture, including this example, is in-window.

Field provenance:

- **Deterministic (Phase 1, no LLM):** `rank`, `max_component_similarity`, `recommended_action`, `cleared`, `components_cleared_count`.
- **LLM-generated (Phase 2A):** `match_explanation` (per component), `relevance_rationale` (with depth/breadth framing), `position_rationale`.
- **`tangential_flag` — prompt instruction + verification, per STRATEGY:** STRATEGY frames the tangential-near-miss honesty requirement as a prompt instruction plus a verification check, **not** a general deterministic similarity-band classifier. The flag fires only on papers above the 0.60 floor whose fit is loose; there is no defined similarity band for "tangential," and this architecture introduces none. Accordingly: the flag is asserted in the prompt (the model must explicitly frame PAP-07's match as loose/tangential), and the eval verification check confirms **PAP-07 carries `tangential_flag === true` with tangential framing in its rationale**. The same logic can fire on any qualifying paper above the floor — PAP-07 is the canonical test case, not a special-cased paper. Absent a verified tangential framing, the flag defaults to `false`. **The flag annotates only; it never re-ranks.** A flagged paper keeps its `max(component_similarity)` position.
- **`missing_information` — rendered for every paper:** carries a note when material information is missing, or `"nothing material missing"` when not. Never null/absent for any paper (STRATEGY §3 Phase 3).
- **Degraded-state (Phase 4):** `rationale_status` ∈ `ok | unavailable | malformed`. When not `ok`, prose fields carry a retryable placeholder; deterministic fields remain valid.

### 2.2 Feed summary contract

The `feed_summary` is a separate output region, not a per-paper field. It is generated by a single post-ranking call (Phase 2B), takes the sorted top-N as input, and degrades independently.

```json
{
  "feed_summary": {
    "text": "<LLM prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. When not `ok`, the summary region shows a retryable placeholder; the per-paper feed renders in full regardless (STRATEGY §3 Phase 4). The output artifact is an object with a `papers` array (the per-paper contract above) and a `feed_summary` object.

### Model-call estimate

The pipeline uses the **Message Batches API** with **one rationale request per paper** — **10 calls** submitted as a single batch — **plus one post-ranking `feed_summary` call**: **11 model calls total per run.** No nesting (no per-component sub-calls — all three rationale types for a paper are produced in one structured response). The per-paper batch is latency-insensitive by design and well within Batches API rate limits for a 10-request submission. The feed_summary is a single additional call issued *after* the batch completes and *after* ranking exists. **Cap check:** REQUIREMENTS.md does not specify a numeric call/budget cap for this POC; the 11-call total is stated here as the concrete pipeline cost and is not bounded by any requirements-level maximum. Should REQUIREMENTS later introduce such a cap, this 11-call figure is the value to verify against it.

---

## 2c. Two-Stage LLM Call Ordering (architectural, enforced in code)

Per STRATEGY §1 and §3 Phase 2A/2B, call ordering is architectural, not incidental:

1. **Sequencer runs first** (deterministic) — produces the ranked order.
2. **Per-paper rationale batch runs second** — against the *already-sequenced* feed; each call receives `rank` and `recommended_action` as given input, plus the paper's **abstract** and the matched component's **`evidence`** field (never title-only).
3. **`feed_summary` runs third** — takes the sorted top-N as input. It is **not** a peer of the per-paper batch and **must not** be issued before the sequencer has produced an order.

This ordering is enforced in code in `orchestrator.ts`: the summary call is unreachable without a completed ranking. The summary is never issued before the per-paper batch and never before the sequence exists.

---

## 3. First Slice (smallest end-to-end)

Per template stage gates, adapted for this inverted build:

1. **Slice 0 — INPUT gate.** `data/researcher_profile.json` + `data/candidate_papers.json` exist and validate against the input schema; fixtures honor their coverage roles (must-rank-high, multi-component, mid-tier, tangential-near-miss, must-rank-low); every paper carries a populated abstract, every component a populated `evidence`, the profile a populated `publications` array. `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes.
2. **First runnable slice:** `run.ts` → `sequencer.ts` (deterministic rank + action for all 10) → `subagent.ts` (batch call for **one** paper's rationale) → `eval.ts` (schema gate) → write OUTPUT for that one paper.
3. Defer the full 10-paper batch, the feed_summary call, the PAP-07 tangential verification, the PAP-02 breadth framing, and degraded-state handling until the one-paper path runs clean end-to-end.
4. **OUTPUT gate.** `public/output_data.json` validates against the output schema before the dashboard slice begins.
5. Dashboard is the final phase. It renders finalized output only.

---

## 4. New Dependencies

| Dependency | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic Message Batches API client (per-paper) + single feed_summary call |
| `ajv` | JSON Schema validation (input fixtures + per-paper output contract + feed_summary contract) |
| `typescript` + `tsx` (or `ts-node`) | Type-safe build per STRATEGY §2; run `.ts` directly |
| `weave` | Per-call observability; auto-instruments the Anthropic SDK; `@weave.op()` on team functions (STRATEGY §2) |
| `wandb` | Per-run observability; one run per fixture/prompt iteration (STRATEGY §2) |

No other runtime dependencies. Styling is hand-authored CSS (STRATEGY §2). No production-pipeline libraries (OpenAlex/arXiv/embeddings explicitly out of scope).

---

## 5. Component Architecture

### Compute layer (deterministic, LLM-free)

1. **sequencer.ts** — pure function. Takes the 10 candidate papers with frozen scores, returns the ranked array with `rank`, `max_component_similarity`, `recommended_action`, `cleared` per component, and `components_cleared_count`. Implements:
   - `max(component_similarity)` ranking.
   - Two-stage tie-break: (1) more components with `component_similarity ≥ 0.60`, (2) more recent date.
   - **Recency gate, not ranking signal:** a window-eligibility assertion (2025-12-06 → 2026-06-06) verifies all fixtures are in-window; age within the window never changes rank (STRATEGY §3 Phase 1).
   - Recommended-action mapping: `≥ 0.80 → Read now`, `≥ 0.60 && < 0.80 → Save`, `< 0.60 → Skip`. These cutoffs are **strategy-originated design decisions, not requirements-derived** (STRATEGY §2a, Phase 1).
   - `THRESHOLD = 0.60` as a single code constant — the **"component cleared" threshold, not the feed-admission gate** (STRATEGY §2a). It governs only multi-component reporting and tie-break stage (1). All 10 fixtures appear regardless of whether they clear any component at 0.60.
   - Fully unit-tested for order stability, action-mapping correctness, and tie-break/multi-component cases.
   - **Note:** `tangential_flag` is *not* set here. There is no deterministic similarity band for tangentiality (see §2.1); the flag is driven by the prompt + verified at eval for PAP-07, defaulting to `false` otherwise.

### Pipeline layer

2. **orchestrator.ts** — sequences the run: invokes `sequencer.ts` (deterministic) → passes the ranked array into the batch rationale call → issues the post-ranking `feed_summary` call against the sorted top-N → assembles per-paper records merging deterministic fields with LLM prose → runs eval → hands the validated artifact (papers + feed_summary) to `run.ts` for writing. Enforces the §2c call ordering in code: the summary call is unreachable without a completed ranking and a completed per-paper batch. Does **not** fan out per-case subagents; the batch API handles the 10 requests in one submission.

3. **subagent.ts** — wraps the Anthropic Message Batches API (per-paper) and the single feed_summary call. Submits one rationale request per paper (10 in a batch), polls for completion, parses structured responses; issues the feed_summary as one post-ranking call. Anthropic client initialized with `maxRetries: 3`. Receives `rank` and `recommended_action` as **given input** — never asked to decide them. Each per-paper call receives the paper's abstract and matched-component `evidence` (never title-only).

### Skills

4. **skills/rationale.ts** — the primary (and only) skill. Exports the four-part skill contract:
   - `name`: `"rationale-generation"`.
   - `systemPrompt`: guidance + output schema for the three rationale types (per-component match explanation, relevance rationale, per-position rationale). Includes:
     - The **tangential-honesty instruction**: PAP-07's loose/tangential match (above the 0.60 floor) must be explicitly flagged as such; the model must not overstate it (STRATEGY §3 Phase 2A, §4 risk row).
     - The **depth/breadth instruction**: the prompt must explicitly distinguish *depth* (strong single-thread match) from *breadth* (cross-component relevance), so a breadth paper (e.g. PAP-02) has its multi-thread relevance explained and its rank is not misread as pure depth (STRATEGY §3 Phase 2A). The depth/breadth framing logic is decorated `@weave.op()`.
     - The **grounding instruction**: rationale is grounded in the abstract and matched-component `evidence` — never inferred from the title alone.
   - `tools`: `[]` (none — pure prose generation).
   - `successCriteria.validate`: asserts all three rationale types present and non-empty per paper; asserts PAP-07 rationale carries the tangential framing; asserts PAP-02 carries depth/breadth framing.

   **No guardrail skill.** Per §0, the escalate-only guardrail has no referent: the LLM decides no rank and no action. The honesty requirement is enforced by prompt instruction + the deterministic eval check below, not a two-pass guardrail.

### Eval

5. **eval.ts** — gates, aggregate errors (no short-circuit). Each assertion is decorated `@weave.op()` so it appears in the Weave trace tree (STRATEGY §3 Phase 2A/5):
   - `validateSchema` — every paper matches the per-paper output contract and the feed_summary matches its contract (Ajv).
   - `sanityCheck`:
     - All 10 papers ranked 1–10, no gaps, no duplicates.
     - Rank order matches the deterministic rule (recomputed and compared).
     - Recommended-action mapping correct for every paper (recomputed and compared).
     - `components_cleared_count` matches count of components with `component_similarity ≥ 0.60`.
     - **PAP-07 `tangential_flag === true`** and its rationale carries the tangential framing (STRATEGY §3 Phase 2A exit). The flag annotates without changing PAP-07's score-determined position.
     - **PAP-02 carries breadth framing** in its relevance rationale (STRATEGY §3 Phase 2A exit).
     - **Missing-info note present on every paper** (note or `"nothing material missing"`).
     - **Every paper (including `Skip`-actioned PAP-10) renders full per-paper output** — no paper dropped or hidden.
     - **Recency window assertion** — all fixtures in-window.
   - On failure: errors aggregated and reported; OUTPUT not written.

### Log trace & observability

6. **logger.ts** — JSONL trace per run, `traceId` threaded through orchestrator → subagent → eval. Records batch submission, completion, feed_summary call, eval results. Subordinate to the Weave/W&B observability stack (§0a), which is the primary instrumentation surface.

### Application entry

7. **run.ts** — CLI entry. `node --import tsx src/run.ts [data/candidate_papers.json]`. Calls `weave.init` once at startup before any LLM call (§0a). On a clean run (eval gates pass), writes `public/output_data.json`, logs the W&B run (Phase 5), and exits. On eval failure, writes nothing and reports.

### Degraded-state handling (Phase 4)

8. **Degraded-state contract** — not a separate file but a cross-cutting behavior in `subagent.ts` + `orchestrator.ts`:
   - Malformed model JSON for a paper is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `rationale_status: "malformed"`.
   - Missing/unavailable rationale → `rationale_status: "unavailable"`.
   - **feed_summary failure is independent:** if the summary call fails, the per-paper feed still renders in full; the summary region carries `summary_status: "unavailable"` (or `"malformed"`). The headline is never a single point of failure for the whole feed (STRATEGY §3 Phase 4).
   - Deterministic fields (rank, action) always remain valid — a rationale failure never drops a paper or blanks a panel.
   - The paper renders at its correct rank with a retryable placeholder in prose fields.

---

## 6. Dashboard Architecture

Four files with explicit responsibilities. The server validates the OUTPUT artifact at startup; if validation fails, the dashboard does not start. No partial-success state.

9. **dash-app-server.ts** — Node/Express. Reads `public/output_data.json`, validates it against the output schema (papers + feed_summary), exposes API endpoints to the client. The only component that touches the data file. ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server only starts when run directly, not when imported in tests.

10. **dash-app-client.ts** — consumes the server's API endpoints. Never reads the data file directly. Holds all rendering, selection, expansion, and scroll logic, including the feed summary region and its independent degraded state.

11. **dash-app.html** — markup only. No inline styles. No inline scripts beyond loading the client module.

12. **dash-app.css** — external stylesheet. Editorial visual treatment (dark background, bright legible type, serif paper titles) per STRATEGY §3 Phase 3 — a core deliverable, not deferred. No styling lives in HTML or JS.

---

## 7. Dashboard Layout Invariants

- **Panel structure:** two-panel (left feed, right detail) per STRATEGY §3 Phase 3.
- **Feed summary region:** rendered at the **top of the left panel**, above the ranked list — its own region with its own degraded state (STRATEGY §3 Phase 3). When `summary_status` ≠ `ok`, it shows "summary unavailable — retry" while the per-paper list renders in full.
- **Left panel list:** lists all 10 papers in sequencer rank order (1→10), top to bottom, selectable, below the summary region. Each item shows rank, title, top matched component label, recommended action. **Position 1 selected by default on load** (STRATEGY §3 Phase 3 exit).
- **Right panel:** displays the detail sub-sections for the selected paper — component match(es) + per-component similarity, relevance rationale (with depth/breadth framing), tangential flag if present, recommended action, missing-information note (always present), per-position rationale.
- **Default expansion:** all right-panel sub-sections load **collapsed to their label** (STRATEGY §3 Phase 3 exit).
- **Independent scroll:** both panels scroll independently.
- **Collapsed minimum height:** fixed min


