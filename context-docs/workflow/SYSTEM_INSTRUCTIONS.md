The architect is EDITING existing content. Here is the complete revised SYSTEM_INSTRUCTIONS.md:

# SYSTEM_INSTRUCTIONS.md

## Atomic Research — Paper Relevance Feed: Build Instructions for Claude Code

These are operational instructions for building this project. They execute ARCHITECTURE.md, which executes STRATEGY.md, which executes REQUIREMENTS.md. **Do not relitigate decisions made upstream** — the model ID, the deterministic ranking, the 0.60 threshold, the dropped guardrail, the two-stage LLM call ordering, the Docker sandbox, and the degraded-state contract are all settled. Your job is to implement them faithfully.

---

## 0. The One Principle You Must Not Violate

**The ranking and recommended action are deterministic, LLM-free pure functions over frozen fixtures. The LLM produces only explanatory prose.**

Every decision below flows from this. If you ever find yourself wiring the LLM into rank assignment or recommended-action selection, stop — you have misread the architecture. The LLM is handed `rank` and `recommended_action` as **given input** and asked only to explain them. It produces the three per-paper rationale types and the post-ranking feed summary — nothing else.

---

## 0a. Docker Sandbox — Build This First

**The entire application runs inside a Docker sandbox container.** This is settled upstream (ARCHITECTURE §0a-a) and is not optional.

- **Build all Docker components first**, before any application code. The container is the secure boundary Claude Code operates within.
- The pipeline, the dashboard server, and all dependencies (`@anthropic-ai/sdk`, `ajv`, `typescript`/`tsx`, `weave`, `wandb`) run inside the container.
- The gitignored `.env` carrying `WANDB_API_KEY` is mounted into the container, not baked into the image. The key never lands in a layer, never gets committed.
- `data/` (INPUT) and `public/` (OUTPUT) are wired so the pipeline can read fixtures and write `output_data.json`, and the dashboard server can serve it, all within the sandbox.
- **Gate (Docker):** the container builds clean; the pipeline and dashboard server both run inside it; `.env` is mounted (not baked) and confirmed gitignored. Do not start Phase 0 application work until the sandbox builds and runs.

---

## 1. Non-Negotiables (settled upstream — do not revisit)

- **Docker sandbox:** the application is containerized; build Docker components first; Claude Code operates inside the sandbox. Do not run the application outside the container.
- **Model ID:** `claude-sonnet-4-6` (pinned snapshot). Do not substitute, do not add a date suffix, do not "upgrade." Governs the built artifact's runtime calls only — not your build session.
- **Threshold:** `THRESHOLD = 0.60` as a single code constant in `sequencer.ts`. Not tunable, not duplicated, not inlined elsewhere. **It is the "component cleared" threshold, NOT the feed-admission gate.** All 10 fixtures appear regardless of whether they clear any component at 0.60.
- **No numeric feed-admission cutoff.** All 10 fixtures are pre-admitted canonical input — the fixture set IS the post-pre-filter result. PAP-10 (max 0.33, must-rank-low) appears by construction. Do not filter any paper out of the feed.
- **Strategy-originated cutoffs:** the `0.60` component-cleared constant and the `0.80` Read-now cutoff are strategy-level design decisions, not requirements-derived. Implement them as given; do not treat them as the eligibility gate.
- **LLM surface:** exactly the three per-paper rationale types (per-component match explanation, relevance rationale, per-position rationale) **plus the post-ranking feed summary**. Nothing else.
- **No guardrail skill.** The escalate-only guardrail has no referent here — the LLM decides nothing consequential. Do not add one.
- **No production-pipeline code.** No OpenAlex/arXiv ingestion, no embeddings, no cosine similarity, no centroid refresh, no live third-party calls. Fixtures are canonical.
- **Batches API, not per-case fan-out.** All 10 per-paper rationale requests go in one batch submission. Do not `Promise.all` one subagent per paper.
- **Two-stage call ordering is architectural.** Sequencer (deterministic) → per-paper rationale batch → `feed_summary` (post-ranking). The summary takes the sorted top-N as input and **must not** be issued before the ranking exists. Enforce this in code (§2c equivalent in `orchestrator.ts`): the summary call is unreachable without a completed ranking and a completed per-paper batch.
- **Recency is a gate, not a ranking signal** — it appears only as tie-break stage (2).
- **Tangential flag annotates, never re-ranks** — a flagged paper keeps its `max(component_similarity)` position.

---

## 1a. Observability Is a Phase, Not an Afterthought

Weave + W&B are the primary instrumentation surface, wired before any LLM call. All of this runs inside the Docker sandbox.

- **Weave (per-call):** `weave.init("<team>/atomic-research")` is called **once at startup in `run.ts`, before any Anthropic call.** It auto-instruments the Anthropic SDK so every per-paper rationale call and the feed_summary call appear in the trace tree. Decorate team functions — the depth/breadth framing logic and **every eval assertion** — with `@weave.op()` so they appear in the same trace tree.
- **W&B (per-run):** one `wandb` run per fixture/prompt iteration logs the pipeline aggregate — ranked output, component-similarity distributions, batch-call metadata (latency, token count, per-paper rationale status), and eval pass/fail results.
- **Secrets:** `WANDB_API_KEY` read from a **gitignored `.env`**, mounted into the container (not baked into the image). Confirm `.env` is in `.gitignore` **before any commit.** Never hardcode, never commit the key, never bake it into a Docker layer.
- **Cross-reference:** the Weave trace tree and the W&B run must reference the same iteration.

---

## 2. Build In This Order

Follow the phase order. Do not start a phase before the prior phase's gate passes. **The Docker sandbox (§0a) is built before Phase 0.**

### Phase 0 — Scaffold, fixtures & observability wiring
- TypeScript project skeleton inside the container; add `@anthropic-ai/sdk`, `ajv`, `typescript` + `tsx`, `weave`, `wandb`.
- Embed fixtures as `data/researcher_profile.json` and `data/candidate_papers.json` (one profile with a populated `publications` array, 10 papers with frozen `component_similarity` scores). Every paper carries a populated abstract; every component carries a populated `evidence` field.
- Write the input schema and the per-paper output schema **and the feed_summary schema**; wire Ajv.
- Validate fixtures honor their coverage roles (must-rank-high, multi-component, mid-tier, tangential-near-miss, must-rank-low).
- **Confirm all 10 fixtures are pre-admitted canonical input** — no numeric admission cutoff applied.
- Wire observability: `weave.init` runs clean; `.env` confirmed gitignored and key not in source (and not in any Docker layer).
- **Gate:** fixtures load and validate; a deliberately malformed entry is rejected; `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes (Slice 0 / INPUT gate).

### Phase 1 — Deterministic sequencer & recommended action (NO LLM)
- Implement `sequencer.ts` as a **pure function**. No network, no LLM, no side effects.
- `max(component_similarity)` ranking.
- Two-stage tie-break: (1) more components with `component_similarity ≥ 0.60`, (2) more recent date.
- Recommended-action mapping: `≥ 0.80 → Read now`; `≥ 0.60 && < 0.80 → Save`; `< 0.60 → Skip`.
- `THRESHOLD = 0.60` as the single source of truth for both "cleared" counting and tie-break stage (1). **This is the component-cleared threshold, not the admission gate.**
- **Recency gate, not ranking signal:** add a window-eligibility assertion (2025-12-06 → 2026-06-06); all fixtures must be in-window; age within the window never changes rank.
- **Do not set `tangential_flag` here.** There is no deterministic similarity band for tangentiality. It defaults to `false` and is driven by prompt + eval verification.
- **Gate:** all 10 papers ranked 1–10, stable and reproducible; action mapping correct for every paper; window-eligibility assertion passes; unit tests lock both order and action assignment.

### Phase 2 — LLM rationale generation
- Implement `subagent.ts` (wraps Message Batches API + single feed_summary call, `maxRetries: 3`), `skills/rationale.ts`, `orchestrator.ts`, `eval.ts`, `run.ts`, `logger.ts`.
- **First runnable slice: one paper end-to-end** — `run.ts → weave.init → sequencer.ts (all 10) → subagent.ts (batch call for ONE paper) → eval.ts (schema gate) → write OUTPUT for that one paper.** Get this clean before fanning out to all 10, before the feed_summary call, before PAP-07/PAP-02 verification, and before degraded-state handling.
- The skill produces only the three rationale types. `rank` and `recommended_action` are passed in as given.
- **Rationale-call context (required):** each per-paper call receives the paper's **abstract** and the matched component's **`evidence`** field. Never reason from the title alone.
- Put the **tangential-honesty instruction** in the system prompt: PAP-07's match (above the 0.60 floor, loose fit) must be explicitly framed as loose/tangential; the model must not overstate it. PAP-07 is the canonical test case, not a special-cased paper — the same logic must be able to fire on any qualifying paper.
- Put the **depth/breadth instruction** in the system prompt: explicitly distinguish *depth* (strong single-thread match) from *breadth* (cross-component relevance). Because ranking is on `max(component_similarity)` (depth), a breadth paper (e.g. PAP-02) must have its multi-thread relevance explained in prose so its rank is not misread as pure depth. Decorate the depth/breadth framing logic with `@weave.op()`.

#### Phase 2B — Feed summary (post-ranking call)
- After the per-paper batch completes, issue the single `feed_summary` call against the **sorted top-N**. Enforce ordering in code: the summary call is unreachable without a completed ranking and a completed batch.
- The summary names the 2–3 strongest papers and their collective significance.
- Auto-traced by Weave like every other Anthropic call.
- **Gate:** every paper has all three rationale types; PAP-07 carries `tangential_flag === true` with tangential framing; PAP-02 carries depth/breadth framing; `feed_summary` generated from the already-sorted top-N (verified it cannot run before ranking); all rationale + summary calls visible in the Weave trace tree; OUTPUT validates against schema (OUTPUT gate).

### Phase 3 — Two-panel UI
- Implement `dash-app-server.ts`, `dash-app-client.ts`, `dash-app.html`, `dash-app.css`.
- Server validates OUTPUT (papers + feed_summary) at startup; if validation fails, the dashboard does not start. The server is the only component that touches the data file; the client consumes API endpoints only.
- **Feed summary region rendered at the top of the left panel**, above the ranked list — its own region with its own degraded state.
- Editorial visual treatment (dark theme, serif titles) is **core, built here — not deferred to a stretch goal.**
- **Every paper renders full per-paper output regardless of recommended action.** A `Skip`-actioned paper (e.g. PAP-10) is NOT dropped or hidden — it appears at its score-determined rank and renders full detail.
- **Gate:** position 1 selected on load; all right-panel sections collapsed to their label; two-panel layout with independent scroll per spec; feed summary region rendered above the list; a `Skip` paper confirmed to render full detail.

### Phase 4 — Degraded-state hardening
- Implement the failure contract as cross-cutting behavior in `subagent.ts` + `orchestrator.ts` + client rendering.
- `rationale_status` ∈ `ok | unavailable | malformed`. Malformed JSON caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `malformed`; missing rationale → `unavailable`.
- **feed_summary failure is independent:** if the summary call fails, the per-paper feed still renders in full; the summary region shows "summary unavailable — retry" via `summary_status`. The headline is never a single point of failure for the whole feed.
- Deterministic fields always remain valid; a rationale failure never drops a paper or blanks a panel; the paper renders at its correct rank with a retryable placeholder.
- **Gate:** simulated LLM failures (per-paper and feed_summary, independently) render the retryable state correctly at the right place; no dropped papers, no blank panels; malformed-JSON path logged and surfaced.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the pipeline aggregate — ranked output, component-similarity distributions, batch-call metadata (latency, token count, per-paper rationale status), and eval pass/fail results.
- Each eval assertion is a `@weave.op()`.
- **Gate:** one clean W&B run logged with aggregate metrics and eval results; Weave trace tree and W&B run cross-reference the same iteration.

---

## 3. Component Map (what to build, where)

| File | Layer | Responsibility |
|---|---|---|
| `Dockerfile` (+ compose/`.dockerignore`) | Sandbox | Builds the container the app runs in; `.env` mounted not baked; built first |
| `data/researcher_profile.json` | INPUT | One researcher profile fixture (populated `publications`) |
| `data/candidate_papers.json` | INPUT | 10 candidate papers, frozen `component_similarity`, populated abstracts + `evidence` |
| `sequencer.ts` | Compute (no LLM) | Rank + action + cleared count + window-eligibility assertion, pure function, unit-tested |
| `subagent.ts` | Pipeline | Wraps Batches API (10 in one batch) + single feed_summary call; receives rank/action as given; passes abstract + `evidence` |
| `skills/rationale.ts` | Skill | The only skill; 3 rationale types; tangential-honesty + depth/breadth + grounding instructions |
| `orchestrator.ts` | Pipeline | Sequences compute → batch call → post-ranking feed_summary → assembly → eval; enforces call ordering; no per-case fan-out |
| `eval.ts` | Pipeline | Schema gate + sanity checks; aggregate errors, no short-circuit; each assertion `@weave.op()` |
| `run.ts` | Entry | CLI; `weave.init` at startup; writes OUTPUT once eval passes; logs W&B run; writes nothing on failure |
| `logger.ts` | Pipeline | JSONL trace; `traceId` through orchestrator → subagent → eval; subordinate to Weave/W&B |
| `dash-app-server.ts` | Dashboard | Validates + serves OUTPUT (papers + feed_summary); only file-touching component |
| `dash-app-client.ts` | Dashboard | Rendering/selection/scroll; feed summary region; consumes API only |
| `dash-app.html` | Dashboard | Markup only; no inline styles/scripts |
| `dash-app.css` | Dashboard | External editorial stylesheet |

**Do not build:** `skills/guardrail.ts`, `memory.ts`, any per-case subagent fan-out. These are deliberately dropped (ARCHITECTURE §0).

---

## 4. The Output Contract

### 4.1 Per-paper contract

Every paper in `public/output_data.json` must carry these fields. Deterministic fields come from `sequencer.ts`; prose fields come from the LLM; `rationale_status` reflects degraded state.

```json
{
  "paper_id": "PAP-03",
  "rank": 1,
  "title": "...",
  "date": "2026-02-14",
  "max_component_similarity": 0.87,
  "recommended_action": "Read now",
  "components": [
    { "component": "...", "component_similarity": 0.87, "cleared": true, "match_explanation": "<LLM prose>" }
  ],
  "components_cleared_count": 1,
  "relevance_rationale": "<LLM prose, depth/breadth framed>",
  "position_rationale": "<LLM prose>",
  "tangential_flag": false,
  "missing_information": "<note or 'nothing material missing'>",
  "rationale_status": "ok"
}
```

The example `date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06) — every fixture, including this example, is in-window.

**Field provenance — memorize this:**
- **Deterministic (Phase 1):** `rank`, `max_component_similarity`, `recommended_action`, `cleared`, `components_cleared_count`.
- **LLM (Phase 2):** `match_explanation`, `relevance_rationale`, `position_rationale`.
- **Prompt + eval verification:** `tangential_flag` (true only for PAP-07, verified at eval; defaults `false`). The flag annotates only — it never re-ranks.
- **Rendered for every paper:** `missing_information` — a note when material info is missing, or `"nothing material missing"` when not. Never null/absent.
- **Degraded-state (Phase 4):** `rationale_status` ∈ `ok | unavailable | malformed`.

### 4.2 Feed summary contract

The `feed_summary` is a separate output region, not a per-paper field. The output artifact is an object with a `papers` array and a `feed_summary` object.

```json
{
  "feed_summary": {
    "text": "<LLM prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. When not `ok`, the summary region shows a retryable placeholder; the per-paper feed renders in full regardless.

---

## 5. The LLM Calls — Exactly How

- **API:** Anthropic **Message Batches API** for the per-paper rationales. One rationale request per paper, **10 requests in a single batch submission**, no nesting (all three rationale types per paper come back in one structured response — no per-component sub-calls). **Plus one post-ranking `feed_summary` call.** Total: **11 model calls per run.** REQUIREMENTS specifies no numeric call/budget cap; 11 is the concrete pipeline cost.
- **Client:** `@anthropic-ai/sdk`, initialized with `maxRetries: 3`.
- **Model:** `claude-sonnet-4-6`. Pinned. No substitution.
- **Input to the per-paper model call:** the paper's deterministic facts (rank, action, components with similarities, cleared flags) as **given context**, **plus the paper's abstract and the matched component's `evidence` field**, plus instruction to produce the three rationale types. Never title-only.
- **Input to the feed_summary call:** the sorted top-N. Issued **after** the batch completes and **after** ranking exists.
- **Output from the per-paper model call:** the three rationale types only. Never rank, never action.
- **Latency:** irrelevant by design — batch is asynchronous; poll for completion. Do not optimize for speed.
- **Tracing:** every call is auto-instrumented by Weave (`weave.init` at startup).

---

## 6. Eval Gates (eval.ts)

Aggregate all errors — do not short-circuit on first failure. On any failure, **OUTPUT is not written.** Each assertion is decorated `@weave.op()`.

- `validateSchema`: every paper matches the per-paper output contract **and the feed_summary matches its contract** (Ajv).
- `sanityCheck`:
  - All 10 papers ranked 1–10 — no gaps, no duplicates.
  - Rank order matches the deterministic rule (recompute and compare).
  - Recommended-action mapping correct for every paper (recompute and compare).
  - `components_cleared_count` equals the count of components with `component_similarity ≥ 0.60`.
  - **PAP-07 `tangential_flag === true`** and its rationale carries the tangential framing. The flag does not change PAP-07's score-determined position.
  - **PAP-02 carries breadth framing** in its relevance rationale.
  - **Missing-info note present on every paper** (note or `"nothing material missing"`).
  - **Every paper (including `Skip`-actioned PAP-10) renders full per-paper output** — no paper dropped or hidden.
  - **Recency window assertion** — all fixtures in-window.

There is **no general band rule** to recompute for tangentiality — PAP-07 is the specific verified case (ARCHITECTURE §2, §5).

---

## 7. Dashboard Rules

- **Server (`dash-app-server.ts`):** Node/Express, running inside the Docker sandbox. Reads and validates `public/output_data.json` (papers + feed_summary) at startup; if validation fails, **does not start** — no partial-success state. Only component that touches the data file. Add an ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server starts only when run directly, not when imported in tests.
- **Client (`dash-app-client.ts`):** consumes server API endpoints only — **never reads the data file directly.** Holds all rendering, selection, expansion, and scroll logic, including the feed summary region and its independent degraded state.
- **HTML (`dash-app.html`):** markup only — no inline styles, no inline scripts beyond loading the client module.
- **CSS (`dash-app.css`):** external stylesheet; editorial dark theme with serif titles.

**Layout invariants:**
- Two panels: left feed (all 10 in rank order 1→10, selectable), right detail.
- **Feed summary region at the top of the left panel**, above the ranked list — its own region with its own degraded state. When `summary_status` ≠ `ok`, it shows "summary unavailable — retry" while the per-paper list renders in full.
- **Position 1 selected by default on load.**
- Right panel sections (component matches + similarities, relevance rationale with depth/breadth framing, tangential flag if present, recommended action, missing-information note, per-position rationale) **all load collapsed to their label.**
- Both panels scroll independently.
- Collapsed sections have a fixed minimum height sufficient to show the label.
- **Every paper renders full detail regardless of recommended action** — a `Skip`-actioned paper (e.g. PAP-10) is never dropped or hidden.
- A paper with `rationale_status` ≠ `ok` still renders at its correct rank with a retryable placeholder — never a blank panel.

---

## 8. Definition of Done

- **Docker sandbox built first**; the application builds clean and runs entirely inside the container; `.env` mounted (not baked), confirmed gitignored, key never in any layer or commit.
- All 10 papers ranked 1–10, each position defensible by the deterministic rule; order stable and reproducible; unit-tested.
- `THRESHOLD = 0.60` is the single "component cleared" constant (not the admission gate); "components cleared above threshold" is deterministic and unit-tested; no numeric feed-admission cutoff applied — all 10 fixtures pre-admitted, PAP-10 included.
- Recommended action (`Read now / Save / Skip`) assigned to every paper by the deterministic threshold mapping (0.80 / 0.60–0.80 / <0.60), reproducible and unit-tested; never an LLM output.
- Recency confirmed as a gate only — never a ranking signal; all fixtures verified in-window.
- LLM produces only the three per-paper rationale types plus the post-ranking feed summary; 11 model calls per run (10-request batch + 1 feed_summary); rank and action passed in as given.
- Every paper renders full per-paper output — component match(es) + per-component similarity, relevance rationale (depth/breadth framed), recommended action, missing-information note (always present), per-position rationale — regardless of recommended action; `Skip`-actioned papers (e.g. PAP-10) never dropped or hidden.
- PAP-07 explicitly flagged loose/tangential in its rationale; the flag annotates without changing rank; PAP-02 carries breadth framing.
- `feed_summary` generated from the sorted top-N after ranking; rendered at the top of the left panel; degrades independently of the per-paper feed; call ordering enforced in code (summary unreachable before ranking).
- Two-panel editorial UI per spec — dark theme, serif titles, position 1 selected on load, all right-panel sections collapsed to label, independent scroll, feed summary region above the list.
- Degraded-state contract holds under simulated LLM failure for both per-paper rationale and feed_summary, independently; no blank panels, no dropped papers; malformed JSON caught, logged to observability, surfaced as retryable.
- Observability complete: Weave traces every Anthropic call and every `@weave.op()` team function; one W&B run logs aggregate metrics + eval results; both share the single gitignored `.env` key and cross-reference the same iteration.
- No guardrail skill, no `memory.ts`, no per-case fan-out; no production-pipeline code, no live OpenAlex/arXiv/embedding calls.