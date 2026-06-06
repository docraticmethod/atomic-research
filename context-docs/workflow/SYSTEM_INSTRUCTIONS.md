# SYSTEM_INSTRUCTIONS.md

## Atomic Research — Paper Relevance Feed: Build Instructions for Claude Code

These are operational instructions for building this project. They execute ARCHITECTURE.md, which executes STRATEGY.md, which executes REQUIREMENTS.md. **Do not relitigate decisions made upstream** — the model ID, the deterministic ranking, the 0.60 threshold, the dropped guardrail, and the degraded-state contract are all settled. Your job is to implement them faithfully.

---

## 0. The One Principle You Must Not Violate

**The ranking and recommended action are deterministic, LLM-free pure functions over frozen fixtures. The LLM produces only explanatory prose.**

Every decision below flows from this. If you ever find yourself wiring the LLM into rank assignment or recommended-action selection, stop — you have misread the architecture. The LLM is handed `rank` and `recommended_action` as **given input** and asked only to explain them.

---

## 1. Non-Negotiables (settled upstream — do not revisit)

- **Model ID:** `claude-sonnet-4-6` (pinned snapshot). Do not substitute, do not add a date suffix, do not "upgrade."
- **Threshold:** `THRESHOLD = 0.60` as a single code constant in `sequencer.ts`. Not tunable, not duplicated, not inlined elsewhere.
- **LLM surface:** exactly the three rationale types (per-component match explanation, relevance rationale, per-position rationale). Nothing else.
- **No guardrail skill.** The escalate-only guardrail has no referent here — the LLM decides nothing consequential. Do not add one.
- **No production-pipeline code.** No OpenAlex/arXiv ingestion, no embeddings, no cosine similarity, no centroid refresh, no live third-party calls. Fixtures are canonical.
- **Batches API, not per-case fan-out.** All 10 rationale requests go in one batch submission. Do not `Promise.all` one subagent per paper.
- **Recency is a gate, not a ranking signal** — it appears only as tie-break stage (2).

---

## 2. Build In This Order

Follow the phase order. Do not start a phase before the prior phase's gate passes.

### Phase 0 — Scaffold & fixtures
- TypeScript project skeleton; add `@anthropic-ai/sdk`, `ajv`, `typescript` + `tsx`.
- Embed fixtures as `data/researcher_profile.json` and `data/candidate_papers.json` (one profile, 10 papers with frozen `component_similarity` scores).
- Write the input schema and the per-paper output schema; wire Ajv.
- **Gate:** fixtures load and validate; a deliberately malformed entry is rejected. No application component before this passes (Slice 0 / INPUT gate).

### Phase 1 — Deterministic sequencer & recommended action (NO LLM)
- Implement `sequencer.ts` as a **pure function**. No network, no LLM, no side effects.
- `max(component_similarity)` ranking.
- Two-stage tie-break: (1) more components with `component_similarity ≥ 0.60`, (2) more recent date.
- Recommended-action mapping: `≥ 0.80 → Read now`; `≥ 0.60 && < 0.80 → Save`; `< 0.60 → Skip`.
- `THRESHOLD = 0.60` as the single source of truth for both "cleared" counting and tie-break stage (1).
- **Do not set `tangential_flag` here.** There is no deterministic similarity band for tangentiality. It defaults to `false` and is driven by prompt + eval verification.
- **Gate:** all 10 papers ranked 1–10, stable and reproducible; action mapping correct for every paper; unit tests lock both order and action assignment.

### Phase 2 — LLM rationale generation
- Implement `subagent.ts` (wraps Message Batches API, `maxRetries: 3`), `skills/rationale.ts`, `orchestrator.ts`, `eval.ts`, `run.ts`, `logger.ts`.
- **First runnable slice: one paper end-to-end** — `run.ts → sequencer.ts (all 10) → subagent.ts (batch call for ONE paper) → eval.ts (schema gate) → write OUTPUT for that one paper.** Get this clean before fanning out to all 10.
- The skill produces only the three rationale types. `rank` and `recommended_action` are passed in as given.
- Put the **tangential-honesty instruction** in the system prompt: PAP-07's match must be explicitly framed as loose/tangential; the model must not overstate it.
- **Gate:** every paper has all three rationale types; PAP-07 carries `tangential_flag === true` with tangential framing; OUTPUT validates against schema (OUTPUT gate).

### Phase 3 — Two-panel UI
- Implement `dash-app-server.ts`, `dash-app-client.ts`, `dash-app.html`, `dash-app.css`.
- Server validates OUTPUT at startup; if validation fails, the dashboard does not start. The server is the only component that touches the data file; the client consumes API endpoints only.
- Editorial visual treatment (dark theme, serif titles) is **core, built here — not deferred to a stretch goal.**
- **Gate:** position 1 selected on load; all right-panel sections collapsed to their label; two-panel layout with independent scroll per spec.

### Phase 4 — Degraded-state hardening
- Implement the failure contract as cross-cutting behavior in `subagent.ts` + `orchestrator.ts` + client rendering.
- `rationale_status` ∈ `ok | unavailable | malformed`. Malformed JSON caught/logged/surfaced as `malformed`; missing rationale → `unavailable`.
- Deterministic fields always remain valid; a rationale failure never drops a paper or blanks a panel; the paper renders at its correct rank with a retryable placeholder.
- **Gate:** simulated LLM failure renders the retryable state correctly at the right rank; no dropped papers, no blank panels.

---

## 3. Component Map (what to build, where)

| File | Layer | Responsibility |
|---|---|---|
| `data/researcher_profile.json` | INPUT | One researcher profile fixture |
| `data/candidate_papers.json` | INPUT | 10 candidate papers, frozen `component_similarity` |
| `sequencer.ts` | Compute (no LLM) | Rank + action + cleared count, pure function, unit-tested |
| `subagent.ts` | Pipeline | Wraps Batches API; submits 10 in one batch; receives rank/action as given |
| `skills/rationale.ts` | Skill | The only skill; 3 rationale types; tangential-honesty instruction |
| `orchestrator.ts` | Pipeline | Sequences compute → batch call → assembly → eval; no per-case fan-out |
| `eval.ts` | Pipeline | Schema gate + sanity checks; aggregate errors, no short-circuit |
| `run.ts` | Entry | CLI; writes OUTPUT once eval passes; writes nothing on failure |
| `logger.ts` | Pipeline | JSONL trace; `traceId` through orchestrator → subagent → eval |
| `dash-app-server.ts` | Dashboard | Validates + serves OUTPUT; only file-touching component |
| `dash-app-client.ts` | Dashboard | Rendering/selection/scroll; consumes API only |
| `dash-app.html` | Dashboard | Markup only; no inline styles/scripts |
| `dash-app.css` | Dashboard | External editorial stylesheet |

**Do not build:** `skills/guardrail.ts`, `memory.ts`, any per-case subagent fan-out. These are deliberately dropped (ARCHITECTURE §0, §9).

---

## 4. The Output Contract (per paper)

Every paper in `public/output_data.json` must carry these fields. Deterministic fields come from `sequencer.ts`; prose fields come from the LLM; `rationale_status` reflects degraded state.

```json
{
  "paper_id": "PAP-03",
  "rank": 1,
  "title": "...",
  "date": "2024-11-02",
  "max_component_similarity": 0.87,
  "recommended_action": "Read now",
  "components": [
    { "component": "...", "component_similarity": 0.87, "cleared": true, "match_explanation": "<LLM prose>" }
  ],
  "components_cleared_count": 1,
  "relevance_rationale": "<LLM prose>",
  "position_rationale": "<LLM prose>",
  "tangential_flag": false,
  "missing_information": "<note or null>",
  "rationale_status": "ok"
}
```

**Field provenance — memorize this:**
- **Deterministic (Phase 1):** `rank`, `max_component_similarity`, `recommended_action`, `cleared`, `components_cleared_count`.
- **LLM (Phase 2):** `match_explanation`, `relevance_rationale`, `position_rationale`.
- **Prompt + eval verification:** `tangential_flag` (true only for PAP-07, verified at eval; defaults `false`).
- **Degraded-state (Phase 4):** `rationale_status` ∈ `ok | unavailable | malformed`.

---

## 5. The LLM Call — Exactly How

- **API:** Anthropic **Message Batches API**. One rationale request per paper, **10 requests in a single batch submission**. Total cost: **10 model calls**, no nesting (all three rationale types per paper come back in one structured response — no per-component sub-calls).
- **Client:** `@anthropic-ai/sdk`, initialized with `maxRetries: 3`.
- **Model:** `claude-sonnet-4-6`. Pinned. No substitution.
- **Input to the model:** the paper's deterministic facts (rank, action, components with similarities, cleared flags) as **given context**, plus instruction to produce the three rationale types.
- **Output from the model:** the three rationale types only. Never rank, never action.
- **Latency:** irrelevant by design — batch is asynchronous; poll for completion. Do not optimize for speed.

---

## 6. Eval Gates (eval.ts)

Aggregate all errors — do not short-circuit on first failure. On any failure, **OUTPUT is not written.**

- `validateSchema`: every paper matches the per-paper output contract (Ajv).
- `sanityCheck`:
  - All 10 papers ranked 1–10 — no gaps, no duplicates.
  - Rank order matches the deterministic rule (recompute and compare).
  - Recommended-action mapping correct for every paper (recompute and compare).
  - `components_cleared_count` equals the count of components with `component_similarity ≥ 0.60`.
  - **PAP-07 `tangential_flag === true`** and its rationale carries the tangential framing.

There is **no general band rule** to recompute for tangentiality — PAP-07 is the specific verified case (ARCHITECTURE §2, §5).

---

## 7. Dashboard Rules

- **Server (`dash-app-server.ts`):** Node/Express. Reads and validates `public/output_data.json` at startup; if validation fails, **does not start** — no partial-success state. Only component that touches the data file. Add an ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server starts only when run directly, not when imported in tests.
- **Client (`dash-app-client.ts`):** consumes server API endpoints only — **never reads the data file directly.** Holds all rendering, selection, expansion, and scroll logic.
- **HTML (`dash-app.html`):** markup only — no inline styles, no inline scripts beyond loading the client module.
- **CSS (`dash-app.css`):** external stylesheet; editorial dark theme with serif titles.

**Layout invariants:**
- Two panels: left feed (all 10 in rank order 1→10, selectable), right detail.
- **Position 1 selected by default on load.**
- Right panel sections (component matches + similarities, relevance rationale, recommended action, missing-information note, per-position rationale) **all load collapsed to their label.**
- Both panels scroll independently.
- Collapsed sections have a fixed minimum height sufficient to show the label.
- A paper with `rationale_status` ≠ `ok` still renders at its correct rank with a retryable placeholder — never a blank panel.

---

## 8. Definition of Done

- All 10 papers ranked 1–10, each position defensible by the deterministic rule.
- Threshold fixed at `0.60` as a single constant; "components cleared" deterministic and unit-tested.
- Recommended action assigned to every paper by the deterministic mapping; reproducible and unit-tested.
- Every paper renders: component match(es) + per-component similarity, relevance rationale, recommended action, missing-information note, per-position rationale.
- PAP-07 explicitly flagged as a loose/tangential match.
- Two-panel editorial UI matches spec — default selection, collapsed sections, dark/serif treatment.
- Degraded-state contract holds under simulated LLM failure — no dropped papers, no blank panels.
- No production-pipeline code; no live OpenAlex/arXiv/embedding calls.

---

## 9. When In Doubt

1. **Re-read §0.** Most mistakes come from creeping the LLM into ranking or action.
2. **Check provenance (§4).** If you're about to let the model emit a deterministic field, stop.
3. **Don't add dropped components.** No guardrail, no memory, no fan-out.
4. **Don't defer the visual treatment.** It's core, not a stretch goal.
5. **Don't relitigate settled decisions.** Model ID, threshold, batch API, degraded-state contract are fixed upstream.