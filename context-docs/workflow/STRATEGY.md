# STRATEGY.md

## Atomic Research — Paper Relevance Feed: Build Strategy

This document translates REQUIREMENTS.md into an execution plan. It is binding on downstream implementation. Where requirements decided something at requirements-time (model ID, visual treatment, degraded-state contract, observability stack), strategy executes it — it does not relitigate it.

---

## 1. Architecture Overview

A single-page desktop application, run locally, with a clean separation between three layers:

1. **Data layer** — the embedded fixtures (one researcher profile, 10 candidate papers). Loaded once, validated against schema, frozen. No network fetch.
2. **Compute layer** — deterministic scoring/sequencing (pure functions, no LLM) plus LLM-driven rationale generation (the only LLM surface), instrumented end-to-end with Weave + W&B.
3. **Presentation layer** — the two-panel editorial UI.

The crucial design principle: **the ranking is deterministic and LLM-free; the explanations are LLM-driven**. Scores are mocked fixtures, ordering is a pure function of those scores. The LLM never decides rank — it only explains a rank already computed. This keeps the feed reproducible and the "every position must be defensible by the rule" contract mechanically enforceable.

**Recommended action is also deterministic**, derived from the same frozen scores (see Phase 1). The LLM produces only the rationale types and the feed summary — it never decides rank or recommended action.

**Two-stage LLM call ordering is architectural, not incidental.** The per-paper rationale calls form a batch that runs against the *already-sequenced* feed; the `feed_summary` call runs *after* ranking, taking the sorted top-N as input. The summary is never a peer of the per-paper batch and is never issued before the sequencer has produced an order. This ordering is enforced in code, not left to convention (see Phase 2A/2B).

---

## 2. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Single-page web app, local | Hackathon laptop target; no server infra needed |
| Language | TypeScript | Type-safe enforcement of the per-paper output contract |
| LLM calls | Anthropic Message Batches API (per-paper rationales); single call (feed_summary, post-ranking) | Requirements prefer batching for the 10-paper rationale set: ~half token cost, latency-insensitive. The summary is one post-ranking call, not part of the batch. |
| Application model | `claude-sonnet-4-6` (pinned snapshot) | Requirements-level commitment; dateless pinned ID, bump deliberately. Governs the *built artifact's* runtime calls only — not the Claude Code build session. |
| Schema validation | JSON Schema validator (e.g. Ajv) | Required dependency for per-paper output contract |
| Observability — per-call | Weave (`weave.init`, auto-instruments Anthropic SDK; `@weave.op()` on team functions) | Required: per-call audit trail + eval harness |
| Observability — per-run | Weights & Biases (one run per fixture/prompt iteration) | Required: cross-iteration comparison record |
| Secrets | `WANDB_API_KEY` from gitignored `.env` | Required: never hardcoded, never committed |
| Styling | Hand-authored CSS, no heavy framework | Editorial visual treatment is bespoke; frameworks fight the design |

**Out of scope (must not be built or stubbed with live calls):** OpenAlex/arXiv ingestion, `text-embedding-3-small` embedding, cosine-similarity computation, weekly centroid refresh. These are production-pipeline concerns explicitly frozen for this POC.

---

## 2a. Threshold Model (two distinct thresholds — read before Phase 1)

Requirements refer abstractly to "the similarity pre-filter" and "the eligibility threshold" but **never state a numeric eligibility cutoff**, and they require all 10 fixtures (including PAP-10, whose max score is 0.33) to appear in the feed. Strategy therefore distinguishes **two separate thresholds**, which must not be conflated:

1. **Eligibility / feed-admission threshold (pre-filter).** This is the gate that admits a paper into the feed at all. In this POC **all 10 fixtures are pre-admitted as canonical input** — the fixture set *is* the post-pre-filter result. There is therefore **no numeric admission cutoff applied in this build**; PAP-10 (must-rank-low, max 0.33) appears precisely because the fixtures are the canonical, already-filtered input. This is consistent with PAP-10's stated coverage role of "barely clears the threshold": the implied production pre-filter sits *below* 0.60, and in the POC it is satisfied by construction for every fixture.
2. **"Component cleared" threshold = 0.60 (strategy-fixed code constant).** This governs only (a) multi-component-match *reporting* and (b) tie-break stage (1). It is **not** the feed-admission gate. A paper can be in the feed (e.g. PAP-10) while clearing *zero* components at 0.60.

**Explicit note:** 0.60 is a strategy-level constant chosen to make "components cleared" and the tie-break mechanically testable; requirements state it abstractly, not numerically. It is **not** the eligibility gate, so it does not contradict PAP-10's must-rank-low role. Both the 0.60 component-cleared constant and the 0.80 Read-now cutoff (Phase 1) are strategy-originated design choices, not derived from requirements.

---

## 3. Build Phases

### Phase 0 — Scaffold, fixtures & observability wiring
- Project skeleton, TypeScript config, fixtures embedded as a typed module.
- JSON Schema for the per-paper output contract; wire the validator.
- **`.env` setup:** `WANDB_API_KEY` read from gitignored `.env`; confirm `.env` is in `.gitignore` before any commit. No key hardcoded anywhere.
- **`weave.init("<team>/atomic-research")`** called once at pipeline startup; confirm the Anthropic SDK is auto-instrumented.
- Validate that the fixtures honor their stated coverage roles (must-rank-high, multi-component, mid-tier, tangential-near-miss, must-rank-low) and that every paper carries a populated abstract, every component a populated `evidence` field, and the profile a populated `publications` array.
- **Confirm all 10 fixtures are treated as pre-admitted canonical input** — the fixture set is the post-pre-filter result; no numeric admission cutoff is applied (see §2a).
- **Exit:** fixtures load and validate; schema rejects a deliberately malformed entry; `weave.init` runs clean; `.env` confirmed gitignored and key not in source.

### Phase 1 — Deterministic sequencer & recommended action (no LLM)
- **"Component cleared" threshold:** a component is considered *cleared* when its `component_similarity ≥ 0.60`. This single numeric value governs both multi-component-match reporting and tie-break stage (1). It is a constant in the codebase, not a tunable. **It is the "component cleared" threshold, not the feed-admission gate** (see §2a) — all 10 fixtures appear regardless of whether they clear any component at 0.60.
- Implement `max(component_similarity)` ranking with the two-stage tie-break: (1) more components at or above the 0.60 threshold, (2) more recent date.
- **Recency is a gate, not a ranking signal.** All fixtures are in-window (2025-12-06 → 2026-06-06) and eligible; age within the window never changes rank. Verify the window gate as an assertion even though all fixtures pass it.
- **Tangential flag is orthogonal to ranking.** The flag (semantic judgment, gated by the 0.60 quantitative floor) is determined in Phase 2 and *annotates*; it never re-ranks. A flagged paper keeps its `max(component_similarity)` position. The scoring contract is untouched by flagging.
- **Recommended action mapping (deterministic, derived from `max(component_similarity)`):**
  - `Read now` — strongest component similarity ≥ 0.80.
  - `Save` — strongest component similarity ≥ 0.60 and < 0.80.
  - `Skip` — strongest component similarity < 0.60.
  - **Strategy-originated cutoff note:** Requirements define recommended action as a required output (`Read now / Save / Skip`) but **do not specify numeric cutoffs**. The 0.80 Read-now cutoff and the 0.60/0.80 band boundaries are **strategy-level design decisions, not derived from requirements**. The reuse of 0.60 as the `Save` floor aligns with the "component cleared" constant but is itself a strategy choice; neither cutoff is the feed-admission gate, so this mapping does not conflict with pre-filter/eligibility semantics (a paper recommended `Skip`, e.g. PAP-10, still appears in the feed and still renders full per-paper output — see Phase 3).
  - This mapping is a pure function of frozen scores, reproducible and testable exactly like the ranking. The LLM plays no part in it.
- **Exit:** all 10 papers ranked 1–10, order is stable and reproducible, each position justifiable by the rule; recommended action assigned to every paper by the mapping above; "components cleared above threshold" is deterministic. Unit tests lock both the order and the recommended-action assignment.

### Phase 2A — LLM per-paper rationale batch
- Batch-call the model (Message Batches API) for: per-component match explanation, relevance rationale, per-position rationale.
- **Rationale-call context (required):** each per-paper call receives the paper's **abstract** and the matched component's **`evidence`** field. The rationale is grounded in actual content and in why the component exists — never inferred from the title alone.
- **Depth vs. breadth (required prompt instruction):** the prompt must explicitly distinguish *depth* (strong single-thread match) from *breadth* (cross-component relevance). Because the sequencer ranks on `max(component_similarity)` — i.e. on depth — a breadth paper (e.g. PAP-02) must have its multi-thread relevance explained in prose so its rank is not misread as pure depth.
- **Tangential-flag determination:** the LLM, reading abstract against matched-component `evidence`, judges substantive fit. The flag fires only on papers above the 0.60 floor whose fit is loose. PAP-07 is the canonical test case, not a special-cased paper — the same logic must be able to fire on any qualifying paper. A flagged paper's rationale must state the match is loose rather than overstate it.
- **Instrumentation:** the depth/breadth classifier and each eval assertion are decorated with `@weave.op()` so they appear in the same Weave trace tree as the auto-instrumented SDK calls.
- The LLM produces *only* these rationale types — rank and recommended action are already fixed by Phase 1 and passed into the prompt as given, not chosen by the model.
- **Exit:** every paper has all three rationale types; tangential flag verified on PAP-07; depth/breadth framing verified present on PAP-02; rationale calls visible in Weave trace tree.

### Phase 2B — Feed summary (post-ranking call)
- The `feed_summary` call runs **after** the sequencer has produced the order and **after** the per-paper batch — it takes the sorted top-N as input. It is not part of the per-paper batch and must not be issued before the ranking exists. This ordering constraint is enforced in code (the summary call cannot be reached without a completed ranking).
- The summary names the 2–3 strongest papers and their collective significance — the editorial headline above the per-paper layer.
- Auto-traced by Weave like every other Anthropic call.
- **Exit:** `feed_summary` generated from the already-sorted top-N; call ordering verified (summary cannot run before ranking); summary visible in Weave trace tree.

### Phase 3 — Two-panel UI
- Left feed panel, right detail panel, independent scroll, collapsible sections; collapsed sections retain enough height to show their section label.
- **Feed summary at top of left panel**, above the ranked list — its own region with its own degraded state.
- Primary (left, always visible): rank, title, top matched component label, recommended action.
- Secondary (right detail): per-component similarity, relevance rationale (with depth/breadth framing), tangential flag if present, missing-information note (rendered for *every* paper, "nothing material missing" when applicable), per-position rationale.
- **Every paper renders full per-paper output regardless of recommended action.** A `Skip`-actioned paper (e.g. PAP-10) is *not* dropped or hidden — it still appears at its score-determined rank and still renders its full detail view (component match(es) + per-component similarity, relevance rationale, recommended action, missing-information note, per-position rationale), consistent with the no-silent-drop and per-paper rendering rules.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) — built here, not deferred. Required deliverable, executed without iteration.
- **Exit:** position 1 selected on load, all sections collapsed to label, full layout per spec, feed summary region rendered above the list; a `Skip` paper confirmed to render full detail.

### Phase 4 — Degraded-state hardening
- Implement the failure contract: no blank panels, no silently dropped papers.
  - A paper whose **rationale** failed renders at its score-determined rank with an explicit "rationale unavailable — retry" state.
  - If **`feed_summary`** fails, the per-paper feed still renders in full; the summary region shows "summary unavailable — retry". The headline is never a single point of failure for the whole feed.
  - Malformed JSON from any model call is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as a retryable error on the relevant panel.
- **Exit:** simulated LLM failures (per-paper and feed_summary, independently) render the correct retryable state at the right place without blanking or dropping; malformed-JSON path logged and surfaced.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the pipeline-level aggregate — ranked output, component-similarity distributions, batch-call metadata (latency, token count, per-paper rationale status), and eval pass/fail results.
- **Eval assertions** (each a `@weave.op()`): ranking matches the deterministic contract; PAP-07 flagged loose; PAP-02 carries breadth framing; recommended-action mapping correct; missing-info note present on every paper; every paper (including `Skip`-actioned PAP-10) renders full per-paper output.
- **Exit:** one clean W&B run logged with aggregate metrics and eval results; Weave trace tree and W&B run cross-reference the same iteration.

---

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM overstates a tangential match (PAP-07) | Explicit prompt instruction + verification check in Phase 2A exit; flag gated by 0.60 floor |
| Tangential flag silently re-ranks instead of annotating | Flag is orthogonal to ranking by construction (Phase 1); a flagged paper keeps its score position; eval asserts position unchanged |
| Breadth paper's rank misread as depth (PAP-02) | Required depth/breadth prompt instruction; Phase 2A exit verifies framing present |
| `feed_summary` issued before ranking exists | Call ordering enforced in code (Phase 2B); summary unreachable without a completed sequence |
| `feed_summary` failure blanks the whole feed | Degraded-state contract: per-paper feed renders independently; summary region degrades alone (Phase 4) |
| Scores drift / ranking becomes non-reproducible | Ranking is a pure function over frozen fixtures; locked by unit tests |
| Recommended action becomes inconsistent / non-reproducible | Deterministic threshold-based mapping in Phase 1; locked by unit tests, never an LLM output |
| Two thresholds conflated (admission gate vs. "component cleared") | §2a disambiguates them; 0.60 is "component cleared" only, never the feed-admission gate; all 10 fixtures pre-admitted, so PAP-10 is not contradicted by its must-rank-low role |
| Strategy-originated cutoffs (0.60 component-cleared, 0.80 Read-now) mistaken for requirements | Flagged explicitly in §2a and Phase 1 as strategy-level decisions, not requirements-derived; confirmed not to conflict with eligibility semantics |
| `Skip`-actioned paper wrongly dropped or hidden | Phase 3 and Phase 5 eval assert every paper (incl. PAP-10) renders full per-paper output regardless of action; no-silent-drop holds |
| Threshold left implicit, tie-break untestable | "Component cleared" threshold fixed at 0.60 as a code constant in Phase 1; unit tests cover multi-component and tie-break cases |
| Rationale reasons from title, not content | Rationale-call context mandates abstract + component `evidence` (Phase 2A); never title-only |
| Visual treatment demoted to "stretch" under time pressure | Requirements forbid this; Phase 3 treats it as core exit criteria |
| `WANDB_API_KEY` hardcoded or committed | `.env` gitignored, confirmed in Phase 0 before any commit; key never in source |
| Observability bolted on late / incompletely | Weave wired in Phase 0; `@weave.op()` decoration in Phase 2; W&B run + evals in Phase 5 — instrumentation is a phase, not an afterthought |
| Malformed model JSON crashes a panel | Degraded-state contract in Phase 4; caught, logged to observability, surfaced as retryable |
| Scope creep into production pipeline | Explicit out-of-scope list; no live API calls permitted |

---

## 5. Definition of Done

- All 10 papers ranked into a single feed, position 1–10, each defensible by the scoring contract.
- Two thresholds disambiguated (§2a): no numeric feed-admission cutoff is applied in this POC (all 10 fixtures are pre-admitted canonical input, including PAP-10); the **"component cleared" threshold is fixed at 0.60** as a strategy-level code constant governing only multi-component reporting and tie-break stage (1). "Components cleared above threshold" is deterministic and unit-tested.
- Recency confirmed as a gate only — never a ranking signal; all fixtures verified in-window.
- Recommended action (`Read now / Save / Skip`) assigned to every paper by the deterministic threshold mapping (0.80 Read-now / 0.60–0.80 Save / <0.60 Skip — strategy-originated cutoffs, not requirements-derived), reproducible and unit-tested.
- Every paper renders full per-paper output — component match(es) + per-component similarity, relevance rationale (with depth/breadth framing), recommended action, missing-information note (always present), per-position rationale — **regardless of recommended action**; `Skip`-actioned papers (e.g. PAP-10) are not dropped or hidden.
- Tangential near-miss (PAP-07) is explicitly flagged as loose in its rationale, and the flag annotates without changing rank.
- `feed_summary` generated from the sorted top-N *after* ranking, renders at the top of the left panel, and degrades independently of the per-paper feed.
- Two-panel editorial UI matches the output-surface spec, including default state and visual treatment.
- Degraded-state contract holds under simulated LLM failure for both per-paper rationale and feed_summary, independently.
- Observability complete: Weave traces every Anthropic call and every `@weave.op()` team function; one W&B run logs aggregate metrics + eval results; both share the single gitignored `.env` key.
- No production-pipeline code, no live OpenAlex/arXiv/OpenAI calls.

---

## 6. Explicit Non-Goals

- No validation against real researchers, papers, or third parties.
- No citation-graph, venue-quality, or duplicate-detection signals (out of rubric scope).
- No recency-based ranking (recency is a gate only).
- No live embedding or similarity computation (fixtures are canonical).
- No numeric feed-admission cutoff applied in this POC (fixtures are the canonical, pre-admitted input; 0.60 is the "component cleared" threshold, not the admission gate).
- No LLM-driven ranking or recommended-action selection (both are deterministic functions of frozen scores).
- No tangential-flag re-ranking (flag annotates only; ranking is orthogonal).
- No dropping or hiding of `Skip`-actioned papers (every in-feed paper renders full per-paper output).
- No application-model selection for the Claude Code build session (model ID governs the built artifact's runtime only, advisory on the build environment).
- No multi-user, no persistence beyond the session, no auth.