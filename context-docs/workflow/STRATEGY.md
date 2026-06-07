# STRATEGY.md

## Atomic Research — Paper Relevance Feed (v3): Build Strategy

This document translates the **v3** REQUIREMENTS.md into an execution plan. It is binding on downstream implementation. Where requirements decided something at requirements-time (the council reversal, model ID, visual treatment, degraded-state contract, observability stack), strategy executes it — it does not relitigate it.

**v3 supersede notice.** This STRATEGY supersedes the v2 strategy in full. The load-bearing change is §0 of REQUIREMENTS: **relevance is now DECIDED by a multi-agent council, not computed by a deterministic LLM-free function.** The prior strategy's central design principle — "ranking and recommended action are deterministic pure functions; the LLM only explains" — is **deliberately reversed and removed**. Any phase, risk, or DoD item below that reintroduces a deterministic LLM-free relevance sequencer is wrong and contradicts the requirements.

---

## 1. Architecture Overview

A single-page desktop application, run locally, with a clean separation between three layers:

1. **Data layer** — five normalized, id-joined fixture files (`researchers`, `papers`, `research_components`, `feed_items`, `research_subfield_preferences`). **3 researchers, 30 distinct papers (10 each, no cross-researcher reuse), 30 feed_items.** Loaded once, validated against field contracts, frozen. No network fetch, no embeddings.
2. **Compute layer** — the **LLM council** that *decides* relevance per (researcher, paper) pair, plus the per-researcher `feed_summary`, instrumented end-to-end with Weave + W&B.
3. **Presentation layer** — the reused v2 two-panel editorial UI, with a researcher selector added.

The crucial design principle (v3): **the council decides relevance; ranking is a pure presentation-order function of the council's `relevance_score`.** The council produces `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, and the full `council_deliberation` record. The deliberation record is **the audit trail that buys back the defensibility the determinism gave up** — it is captured per decision and traced in Weave, not optional polish.

**What is still deterministic (and only this):** the *display ordering* of a researcher's feed is `relevance_score` descending. Ordering is a mechanical sort over council outputs — it is not a relevance decision and introduces no LLM-free relevance logic.

**Call ordering is architectural, not incidental.** Per researcher: (1) the council decides the full 10-paper set first; (2) the feed is sorted by `relevance_score` descending; (3) the `feed_summary` call runs **after** that researcher's decisions are complete, taking the decided, sorted feed as input. The summary call must be unreachable before the council has finished that researcher's set. Enforced in code, not by convention (see Phase 2A/2B).

---

## 2. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Single-page web app, local | Hackathon laptop target; no server infra needed |
| Language | TypeScript | Type-safe enforcement of the fixture field contracts and council output shape |
| LLM calls | Anthropic Message Batches API (council deliberations); single call (feed_summary, post-decision) | Requirements prefer batching where call structure allows: the council's multiple deliberations per researcher are not latency-sensitive — batch to halve token cost. The summary is one post-decision call per researcher, not part of the batch. |
| Application model | `claude-sonnet-4-6` (pinned snapshot) | Requirements-level commitment; dateless pinned ID, bump deliberately. Governs the *built artifact's* runtime calls only — not the Claude Code build session. |
| Schema validation | Ajv (JSON Schema) | Required dependency; validates all five fixture files against their field contracts |
| Observability — per-call | Weave (`weave.init`, auto-instruments Anthropic SDK; `@weave.op()` on council orchestration + every eval assertion) | Required and now **load-bearing for auditability**: the deliberation trace tree is part of the audit trail, not just telemetry |
| Observability — per-run | Weights & Biases (one run per fixture/prompt iteration) | Required: per-researcher decision distributions, confidence distributions, accept/reject counts, batch metadata, eval pass/fail |
| Secrets | `WANDB_API_KEY` from gitignored `.env`, mounted into Docker (not baked) | Required: never hardcoded, never committed |
| Sandbox | Docker container; fixtures (INPUT) + dashboard (OUTPUT) wired in; `.env` mounted | Required: build the container before application code |
| Styling | Hand-authored CSS, no heavy framework | Editorial visual treatment is bespoke; frameworks fight the design |

**Out of scope (must not be built or stubbed with live calls):** OpenAlex/arXiv ingestion, embedding computation, cosine-similarity/vector relevance, weekly centroid refresh, any deterministic LLM-free relevance sequencer. These are explicitly frozen or reversed for this POC.

---

## 2a. Decision model (read before Phase 1) — what replaced the v2 threshold model

v2 hinged on numeric thresholds (a feed-admission gate, a "component cleared" constant, recommended-action cutoffs) feeding a deterministic sequencer. **v3 deletes all of these.** There is no admission threshold, no "component cleared" constant, and no `Read now / Save / Skip` action mapping in v3. Strategy clarifies what governs decisions now:

1. **The council decides admission, not a threshold.** Each (researcher, paper) pair gets a `relevance_decision` boolean from the council. Items decided against (`false`) are **not dropped** — they render at their `relevance_score` position with reject reasoning visible, so the demo shows the council *declining*. The fixtures are canonical input; the synthetic `feed_items` already carry the council's decision fields, and the runtime council reproduces/validates decisions over the same inputs.
2. **`relevance_score` (0–1) is the council's calibrated relevance**, and is the *only* ordering signal. Display order is `relevance_score` descending. Ties are broken by `council_confidence` descending, then by `publication_date` recency — a presentation-stability rule, not a relevance judgment.
3. **`council_confidence` (0–100) is the council's confidence in its own decision** — a distinct axis from `relevance_score`. Both render in the detail panel.
4. **Subfield match is an explicit council factor**, weighed alongside component match, focus match, and the substantive-vs-superficial test — but it is a *consideration inside deliberation*, never a numeric gate.

**Explicit note:** No numeric cutoffs are strategy-originated in v3. The four decision factors (component / subfield / focus / substantive-vs-superficial) are requirements-level; the council weighs them and records its reasoning in `council_deliberation`. The substantive-vs-superficial test generalizes v2's tangential-honesty rule: a paper matching on surface terms but not substance must be **argued down in deliberation**, not rubber-stamped.

---

## 3. Build Phases

### Phase 0 — Docker sandbox, scaffold, fixtures & observability wiring
- **Build the Docker container first** (requirement): wire the five fixture files (INPUT) and the dashboard (OUTPUT); mount `.env`, do not bake it.
- Project skeleton, TypeScript config, fixtures loaded as a typed module.
- **Ajv schemas for all five fixture field contracts**; wire the validator.
- **`.env` setup:** `WANDB_API_KEY` read from gitignored `.env`; confirm `.env` is in `.gitignore` before any commit. No key hardcoded anywhere.
- **`weave.init("<team>/atomic-research")`** called once at startup; confirm the Anthropic SDK is auto-instrumented.
- Validate the fixtures honor their coverage roles **per researcher** (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread), that every paper carries a populated abstract, every component a populated `source_paper_ids` provenance, and every researcher populated `description` / `research_interests` / `topics`.
- **Confirm scale:** exactly 3 researchers, 30 papers (10 distinct per researcher, **no cross-researcher paper reuse**), 30 feed_items, components and subfield preferences per researcher. Confirm all `publication_date` values fall in the trailing 6-month window (2025-12-06 → 2026-06-06) relative to currentDate 2026-06-06.
- **Confirm synthetic IDs are obviously synthetic** and do not collide with real OpenAlex IDs.
- **Exit:** container builds; fixtures load and validate; schema rejects a deliberately malformed entry; cross-file id joins resolve with no orphans; `weave.init` runs clean; `.env` confirmed gitignored and key not in source.

### Phase 1 — Cross-file join & display ordering (mechanical, no relevance logic)
- Implement the **explicit, mechanical id-join**: `feed_items.researcher_id` / `.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id` all resolve against their parents. The join is never inferred — assert no orphans.
- **`paper_id` is independent of `researcher_id`.** Even though papers are distinct per researcher in the fixtures, no logic may assume a paper belongs to exactly one researcher. The join is by explicit id only.
- **Display ordering:** per researcher, sort `feed_items` by `relevance_score` descending; tie-break by `council_confidence` descending, then `publication_date` recency. This is a pure presentation sort over council outputs — **it makes no relevance decision and introduces no LLM-free relevance logic** (see §2a).
- **No admission filter.** `relevance_decision: false` items are retained and ordered at their score position (no-silent-drop).
- **Exit:** per researcher, all 10 feed_items joined and ordered stably and reproducibly; reject-decision items present in the order; join asserted orphan-free. Unit tests lock the sort and the no-drop behavior.

### Phase 2A — LLM council deliberation (batch, decides relevance)
- **Per researcher, the council deliberates over the full 10-paper set first.** Batch-call the model (Message Batches API) for the council's per-pair decision.
- **Council-call context (required):** each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the researcher's **research components with `source_paper_ids` provenance**, the researcher's **selected subfields**, and the candidate paper's **abstract** and metadata (title, categories, topics). **The council never reasons from the title alone, and subfield match is an explicit factor.**
- **Council output per pair (required):** `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason` (grounded in abstract + matched component(s)/subfield(s)), and `council_deliberation` (the full structured multi-voice reasoning record — the audit trail).
- **Substantive-vs-superficial (required):** the prompt must require the council to distinguish substantive advancement of a thread from surface keyword overlap. A paper whose apparent match overstates its true relevance must be **argued down in `council_deliberation`**, not rubber-stamped. The ambiguous coverage-role paper per researcher is the canonical test of this — deliberation must show real reasoning, not a coin flip.
- **Instrumentation:** the council's own orchestration functions and **every eval assertion** are decorated with `@weave.op()`, so the deliberation trace tree sits in the same Weave tree as the auto-instrumented SDK calls. Because the council is non-deterministic, **this trace tree is the auditability mechanism**, not just telemetry.
- **Exit:** every (researcher, paper) pair carries all five council fields; the per-researcher must-surface / must-dismiss / ambiguous roles are reflected in the decisions; the substantive-vs-superficial reasoning is present in deliberation for the ambiguous case; council calls and `@weave.op()` orchestration visible in the Weave trace tree.

### Phase 2B — Feed summary (post-decision, post-sort, per researcher)
- The `feed_summary` call runs **after** the council has decided that researcher's full set **and after** the feed is sorted by `relevance_score` descending. It takes the decided, sorted feed as input. It is not part of the council batch and **must be unreachable before the council has finished that researcher's set** — enforced in code.
- The summary is a **post-decision editorial call**: a single narrative per researcher naming the 2–3 strongest papers and their collective significance.
- Covered by the degraded-state contract: if it fails, the per-item feed still renders in full.
- Auto-traced by Weave like every other Anthropic call.
- **Exit:** `feed_summary` generated per researcher from the already-decided, already-sorted feed; call ordering verified (summary cannot run before that researcher's council completes); summary visible in Weave trace tree.

### Phase 3 — Two-panel UI (reuse v2 dashboard, add researcher selector)
- Reuse the **existing v2 two-panel dashboard, unchanged in structure.** Left feed panel, right detail panel, independent scroll, collapsible sections; collapsed sections retain enough height to show their section label.
- **Researcher selector** added (3 researchers). Default selection: first researcher, top-ranked feed item.
- **Feed summary at top of the left panel**, above the ranked list — its own region with its own degraded state.
- Left panel feed: per-researcher feed_items in `relevance_score` order, each selectable.
- **Right detail panel** for the selected item: `relevance_reason`, `relevance_decision`, `council_confidence`, the **`council_deliberation` (inspectable)**, the matched component(s), and the researcher's matched subfield(s).
- **Researcher profile view** surfaces the researcher's selected subfields (`research_subfield_preferences`) — shown in the profile in addition to being consumed by the council.
- **Items decided against (`relevance_decision: false`) are not dropped** — they render at their `relevance_score` position with reject reasoning visible, so the demo shows the council *declining*, not only accepting.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) — **retained as a required deliverable**, built here, not deferred, not demoted to stretch.
- **Exit:** first researcher + top item selected on load, sections collapsed to label, full layout per spec, summary region above the list, researcher selector functional; a `relevance_decision: false` item confirmed to render at its score position with reject reasoning; deliberation inspectable.

### Phase 4 — Degraded-state hardening
- Implement the failure contract: no blank panels, no silently dropped feed items.
  - A feed item whose **council decision** could not be produced renders at a **conservative position** with an explicit "decision unavailable — retry" state.
  - If a researcher's **`feed_summary`** fails, that researcher's per-item feed still renders in full; the summary region shows "summary unavailable — retry". The summary is never a single point of failure for the whole feed.
  - Malformed/partial JSON from any model call is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as a retryable error on the relevant panel.
- **Exit:** simulated failures (council decision and feed_summary, independently) render the correct retryable state at the right place without blanking or dropping; malformed-JSON path logged and surfaced.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the aggregate — **per-researcher decision distributions, confidence distributions, accept/reject counts**, batch-call metadata (latency, token count, per-pair decision status), and eval pass/fail.
- **Eval gates (each a `@weave.op()`); aggregate all errors; on any failure, OUTPUT is not written:**
  - Every fixture file validates against its field contract (Ajv).
  - Every cross-file id reference resolves (`feed_items.researcher_id`/`.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id`) — no orphans.
  - Exactly 3 researchers, 30 papers (10 distinct per researcher, no cross-researcher reuse), 30 feed_items.
  - Every feed_item carries all council fields (decision, score, confidence, reason, deliberation).
  - Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 ambiguous).
  - `feed_summary` present per researcher (or its degraded state).
  - Display order matches `relevance_score`-descending sort; reject-decision items not dropped.
- **Exit:** one clean W&B run logged with aggregate metrics + eval results; Weave trace tree and W&B run cross-reference the same iteration; OUTPUT written only on full eval pass.

---

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Downstream reintroduces a deterministic LLM-free relevance sequencer** (the v2 reflex) | §0/§1/§2a forbid it explicitly; the council *decides*, ordering is a mechanical sort only; eval and review reject any LLM-free relevance logic |
| Council non-determinism erodes auditability | `council_deliberation` captured per decision; Weave trace tree of each deliberation is the audit trail; orchestration + evals decorated `@weave.op()` |
| Council rubber-stamps a superficial match | Substantive-vs-superficial prompt instruction (Phase 2A); the paper must be argued down *in deliberation*; ambiguous coverage-role case is the canonical test |
| Council reasons from title alone | Council-call context mandates abstract + components (with `source_paper_ids`) + subfields + metadata (Phase 2A); never title-only |
| Subfield match dropped from deliberation | Subfield match is a required explicit factor (Phase 2A); detail panel + profile both surface subfields (Phase 3) |
| `feed_summary` issued before that researcher's council completes | Call ordering enforced in code (Phase 2B); summary unreachable without a completed decision set + sort |
| `feed_summary` failure blanks the whole feed | Degraded-state contract: per-item feed renders independently per researcher; summary region degrades alone (Phase 4) |
| Reject-decision item silently dropped or hidden | No-silent-drop holds; reject items render at score position with reject reasoning (Phase 1/3); eval asserts presence (Phase 5) |
| Display order non-reproducible | Order is a pure sort over frozen council outputs (`relevance_score` desc, then confidence, then recency); locked by unit tests (Phase 1) |
| `paper_id` logic assumes one-researcher ownership | Join is explicit by id; no logic may assume single ownership (Phase 1); asserted |
| Cross-researcher paper reuse slips into fixtures | Eval asserts 10 distinct papers per researcher, no reuse (Phase 0/5) |
| Visual treatment demoted to "stretch" under time pressure | Requirements forbid it; Phase 3 treats it as core exit criteria |
| `WANDB_API_KEY` hardcoded or committed | `.env` gitignored, confirmed Phase 0 before any commit; mounted into Docker, not baked; never in source |
| `.env` baked into the Docker image | Mounted at runtime, not baked (Phase 0); confirmed before build |
| Observability bolted on late / incompletely | Weave wired Phase 0; `@weave.op()` on council + evals Phase 2/5; W&B run Phase 5 — instrumentation is a phase |
| Malformed model JSON crashes a panel | Degraded-state contract Phase 4; caught, logged to observability, surfaced as retryable |
| Scope creep into production pipeline / embeddings | Explicit out-of-scope list; no live API calls, no embeddings, no vector relevance |

---

## 5. Definition of Done

- **The council decides relevance** for all 30 (researcher, paper) pairs; each decision carries `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, and a full `council_deliberation` record. No deterministic LLM-free relevance sequencer exists anywhere in the build.
- Five fixture files validate against their field contracts; all cross-file id joins resolve orphan-free; the join is explicit and mechanical.
- Scale confirmed: 3 researchers, 30 papers (10 distinct each, no cross-researcher reuse), 30 feed_items; all `publication_date` in the 2025-12-06 → 2026-06-06 window; synthetic IDs obviously synthetic.
- Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous with non-trivial deliberation, plus a mid-tier spread).
- Council-call context complete: profile + components (with `source_paper_ids`) + subfields + paper abstract/metadata; subfield match weighed explicitly; never title-only.
- Substantive-vs-superficial reasoning preserved in `council_deliberation` for the ambiguous cases — apparent overstatements argued down, not rubber-stamped.
- Display order is `relevance_score` descending (tie-break confidence, then recency), reproducible and unit-tested; reject-decision items render at their score position, not dropped.
- `feed_summary` generated per researcher from the decided, sorted feed **after** the council completes that researcher's set; renders at the top of the left panel; degrades independently of the per-item feed.
- Two-panel editorial UI matches the output-surface spec: researcher selector, default state (first researcher + top item), independent scroll, collapsible sections; detail panel shows reason, decision, confidence, inspectable deliberation, matched component(s), matched subfield(s); researcher profile surfaces selected subfields; **v2 editorial dark theme with serif titles retained**.
- Degraded-state contract holds under simulated failure for both council decision and `feed_summary`, independently; malformed JSON caught, logged, surfaced as retryable.
- Observability complete and **load-bearing**: Weave traces every Anthropic call and every `@weave.op()` orchestration + eval function (deliberation trees are the audit trail); one W&B run logs per-researcher decision/confidence distributions, accept/reject counts, batch metadata, eval results; both share the single gitignored `.env` key mounted into Docker.
- Runs inside the Docker sandbox; fixtures (INPUT) and dashboard (OUTPUT) wired in; `.env` mounted not baked.
- Eval gates aggregate all errors; OUTPUT is written only on a full pass.
- No production-pipeline code, no live OpenAlex/arXiv/OpenAI calls, no embeddings, no vector relevance.

---

## 6. Explicit Non-Goals

- **No deterministic, LLM-free relevance sequencer** — the v2 principle is reversed; the council decides (§0).
- No numeric admission threshold, no "component cleared" constant, no `Read now / Save / Skip` action mapping — all removed in v3.
- No validation against real researchers, papers, or third parties.
- No citation-graph accuracy claim, venue-quality, or duplicate-detection signals.
- No live embedding, vector similarity, or cosine relevance (council decides; vector columns omitted).
- No live OpenAlex/arXiv ingestion (five fixtures are canonical input).
- No dropping or hiding of `relevance_decision: false` items (every feed item renders at its score position).
- No assumption that a paper belongs to exactly one researcher (join by explicit id only).
- No application-model selection for the Claude Code build session (model ID governs the built artifact's runtime only).
- No multi-user beyond the 3-researcher selector, no persistence beyond the session (status save/dismiss is a dashboard interaction at demo scale), no auth.