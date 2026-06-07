The existing STRATEGY.md is already a complete, faithful, and well-structured translation of the v3.1 delta REQUIREMENTS.md. It correctly captures every load-bearing decision: the grounding stage front-running the council, the three-layer integrity model with its non-negotiable ordering, the fixture inversion, the publications/papers separation, the degraded-state and observability extensions, and the unchanged v3 commitments. No requirements have changed that would invalidate any section. Returning it complete and unmodified.

# STRATEGY.md

## Atomic Research — Paper Relevance Feed (v3.1): Build Strategy

This document translates the **v3.1 delta** (on top of v3) REQUIREMENTS.md into an execution plan. It is binding on downstream implementation. Where requirements decided something at requirements-time (the council reversal, model ID, visual treatment, degraded-state contract, observability stack, **and now the grounding stage + integrity model**), strategy executes it — it does not relitigate it.

**v3.1 supersede notice.** This STRATEGY revises the v3 strategy. The v3 strategy stands in full **except** where the v3.1 delta governs. The load-bearing v3.1 change: **the researcher profile the council consumes is no longer a hand-authored input fixture — it is the validated output of a new grounding stage (Stage 1) that runs *before* the council, LLM-derived from a synthetic publication corpus and validated against it.** Two consequences ripple through this strategy:

1. `research_components.json` and `research_subfield_preferences.json` are **no longer canonical input** — they are **pipeline output** of Stage 1, written only after passing the integrity model.
2. A **new input fixture** appears: `publications.json` (the researcher's own prior body of work), the raw material grounding reads.

**What v3.1 does NOT change** (carried verbatim from v3, do not relitigate): the council *decides* relevance (no deterministic LLM-free sequencer); 3 researchers, 10 distinct candidate papers each; the two-panel editorial UI; `feed_items` decision fields; `feed_summary` as a post-decision per-researcher call; Docker sandbox first; `claude-sonnet-4-6` pinned; `.env` gitignored and mounted-not-baked; no live ingestion; no embeddings. The data remains synthetic — the *boundary* is unchanged; what moves is hand-authoring, from authoring conclusions (components) to authoring raw material (the corpus).

---

## 1. Architecture Overview

A single-page desktop application, run locally, with a clean separation between three layers, now fronted by a grounding stage:

1. **Data layer** — input fixtures: `researchers`, `publications` (**new**, the grounding corpus), and `papers` (candidate papers the council scores). **`publications` and `papers` must never be conflated** — different roles, different files: *publications* are the researcher's past work (input to grounding); *candidate papers* are what the council evaluates for the feed. `research_components` and `research_subfield_preferences` are **no longer input** — they are produced by Stage 1. `feed_items` carry the council's decision fields. Loaded once, validated against field contracts, frozen. No network fetch, no embeddings.
2. **Compute layer** — **Stage 1: the LLM grounding stage** (extraction + integrity model) that *earns* each researcher's profile from `publications.json`; then **Stage 2: the LLM council** that *decides* relevance per (researcher, paper) pair over the **grounded** profile; plus the per-researcher `feed_summary`. Instrumented end-to-end with Weave + W&B.
3. **Presentation layer** — the reused v2 two-panel editorial UI, with a researcher selector and grounding degraded-state.

The crucial design principles:
- **v3 (unchanged):** the council decides relevance; ranking is a pure presentation-order function of `relevance_score`.
- **v3.1 (new):** **the profile is validated, not trusted.** Grounding output earns its place through three ordered integrity layers. `matched_components` in feed items now reference **grounded, validated** components carrying **real `source_paper_ids`** into `publications.json` — genuine intellectual lineage, not asserted lineage.

**Stage ordering is architectural, not incidental.** Grounding is **unreachable-past until complete and validated** — the council cannot run on an ungrounded or unvalidated profile, the same call-ordering discipline v3 applied to `feed_summary`, now applied to the grounding→council dependency. Per researcher: (Stage 1) grounding extracts → integrity model validates → authoritative profile assembled; (Stage 2) council decides over that profile; then feed sort; then `feed_summary`. Enforced in code, not by convention (see Phase G/2A/2B).

---

## 1a. The integrity model (read before Phase G) — three ordered layers

Grounding output is **validated, not trusted.** Three layers run in a fixed order; each catches what the others cannot. The ordering is **non-negotiable**:

> **sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.**

- **Sanitizer (deterministic, carried from the architect's existing pattern):** strip markdown fences, control characters, trailing commas; attempt `JSON.parse`.
- **Layer 1 — Structural validity + repair loop:** structural predicate — parseable object, non-empty, every component/subfield carries a non-empty `source_paper_ids` array and the required fields (name, description, explanation). If structurally invalid, **repair by re-prompting the LLM** with the failure, using the architect's established loop: **capped at 4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), deterministic sanitize after each attempt. Still invalid after 4 → **degraded state**, no partial profile written.
- **Layer 2 — Referential integrity gate (new, deterministic, non-negotiable):** every `source_paper_id` in every extracted component and subfield **must resolve to a real paper in that researcher's `publications.json` corpus.** Any component/subfield citing a non-existent id is **hard-rejected** — deterministic, **cannot be repaired away by re-prompting** (a re-prompt might "fix" a fabricated id by inventing another). This is the layer that makes "genuine intellectual lineage" *true*. A grounding output is **not accepted unless every cited source resolves.**
- **Layer 3 — Evidence-aptness flags (Call 2 output, advisory):** weak-or-fabricated *semantic* lineage is surfaced as advisory flags, **not auto-rejected**. This layer **informs**; Layers 1 and 2 **decide**. It is an LLM validating an LLM — non-deterministic; it must **not** be treated downstream as a hard guarantee, and it **cannot** be relied on to catch a fabricated identifier (that is Layer 2's job).

**Design rule for downstream:** Layer 2 is the deterministic backbone of trust. Layer 1 would happily accept a well-formed component citing a hallucinated paper; only Layer 2 catches it. Never let Layer 3 (advisory) stand in for Layer 2 (deterministic). Never let Layer 1's repair loop attempt to "fix" a referential failure.

---

## 2. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Single-page web app, local | Hackathon laptop target; no server infra needed |
| Language | TypeScript | Type-safe enforcement of fixture field contracts, grounding output shape, and council output shape |
| LLM calls | Anthropic Message Batches API (council deliberations); single calls (grounding extraction Call 1, grounding validation Call 2, feed_summary) | Council deliberations batch as in v3. Grounding's two calls per researcher are sequential (Call 2 audits Call 1) and per-researcher — single calls, Weave-traced. Summary is one post-decision call per researcher. |
| Application model | `claude-sonnet-4-6` (pinned snapshot) | Requirements-level commitment; governs the built artifact's runtime calls (now including both grounding calls) only — not the Claude Code build session. |
| Schema validation | Ajv (JSON Schema) | Validates input fixtures (`researchers`, `publications`, `papers`, `feed_items`) **and** the grounding-output shape of generated `research_components` / `research_subfield_preferences` |
| Observability — per-call | Weave (`weave.init`, auto-instruments Anthropic SDK; `@weave.op()` on grounding orchestration + every integrity-layer assertion + council orchestration + every eval assertion) | Grounding is now the **trust foundation**; its trace tree — extraction reasoning, repair attempts, validation flags — is part of the audit trail |
| Observability — per-run | Weights & Biases (one run per fixture/prompt iteration) | Adds **grounding metrics** (per researcher: components extracted, components surviving the referential gate, repair attempts used, aptness flags raised) alongside v3's council metrics |
| Secrets | `WANDB_API_KEY` from gitignored `.env`, mounted into Docker (not baked) | Required: never hardcoded, never committed |
| Sandbox | Docker container; fixtures (INPUT) + dashboard (OUTPUT) wired in; `.env` mounted | Required: build the container before application code |
| Styling | Hand-authored CSS, no heavy framework | Editorial visual treatment is bespoke; frameworks fight the design |

**Out of scope (must not be built or stubbed with live calls):** OpenAlex/arXiv ingestion (the `publications` corpus is synthetic, no live fetch), embedding computation, cosine-similarity/vector relevance, weekly centroid refresh, any deterministic LLM-free relevance sequencer, **and any treatment of Layer 3 aptness flags as a hard gate.** These are explicitly frozen or reversed for this POC.

---

## 2a. Decision model (unchanged from v3 — read before Phase 2A)

v3's decision model stands in full. Restated for continuity:

1. **The council decides admission, not a threshold.** `relevance_decision: false` items are **not dropped** — they render at their `relevance_score` position with reject reasoning visible.
2. **`relevance_score` (0–1)** is the only ordering signal; display order is descending, tie-broken by `council_confidence` then `publication_date` recency.
3. **`council_confidence` (0–100)** is a distinct axis from `relevance_score`; both render in the detail panel.
4. **Subfield match is an explicit council factor**, weighed alongside component / focus / substantive-vs-superficial — a consideration inside deliberation, never a numeric gate.

**No numeric cutoffs are strategy-originated.** The substantive-vs-superficial test generalizes v2's tangential-honesty rule. **v3.1 addition:** the components and subfields the council now weighs are the **grounded, validated** ones from Stage 1 — `matched_components` reference real lineage into `publications.json`, not asserted lineage.

---

## 3. Build Phases

### Phase 0 — Docker sandbox, scaffold, fixtures & observability wiring
- **Build the Docker container first** (requirement): wire input fixtures (INPUT) and the dashboard (OUTPUT); mount `.env`, do not bake it.
- Project skeleton, TypeScript config, fixtures loaded as a typed module.
- **Ajv schemas for all input fixture field contracts** (`researchers`, **`publications`**, `papers`, `feed_items`) **and** for the grounding-output shape (`research_components` / `research_subfield_preferences` as Stage-1 output); wire the validator.
- **`.env` setup:** `WANDB_API_KEY` read from gitignored `.env`; confirm `.env` is in `.gitignore` before any commit. No key hardcoded anywhere.
- **`weave.init("<team>/atomic-research")`** called once at startup; confirm the Anthropic SDK is auto-instrumented.
- **Validate `publications.json`:** per researcher **~15–20 records** (×3 ≈ 45–60), shaped like OpenAlex/Semantic Scholar (title, abstract, ids, year, venue, topics); **obviously-synthetic identifiers**, no live fetch; **never conflated with the candidate `papers` set** (assert the two id-spaces are kept distinct in role).
- Validate the candidate `papers` honor their coverage roles **per researcher** (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread), every candidate paper carries a populated abstract, and every researcher populated `description` / `research_interests` / `topics`.
- **Confirm scale:** exactly 3 researchers, 30 candidate papers (10 distinct per researcher, **no cross-researcher paper reuse**), 30 feed_items, ~45–60 publication records (15–20 per researcher). Confirm candidate `publication_date` values fall in the trailing 6-month window (2025-12-06 → 2026-06-06) relative to currentDate 2026-06-06.
- **Confirm synthetic IDs are obviously synthetic** (both publications and papers) and do not collide with real OpenAlex IDs.
- **Note:** `research_components.json` / `research_subfield_preferences.json` are **not** authored here — they are Stage-1 output (Phase G). Phase 0 wires their *output* schema, not input fixtures.
- **Exit:** container builds; input fixtures load and validate; schema rejects a deliberately malformed entry; cross-file id joins resolve with no orphans; `publications` validated at scale; `weave.init` runs clean; `.env` confirmed gitignored and key not in source.

### Phase G — Stage 1: LLM grounding + integrity model (NEW, runs before the council)
Per researcher, grounding turns `publications.json` into a **validated authoritative profile**. Enforced in code to be **unreachable-past until complete and validated** — the council cannot run on an ungrounded/unvalidated profile.

- **Call 1 — Extraction (one-shot prompt):** the researcher's **full `publications` corpus** is fed to the LLM as a **one-shot prompt** (a single worked example demonstrating the required structured output). The LLM reads across the whole corpus and emits structured **research components** and **subfield preferences**, each carrying: a **name** and **description**, **`source_paper_ids`** (the specific publications evidencing it), and an **explanation** of why that evidence supports the conclusion. The extraction is self-documenting — it shows its work for audit.
- **Call 2 — Evidence-aptness validation (advisory):** a second LLM call audits Call 1's output: for each component/subfield, does the cited evidence actually *support* the claim, or is the lineage weak/fabricated? It flags unsupported or weak claims. **Advisory only** — it catches *semantic* fabrication ("cited for X but about Y"); it **cannot** be relied on to catch a fabricated *identifier* (Layer 2 does that).
- **Integrity model (the ordered three layers from §1a):**
  - **Sanitize** Call-1 output (strip fences/control chars/trailing commas; `JSON.parse`).
  - **Layer 1 — structural validity + repair loop:** structural predicate; on failure, repair by re-prompting with the failure — **capped at 4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), sanitize after each. Still invalid after 4 → **degraded state**, no partial profile written.
  - **Layer 2 — referential integrity gate (deterministic, non-negotiable):** every `source_paper_id` must resolve to a real paper in that researcher's `publications.json`. **Hard-reject** any component/subfield with a non-resolving id — **never** repaired by re-prompting. If no component survives the gate, that researcher enters the **degraded state**.
  - **Layer 3 — aptness flags:** attach Call-2 results as **advisory flags**; weak-but-real evidence is surfaced for inspection, never auto-rejected.
- **Authoritative profile assembled** per researcher from **what passed** — validated `research_components` + `research_subfield_preferences` carrying **real `source_paper_ids`**, written only after the gate passes.
- **Instrumentation:** decorate the grounding orchestration and **every integrity-layer assertion** with `@weave.op()`; both grounding calls (extraction + validation) are Weave-traced. The grounding trace tree — extraction reasoning, repair attempts, validation flags — is **part of the audit trail**, not telemetry.
- **Exit:** per researcher, either (a) a non-empty validated profile is assembled — every component carries name, description, non-empty `source_paper_ids` (all resolving into `publications.json`), and an explanation; or (b) the researcher is in the documented **"profile grounding unavailable — retry"** degraded state with **no partial profile written**. No grounding run exceeds 4 repair attempts without resolving to acceptance or degraded state. Referential-gate rejections and aptness flags logged via Weave/W&B. Both grounding calls and `@weave.op()` integrity assertions visible in the Weave trace tree.

### Phase 1 — Cross-file join & display ordering (mechanical, no relevance logic)
- Implement the **explicit, mechanical id-join**: `feed_items.researcher_id` / `.paper_id` resolve against parents. **Grounded** `research_components.researcher_id` and `research_subfield_preferences.researcher_id` resolve against `researchers`; their `source_paper_ids` resolve into `publications.json`. The join is never inferred — assert no orphans.
- **`paper_id` is independent of `researcher_id`.** No logic may assume a candidate paper belongs to exactly one researcher. The join is by explicit id only.
- **`source_paper_ids` resolve into `publications` (not `papers`).** Grounding lineage points at the researcher's *own* corpus; never conflate with the candidate-paper id-space.
- **Display ordering:** per researcher, sort `feed_items` by `relevance_score` descending; tie-break by `council_confidence` descending, then `publication_date` recency. A pure presentation sort over council outputs — **no relevance decision, no LLM-free relevance logic.**
- **No admission filter.** `relevance_decision: false` items retained and ordered at their score position (no-silent-drop).
- **Exit:** per researcher, all 10 feed_items joined and ordered stably and reproducibly; reject-decision items present; join asserted orphan-free; grounded-component `source_paper_ids` confirmed to resolve into `publications`. Unit tests lock the sort, the no-drop behavior, and the referential resolution into the corpus.

### Phase 2A — Stage 2: LLM council deliberation (batch, decides relevance, over the grounded profile)
- **Council unreachable until grounding produced a validated profile for that researcher** — enforced in code (same discipline as the feed_summary gate).
- **Per researcher, the council deliberates over the full 10-candidate-paper set first.** Batch-call the model (Message Batches API) for the council's per-pair decision.
- **Council-call context (required):** each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the **grounded, validated research components with their real `source_paper_ids` provenance** (into `publications.json`), the **grounded selected subfields**, and the candidate paper's **abstract** and metadata (title, categories, topics). **The council never reasons from the title alone, and subfield match is an explicit factor.**
- **Council output per pair (required):** `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason`, and `council_deliberation` (the full structured multi-voice reasoning record). `matched_components` now reference **grounded, validated** components — **real lineage**.
- **Substantive-vs-superficial (required):** the prompt must require the council to distinguish substantive advancement of a thread from surface keyword overlap; apparent overstatements **argued down in `council_deliberation`**, not rubber-stamped. The ambiguous coverage-role paper per researcher is the canonical test.
- **Instrumentation:** council orchestration and **every eval assertion** decorated `@weave.op()`; deliberation trace tree sits in the same Weave tree as the auto-instrumented SDK calls and the grounding trace tree.
- **Exit:** every (researcher, paper) pair carries all five council fields; `matched_components` reference grounded components; coverage roles reflected; substantive-vs-superficial reasoning present for the ambiguous case; council calls + `@weave.op()` orchestration visible in the Weave trace tree.

### Phase 2B — Feed summary (post-decision, post-sort, per researcher)
- The `feed_summary` call runs **after** the council has decided that researcher's full set **and after** the feed is sorted by `relevance_score` descending. Not part of the council batch; **unreachable before the council has finished that researcher's set** — enforced in code.
- A **post-decision editorial call**: a single narrative per researcher naming the 2–3 strongest papers and their collective significance.
- Covered by the degraded-state contract: if it fails, the per-item feed still renders in full.
- Auto-traced by Weave.
- **Exit:** `feed_summary` generated per researcher from the already-decided, already-sorted feed; call ordering verified; summary visible in Weave trace tree.

### Phase 3 — Two-panel UI (reuse v2 dashboard, add researcher selector + grounding state)
- Reuse the **existing v2 two-panel dashboard, unchanged in structure.** Left feed panel, right detail panel, independent scroll, collapsible sections retaining label height.
- **Researcher selector** added (3 researchers). Default: first researcher, top-ranked feed item.
- **Feed summary at top of the left panel**, its own region with its own degraded state.
- Left panel feed in `relevance_score` order, each selectable.
- **Right detail panel** for the selected item: `relevance_reason`, `relevance_decision`, `council_confidence`, the inspectable **`council_deliberation`**, the **grounded matched component(s)**, and the researcher's matched subfield(s).
- **Researcher profile view** surfaces the researcher's **grounded** selected subfields and components — now traceable to their `source_paper_ids` in `publications.json`.
- **A researcher in the grounding degraded state** renders a **"profile grounding unavailable — retry"** state; the council does not run for that researcher; other researchers unaffected.
- **Items decided against (`relevance_decision: false`) are not dropped** — they render at their score position with reject reasoning visible.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) — **retained as a required deliverable**, built here, not deferred.
- **Exit:** first researcher + top item selected on load; sections collapsed to label; full layout per spec; summary region above the list; researcher selector functional; a `relevance_decision: false` item renders at its score position with reject reasoning; deliberation inspectable; grounding degraded-state renders correctly for a simulated grounding failure.

### Phase 4 — Degraded-state hardening (extends v3)
- Implement the failure contract: no blank panels, no silently dropped feed items.
  - **Grounding failure (new):** if a researcher's grounding is still structurally invalid after 4 repair attempts **or** no component survives the referential gate, that researcher renders **"profile grounding unavailable — retry"**; the council does **not** run on that researcher; **no partial profile is written**; other researchers unaffected. Referential-gate rejections and aptness flags **logged via Weave/W&B** — inspectable, not silent.
  - A feed item whose **council decision** could not be produced renders at a **conservative position** with an explicit "decision unavailable — retry" state.
  - If a researcher's **`feed_summary`** fails, that researcher's per-item feed still renders in full; the summary region shows "summary unavailable — retry."
  - Malformed/partial JSON from any model call (grounding or council) is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as a retryable error on the relevant panel.
- **Exit:** simulated failures — **grounding (post-4-attempts and referential-wipeout)**, council decision, and feed_summary, independently — render the correct retryable state at the right place without blanking or dropping; malformed-JSON path logged and surfaced; no partial profile written on grounding failure.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the aggregate — v3 council metrics (**per-researcher decision distributions, confidence distributions, accept/reject counts**, batch metadata, eval pass/fail) **plus grounding metrics (new): per researcher — components extracted, components surviving the referential gate, repair attempts used, aptness flags raised.**
- **Eval gates (each a `@weave.op()`); aggregate all errors; on any failure, OUTPUT is not written:**
  - Every input fixture validates against its field contract (Ajv), **including `publications.json` — ~15–20 records per researcher.**
  - Every cross-file id reference resolves — no orphans.
  - **Referential integrity (Layer 2 as eval gate):** every `source_paper_id` in every generated component and subfield resolves to a real paper in that researcher's `publications.json` — **zero orphans.** This is the deterministic enforcement of Layer 2 as an eval gate, not only a runtime check.
  - **Grounding produced a non-empty validated profile** for each researcher (or that researcher is in the documented degraded state).
  - **Every generated component carries** name, description, non-empty `source_paper_ids`, and an extraction explanation.
  - **Repair loop terminates:** no grounding run exceeds 4 repair attempts without resolving to acceptance or the degraded state.
  - Exactly 3 researchers, 30 candidate papers (10 distinct per researcher, no cross-researcher reuse), 30 feed_items.
  - Every feed_item carries all council fields (decision, score, confidence, reason, deliberation).
  - Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 ambiguous).
  - `feed_summary` present per researcher (or its degraded state).
  - Display order matches `relevance_score`-descending sort; reject-decision items not dropped.
- **Exit:** one clean W&B run with council **and grounding** aggregate metrics + eval results; Weave trace tree (grounding + council + summary) and W&B run cross-reference the same iteration; OUTPUT written only on full eval pass.

---

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Council runs on an ungrounded/unvalidated profile** (new trust foundation bypassed) | Council unreachable-past until grounding produces a validated profile; enforced in code (Phase G/2A), same discipline v3 applied to feed_summary |
| **Layer 3 (advisory aptness) treated as a hard gate** | §1a/§2 forbid it; only Layers 1 & 2 decide; Layer 3 informs; review/eval reject any auto-reject on aptness flags |
| **Layer 1 repair loop tries to "fix" a referential failure** | Layer 2 is deterministic and non-repairable; a re-prompt could invent a different fabricated id; hard-reject only, never repair (Phase G) |
| **Fabricated `source_paper_id` slips through** (hallucinated lineage) | Layer 2 deterministic referential gate + eval gate: every id must resolve into that researcher's `publications.json`, zero orphans (Phase G/5) |
| **`publications` and candidate `papers` conflated** | Distinct files, distinct roles, distinct id-spaces; `source_paper_ids` resolve into `publications` only; asserted (Phase 0/1) |
| **Partial profile written on grounding failure** | Degraded-state contract: no partial profile written; researcher renders "profile grounding unavailable — retry" (Phase G/4) |
| **Repair loop runs unbounded** | Capped at 4 attempts, linear backoff 3/6/9/12s, sanitize each; eval asserts termination (Phase G/5) |
| Downstream reintroduces a deterministic LLM-free relevance sequencer (v2 reflex) | Forbidden explicitly; council decides; ordering is a mechanical sort only; eval/review reject any LLM-free relevance logic |
| Council non-determinism erodes auditability | `council_deliberation` + grounding trace tree captured; Weave trace tree is the audit trail; orchestration + integrity assertions + evals `@weave.op()` |
| Grounding non-determinism erodes auditability | Both grounding calls Weave-traced; extraction reasoning, repair attempts, validation flags in the trace tree; W&B grounding metrics logged |
| Council rubber-stamps a superficial match | Substantive-vs-superficial prompt instruction; argued down *in deliberation*; ambiguous case is the canonical test (Phase 2A) |
| Council reasons from title alone | Context mandates abstract + grounded components (with `source_paper_ids`) + subfields + metadata; never title-only (Phase 2A) |
| Subfield match dropped from deliberation | Required explicit factor; detail panel + profile surface grounded subfields (Phase 2A/3) |
| `feed_summary` issued before that researcher's council completes | Call ordering enforced in code (Phase 2B) |
| `feed_summary` failure blanks the whole feed | Degraded-state contract: per-item feed renders independently; summary degrades alone (Phase 4) |
| Reject-decision item silently dropped or hidden | No-silent-drop; reject items render at score position; eval asserts presence (Phase 1/3/5) |
| Display order non-reproducible | Pure sort over frozen council outputs; locked by unit tests (Phase 1) |
| `paper_id` assumes one-researcher ownership | Join explicit by id; no single-ownership assumption (Phase 1) |
| Cross-researcher candidate-paper reuse slips into fixtures | Eval asserts 10 distinct papers per researcher, no reuse (Phase 0/5) |
| `publications` corpus authored as a live fetch | Synthetic, obviously-synthetic ids, no live fetch; boundary unchanged from v3 (Phase 0) |
| Visual treatment demoted to "stretch" | Requirements forbid it; Phase 3 core exit criteria |
| `WANDB_API_KEY` hardcoded/committed | `.env` gitignored, confirmed Phase 0 before any commit; mounted not baked |
| `.env` baked into the Docker image | Mounted at runtime, not baked (Phase 0) |
| Observability bolted on late / incompletely | Weave wired Phase 0; `@weave.op()` on grounding + integrity layers + council + evals; W&B grounding + council metrics Phase 5 |
| Malformed model JSON crashes a panel | Degraded-state contract Phase 4; caught, logged, surfaced as retryable (grounding and council both) |
| Scope creep into production pipeline / embeddings | Explicit out-of-scope list; no live API calls, no embeddings, no vector relevance |

---

## 5. Definition of Done

- **Grounding (Stage 1) earns each researcher's profile:** per researcher, `publications.json` → Call 1 extraction (one-shot) → integrity model (sanitize → Layer 1 → Layer 2 → Layer 3) → a **validated** profile, **or** that researcher is in the documented "profile grounding unavailable — retry" degraded state with **no partial profile written**.
- **Referential integrity holds:** every `source_paper_id` in every generated component and subfield resolves to a real paper in that researcher's `publications.json` — **zero orphans**, enforced both at runtime (Layer 2) and as an eval gate.
- **Every generated component carries** name, description, non-empty `source_paper_ids`, and an extraction explanation; aptness flags attached as advisory only, never auto-rejecting.
- **Repair loop terminates:** no grounding run exceeds 4 attempts (linear backoff 3/6/9/12s, sanitize each) without resolving to acceptance or the degraded state.
- **The council (Stage 2) is unreachable until grounding produced a validated profile** for that researcher; the council decides relevance for all 30 (researcher, paper) pairs over the **grounded** profile; each decision carries `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, full `council_deliberation`; `matched_components` reference **grounded, validated** components — real lineage. No deterministic LLM-free relevance sequencer exists.
- Input fixtures validate against their field contracts (`researchers`, **`publications`**, `papers`, `feed_items`); generated profile output validates against its shape; all cross-file id joins resolve orphan-free.
- Scale confirmed: 3 researchers, 30 candidate papers (10 distinct each, no cross-researcher reuse), 30 feed_items, **~45–60 publication records (15–20 per researcher)**; candidate `publication_date` in the 2025-12-06 → 2026-06-06 window; synthetic IDs (publications and papers) obviously synthetic; **`publications` and candidate `papers` never conflated.**
- Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous with non-trivial deliberation, plus a mid-tier spread).
- Council-call context complete: profile + **grounded** components (with `source_paper_ids`) + grounded subfields + paper abstract/metadata; subfield match weighed explicitly; never title-only.
- Substantive-vs-superficial reasoning preserved in `council_deliberation` for the ambiguous cases.
- Display order is `relevance_score` descending (tie-break confidence, then recency), reproducible and unit-tested; reject-decision items render at their score position, not dropped.
- `feed_summary` generated per researcher from the decided, sorted feed **after** the council completes that researcher's set; renders at top of the left panel; degrades independently.
- Two-panel editorial UI matches the output-surface spec: researcher selector, default state (first researcher + top item), independent scroll, collapsible sections; detail panel shows reason, decision, confidence, inspectable deliberation, **grounded** matched component(s), matched subfield(s); researcher profile surfaces grounded subfields/components traceable to `publications.json`; **v2 editorial dark theme with serif titles retained**.
- Degraded-state contract holds under simulated failure for **grounding (post-4-attempts and referential-wipeout)**, council decision, and `feed_summary`, independently; no partial profile written on grounding failure; malformed JSON caught, logged, surfaced as retryable.
- Observability complete and **load-bearing**: Weave traces every Anthropic call (both grounding calls, council, summary) and every `@weave.op()` orchestration + integrity-layer + eval function; one W&B run logs **grounding metrics (components extracted, surviving the referential gate, repair attempts used, aptness flags raised)** plus council metrics, accept/reject counts, batch metadata, eval results; both share the single gitignored `.env` key mounted into Docker.
- Runs inside the Docker sandbox; fixtures (INPUT) and dashboard (OUTPUT) wired in; `.env` mounted not baked.
- Eval gates aggregate all errors; OUTPUT is written only on a full pass.
- No production-pipeline code, no live OpenAlex/arXiv/OpenAI calls, no embeddings, no vector relevance, no live publication ingestion.

---

## 6. Explicit Non-Goals

- **No deterministic, LLM-free relevance sequencer** — the v2 principle is reversed; the council decides.
- **No trusting (vs. validating) the grounding output** — the profile is earned through the three-layer integrity model; no profile is accepted unvalidated.
- **No treating Layer 3 (aptness flags) as a hard gate** — advisory only; Layers 1 and 2 decide.
- **No repairing a referential failure by re-prompting** — Layer 2 hard-rejects deterministically; re-prompts only address structural (Layer 1) failures.
- **No partial profile on grounding failure** — degraded state, nothing written.
- **No hand-authoring of `research_components` / `research_subfield_preferences`** — they are Stage-1 output, not input; the hand-authoring moves back to the synthetic `publications` corpus.
- **No conflation of `publications` (grounding corpus) and candidate `papers` (council input)** — different roles, different files, different id-spaces.
- No numeric admission threshold, no "component cleared" constant, no `Read now / Save / Skip` action mapping — removed in v3.
- No validation against real researchers, papers, or third parties.
- No citation-graph accuracy claim, venue-quality, or duplicate-detection signals.
- No live embedding, vector similarity, or cosine relevance.
- No live OpenAlex/arXiv ingestion — neither candidate papers nor the publications corpus is fetched.
- No dropping or hiding of `relevance_decision: false` items.
- No assumption that a candidate paper belongs to exactly one researcher (join by explicit id only).
- No application-model selection for the Claude Code build session (model ID governs the built artifact's runtime only — now including both grounding calls).
- No multi-user beyond the 3-researcher selector, no persistence beyond the session, no auth.