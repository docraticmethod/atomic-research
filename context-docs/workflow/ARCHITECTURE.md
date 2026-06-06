# ARCHITECTURE.md

## Atomic Research — Paper Relevance Feed: Component Architecture

This document specifies what components exist and how they wire together. It executes STRATEGY.md; it does not relitigate decisions made there (model ID, deterministic ranking, degraded-state contract, the 0.60 threshold constant).

---

## 0. Architectural Confirmation & Adjustment

The agentic-harness template assumes the LLM produces the consequential judgment (triage, scoring, classification) and a guardrail enforces conservative bias on that judgment. **This scenario inverts that assumption.** Here:

- **Ranking and recommended action are deterministic, LLM-free pure functions** over frozen fixtures (STRATEGY §1, §3 Phase 1).
- **The LLM produces only explanatory prose** — three rationale types per paper. It never decides rank or action.

Consequently, the architecture **adapts the template** as follows:

| Template component | Disposition in this build |
|---|---|
| orchestrator.js | **Kept**, adapted — sequences deterministic compute → batch LLM call → assembly. Does not fan out one subagent per case. |
| subagent.js | **Kept**, adapted — wraps the Anthropic Batches API, not a per-case tool-use loop. |
| skills/primary.js | **Kept**, adapted — the rationale-generation skill (prose only, no ranking). |
| skills/guardrail.js | **Dropped.** No consequential LLM judgment to wrap. The honesty requirement (PAP-07 tangential flag) is a prompt instruction + deterministic verification check, not a two-pass escalate-only guardrail. The escalate-only invariant has no referent when the LLM decides nothing. |
| skills/sequencer.js | **Kept as a pure function, LLM-free.** The domain verb (rank) implies ordering, but ordering is mechanical here. This is `sequencer.ts` in the compute layer, not a skill. |
| eval.js | **Kept** — schema gate + sanity checks (rank stability, action-mapping correctness, PAP-07 tangential flag present). |
| memory.js | **Dropped for v1.** Batch call with deterministic retry; no per-case failure-context replay needed. Degraded-state contract (Phase 4) handles failure surfacing instead. |
| logger.js | **Kept** — JSONL trace per run. |

This is a deliberate, documented divergence. The guardrail spec does not apply because no LLM judgment is consequential.

---

## 1. Pipeline Shape — Three Stages, File-Based Handoffs

Stage boundaries are files, not live connections. The pipeline writes; the server serves; the client reads.

**INPUT** — versioned fixtures at `data/researcher_profile.json` and `data/candidate_papers.json`. Built and validated before any application component is written (Slice 0 / INPUT gate). Read by the pipeline; never modified during a run. Contains one researcher profile and 10 candidate papers with frozen `component_similarity` scores.

**PIPELINE** — `run.ts` + orchestrator + subagent + rationale skill + deterministic sequencer + eval. Reads INPUT, produces OUTPUT. Deterministic ranking/action assignment, the single batch LLM call, schema validation, and assembly all happen here. Writes OUTPUT exactly once per run, after eval gates pass.

**OUTPUT** — single validated artifact at `public/output_data.json`. Written by `run.ts` after eval gates pass; never modified after write. The dashboard reads this file via the dashboard server.

No data flow between stages at render time. The dashboard renders finalized output; it does not score, rank, or call the LLM.

---

## 2. Output Schema (per paper)

Proposed JSON shape for one paper in the output array. This is the per-paper output contract Ajv enforces.

```json
{
  "paper_id": "PAP-03",
  "rank": 1,
  "title": "...",
  "date": "2024-11-02",
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
  "relevance_rationale": "<LLM prose>",
  "position_rationale": "<LLM prose>",
  "tangential_flag": false,
  "missing_information": "<note or null>",
  "rationale_status": "ok"
}
```

Field provenance:

- **Deterministic (Phase 1, no LLM):** `rank`, `max_component_similarity`, `recommended_action`, `cleared`, `components_cleared_count`.
- **LLM-generated (Phase 2):** `match_explanation` (per component), `relevance_rationale`, `position_rationale`.
- **`tangential_flag` — prompt instruction + verification, per STRATEGY:** STRATEGY frames the tangential-near-miss honesty requirement as a prompt instruction plus a verification check, **not** a general deterministic similarity-band classifier. There is no defined similarity band for "tangential," and this architecture introduces none. Accordingly: the flag is asserted in the prompt (the model must explicitly frame PAP-07's match as loose/tangential), and the eval verification check confirms **PAP-07 carries `tangential_flag === true` with tangential framing in its rationale**. No general band rule is applied to other papers; absent a verified tangential framing, the flag defaults to `false`.
- **Degraded-state (Phase 4):** `rationale_status` ∈ `ok | unavailable | malformed`. When not `ok`, prose fields carry a retryable placeholder; deterministic fields remain valid.

### Model-call estimate

The pipeline uses the **Message Batches API** with **one rationale request per paper**: **10 model calls total**, submitted as a single batch. No nesting (no per-component sub-calls — all three rationale types for a paper are produced in one structured response). This is latency-insensitive by design and well within Batches API rate limits for a 10-request submission. (REQUIREMENTS.md owns any explicit numeric cap; the cap value is not reproduced here to avoid asserting an unverifiable figure — the 10-call total is stated as the concrete pipeline cost.)

---

## 3. First Slice (smallest end-to-end)

Per template stage gates, adapted for this inverted build:

1. **Slice 0 — INPUT gate.** `data/researcher_profile.json` + `data/candidate_papers.json` exist and validate against the input schema. No application component before this passes.
2. **First runnable slice:** `run.ts` → `sequencer.ts` (deterministic rank + action for all 10) → `subagent.ts` (batch call for **one** paper's rationale) → `eval.ts` (schema gate) → write OUTPUT for that one paper.
3. Defer the full 10-paper batch, the PAP-07 tangential verification, and degraded-state handling until the one-paper path runs clean end-to-end.
4. **OUTPUT gate.** `public/output_data.json` validates against the output schema before the dashboard slice begins.
5. Dashboard is the final phase. It renders finalized output only.

---

## 4. New Dependencies

| Dependency | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic Message Batches API client |
| `ajv` | JSON Schema validation (input fixtures + per-paper output contract) |
| `typescript` + `tsx` (or `ts-node`) | Type-safe build per STRATEGY §2; run `.ts` directly |

No other runtime dependencies. Styling is hand-authored CSS (STRATEGY §2). No production-pipeline libraries (OpenAlex/arXiv/embeddings explicitly out of scope).

---

## 5. Component Architecture

### Compute layer (deterministic, LLM-free)

1. **sequencer.ts** — pure function. Takes the 10 candidate papers with frozen scores, returns the ranked array with `rank`, `max_component_similarity`, `recommended_action`, `cleared` per component, and `components_cleared_count`. Implements:
   - `max(component_similarity)` ranking.
   - Two-stage tie-break: (1) more components with `component_similarity ≥ 0.60`, (2) more recent date.
   - Recommended-action mapping: `≥ 0.80 → Read now`, `≥ 0.60 && < 0.80 → Save`, `< 0.60 → Skip`.
   - `THRESHOLD = 0.60` as a single code constant (STRATEGY §1 Phase 1). Not tunable.
   - Fully unit-tested for order stability and action-mapping correctness.
   - **Note:** `tangential_flag` is *not* set here. There is no deterministic similarity band for tangentiality (see §2); the flag is driven by the prompt + verified at eval for PAP-07, defaulting to `false` otherwise.

### Pipeline layer

2. **orchestrator.ts** — sequences the run: invokes `sequencer.ts` (deterministic), passes the ranked array into the batch rationale call, assembles per-paper records merging deterministic fields with LLM prose, runs eval, hands the validated array to `run.ts` for writing. Does **not** fan out per-case subagents; the batch API handles the 10 requests in one submission.

3. **subagent.ts** — wraps the Anthropic Message Batches API. Submits one rationale request per paper (10 in a batch), polls for completion, parses structured responses. Anthropic client initialized with `maxRetries: 3`. Receives `rank` and `recommended_action` as **given input** — never asked to decide them.

### Skills

4. **skills/rationale.ts** — the primary (and only) skill. Exports the four-part skill contract:
   - `name`: `"rationale-generation"`.
   - `systemPrompt`: guidance + output schema for the three rationale types (per-component match explanation, relevance rationale, per-position rationale). Includes the **tangential-honesty instruction**: PAP-07's loose/tangential match must be explicitly flagged as such; the model must not overstate it (STRATEGY §3 Phase 2, §4 risk row).
   - `tools`: `[]` (none — pure prose generation).
   - `successCriteria.validate`: asserts all three rationale types present and non-empty per paper; asserts PAP-07 rationale carries the tangential framing.

   **No guardrail skill.** Per §0, the escalate-only guardrail has no referent: the LLM decides no rank and no action. The honesty requirement is enforced by prompt instruction + the deterministic eval check below, not a two-pass guardrail.

### Eval

5. **eval.ts** — gates, aggregate errors (no short-circuit):
   - `validateSchema` — every paper matches the per-paper output contract (Ajv).
   - `sanityCheck`:
     - All 10 papers ranked 1–10, no gaps, no duplicates.
     - Rank order matches the deterministic rule (recomputed and compared).
     - Recommended-action mapping correct for every paper (recomputed and compared).
     - `components_cleared_count` matches count of components with `component_similarity ≥ 0.60`.
     - **PAP-07 `tangential_flag === true`** and its rationale carries the tangential framing (STRATEGY §3 Phase 2 exit). This is the verification check that backs the prompt-driven tangential requirement — there is no general band rule to recompute.
   - On failure: errors aggregated and reported; OUTPUT not written.

### Log trace

6. **logger.ts** — JSONL trace per run, `traceId` threaded through orchestrator → subagent → eval. Records batch submission, completion, eval results.

### Application entry

7. **run.ts** — CLI entry. `node --import tsx src/run.ts [data/candidate_papers.json]`. On a clean run (eval gates pass), writes `public/output_data.json` and exits. On eval failure, writes nothing and reports.

### Degraded-state handling (Phase 4)

8. **Degraded-state contract** — not a separate file but a cross-cutting behavior in `subagent.ts` + `orchestrator.ts`:
   - Malformed model JSON for a paper is caught, logged, and surfaced as `rationale_status: "malformed"`.
   - Missing/unavailable rationale → `rationale_status: "unavailable"`.
   - Deterministic fields (rank, action) always remain valid — a rationale failure never drops a paper or blanks a panel.
   - The paper renders at its correct rank with a retryable placeholder in prose fields.

---

## 6. Dashboard Architecture

Four files with explicit responsibilities. The server validates the OUTPUT artifact at startup; if validation fails, the dashboard does not start. No partial-success state.

9. **dash-app-server.ts** — Node/Express. Reads `public/output_data.json`, validates it against the output schema, exposes API endpoints to the client. The only component that touches the data file. ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server only starts when run directly, not when imported in tests.

10. **dash-app-client.ts** — consumes the server's API endpoints. Never reads the data file directly. Holds all rendering, selection, expansion, and scroll logic.

11. **dash-app.html** — markup only. No inline styles. No inline scripts beyond loading the client module.

12. **dash-app.css** — external stylesheet. Editorial visual treatment (dark theme, serif titles) per STRATEGY §3 Phase 3. No styling lives in HTML or JS.

---

## 7. Dashboard Layout Invariants

- **Panel structure:** two-panel (left feed, right detail) per STRATEGY §3 Phase 3.
- **Left panel:** lists all 10 papers in sequencer rank order (1→10), top to bottom, selectable. **Position 1 selected by default on load** (STRATEGY §3 Phase 3 exit).
- **Right panel:** displays the detail sub-sections for the selected paper — component match(es) + per-component similarity, relevance rationale, recommended action, missing-information note, per-position rationale.
- **Default expansion:** all right-panel sub-sections load **collapsed to their label** (STRATEGY §3 Phase 3 exit).
- **Independent scroll:** both panels scroll independently.
- **Collapsed minimum height:** fixed minimum height sufficient to show the section label.
- **Degraded-state rendering:** a paper with `rationale_status` ≠ `ok` still renders at its correct rank; prose sections show the retryable placeholder, never a blank panel (STRATEGY §3 Phase 4).

---

## 8. Build Order Summary

| Phase | Components | Gate |
|---|---|---|
| **0 — Scaffold & fixtures** | `data/*.json`, input schema, output schema, Ajv wired | Fixtures load + validate; malformed entry rejected (INPUT gate) |
| **1 — Deterministic sequencer & action** | `sequencer.ts` + unit tests | All 10 ranked 1–10, stable; action mapping correct; threshold 0.60 locked |
| **2 — LLM rationale** | `subagent.ts`, `skills/rationale.ts`, `orchestrator.ts`, `eval.ts`, `run.ts`, `logger.ts` | Every paper has 3 rationale types; PAP-07 tangential flag verified; OUTPUT validates (OUTPUT gate) |
| **3 — Two-panel UI** | `dash-app-server.ts`, `dash-app-client.ts`, `dash-app.html`, `dash-app.css` | Position 1 selected on load; all sections collapsed; editorial treatment present |
| **4 — Degraded-state hardening** | degraded-state behavior in `subagent.ts` + `orchestrator.ts` + client rendering | Simulated LLM failure renders retryable state at correct rank; no dropped papers, no blank panels |

---

## 9. Documented Divergences from Template

1. **No guardrail skill / no escalate-only flow.** The template's two-pass guardrail enforces conservative bias on a consequential LLM judgment. Here the LLM makes no consequential judgment — rank and action are deterministic. The guardrail spec has no referent and is dropped. The one honesty concern (PAP-07 tangential framing) is handled by prompt instruction + deterministic eval check.
2. **No per-case fan-out.** The template fans out one subagent per case via `Promise.all`. This build uses the Message Batches API, submitting all 10 rationale requests in one batch — better fit for a latency-insensitive, cost-sensitive POC (STRATEGY §2).
3. **`memory.js` dropped for v1.** No per-case failure-context replay; the degraded-state contract handles failure surfacing, and the batch call has deterministic SDK-level retry.
4. **Sequencer is a pure compute function, not an LLM skill.** The domain verb (rank) implies ordering, but ordering is mechanical over frozen scores — so it lives in the compute layer, unit-tested, never an LLM surface.

These divergences follow directly from STRATEGY's core principle: **the ranking is deterministic and LLM-free; the explanations are LLM-driven.**