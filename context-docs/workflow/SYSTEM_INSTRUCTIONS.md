# SYSTEM_INSTRUCTIONS.md

## Atomic Research — Paper Relevance Feed (v3.1): Build Instructions for Claude Code

These are operational instructions for building this project. They execute ARCHITECTURE.md, which executes STRATEGY.md, which executes REQUIREMENTS.md. **Do not relitigate decisions made upstream** — the council reversal, the model ID, the council-decides design, the dropped guardrail, the two-stage LLM call ordering, the Docker sandbox, the degraded-state contract, the observability stack, **and now the grounding stage + the three-layer integrity model** are all settled. Your job is to implement them faithfully.

**v3.1 supersede notice.** This document revises the v3 SYSTEM_INSTRUCTIONS. The v3 instructions stand in full **except** where the v3.1 delta governs. The load-bearing v3.1 change: **the researcher profile the council consumes is no longer a hand-authored input fixture — it is the validated OUTPUT of a new grounding stage (Stage 1) that runs *before* the council, LLM-derived from a synthetic publication corpus and validated against it.** Two structural consequences ripple through everything below:

1. `research_components.json` and `research_subfield_preferences.json` are **no longer input fixtures** — they are **Stage-1 pipeline output**, written only after passing the integrity model. You wire their *output* schema, not an input contract.
2. A **new input fixture** appears: `publications.json` (the researcher's own prior body of work), the raw material grounding reads.

**v3 carry-over (do not relitigate):** relevance is DECIDED by a multi-agent LLM council, not computed by a deterministic LLM-free function. The prior v2 principle — "ranking and recommended action are deterministic, LLM-free pure functions; the LLM only explains" — remains **deliberately reversed and removed.** If you find yourself building a deterministic LLM-free relevance sequencer, a numeric admission threshold, a "component cleared" constant, or a `Read now / Save / Skip` action mapping, **stop — you have misread the architecture and contradicted STRATEGY §0/§2a.** **v3.1 adds a second class of forbidden patterns:** if you treat Layer 3 (aptness flags) as a hard gate, repair a Layer 2 referential failure by re-prompting, or write a partial profile on grounding failure, **stop — you have contradicted STRATEGY §1a/§6 and ARCHITECTURE §0b.**

---

## 0. The Two Principles You Must Not Violate

**Principle 1 (v3, unchanged): The council DECIDES relevance per (researcher, paper) pair. The only thing that stays deterministic in the relevance path is the display ordering — a mechanical sort over the council's `relevance_score`.**

The council produces `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, the grounding fields (`matched_components[].match_explanation`, `matched_subfields`), and the full `council_deliberation` record. The sort is *not* a relevance decision — it is a pure presentation-order function over council outputs (`relevance_score` descending, tie-break `council_confidence` descending, then `publication_date` recency).

If you ever find yourself wiring an LLM-free function into the relevance *decision* — a threshold gate, a "component cleared" constant, an action mapping — stop. Those v2 constructs are **deleted**. The council decides; ordering only sorts.

**Principle 2 (v3.1, new): The profile is VALIDATED, not trusted. Grounding output earns its place through three ordered integrity layers, and the council is unreachable until grounding has produced a validated profile.**

The researcher's components and subfields are no longer hand-authored. They are extracted by an LLM from the researcher's own `publications.json` corpus and then **validated against that corpus** before the council may consume them. `matched_components` in feed items now reference **grounded, validated** components carrying **real `source_paper_ids`** that resolve into `publications.json` — genuine intellectual lineage, not asserted lineage.

**The deliberation record AND the grounding trace tree are both load-bearing.** Because both stages are non-deterministic, `council_deliberation` captured per decision **and** the grounding trace tree (extraction reasoning, repair attempts, validation flags), both traced in Weave, **are the audit trail** that buys back the defensibility determinism gave up. They are not optional polish.

---

## 0a. The Integrity Model — Read This Before Building Stage 1

The grounding stage introduces a **three-layer validation pipeline** with a fixed, **non-negotiable** order. **This is NOT the dropped escalate-only guardrail** — there is no urgency enum, no asymmetric-cost ramp, no escalate-only postflight. This is a deterministic validation gate with one LLM repair loop. Do not confuse them.

The order is:

> **sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.**

- **Sanitizer (deterministic):** strip markdown fences, control characters, trailing commas; attempt `JSON.parse`. (Carried from the existing pattern.)
- **Layer 1 — Structural validity + repair loop:** the *predicate* is deterministic — parseable object, non-empty, every component/subfield carries a non-empty `source_paper_ids` array and the required fields (`name`, `description`, `explanation`). If structurally invalid, **repair by re-prompting the LLM** with the failure: **capped at 4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), deterministic sanitize after each attempt. Still invalid after 4 → **degraded state**, no partial profile written.
- **Layer 2 — Referential integrity gate (deterministic, non-negotiable):** every `source_paper_id` in every extracted component and subfield **must resolve to a real paper in that researcher's `publications.json` corpus.** Any component/subfield citing a non-existent id is **hard-rejected deterministically** — **never repaired by re-prompting** (a re-prompt might "fix" a fabricated id by inventing another). This is the layer that makes "genuine intellectual lineage" *true*. If no component survives the gate, the researcher enters the degraded state.
- **Layer 3 — Evidence-aptness flags (advisory):** Call 2's output surfaces weak-or-fabricated *semantic* lineage as advisory flags. It **informs, never auto-rejects.** Layers 1 and 2 **decide.** Layer 3 catches "cited for X but about Y" — it **cannot** catch a fabricated identifier (that is Layer 2's job) and **must not** be relied on to.

**Three architectural prohibitions you must enforce in code AND eval:**
1. Never let Layer 3 (advisory) auto-reject anything.
2. Never let Layer 1's repair loop attempt to "fix" a referential (Layer 2) failure.
3. Never write a partial profile on grounding failure — the researcher carries the degraded state only.

If you find yourself violating any of these three, **stop — you have contradicted ARCHITECTURE §0b / STRATEGY §1a.**

---

## 0b. Docker Sandbox — Build This First

**The entire application runs inside a Docker sandbox container.** This is settled upstream (ARCHITECTURE §0a-a) and is not optional.

- **Build all Docker components first**, before any application code. The container is the secure boundary Claude Code operates within.
- The pipeline, the dashboard server, and all dependencies (`@anthropic-ai/sdk`, `ajv`, `typescript`/`tsx`, `weave`, `wandb`) run inside the container.
- The gitignored `.env` carrying `WANDB_API_KEY` is mounted into the container, not baked into the image. The key never lands in a layer, never gets committed.
- `data/` (INPUT — now **four** fixtures: `researchers.json`, **`publications.json`**, `papers.json`, `feed_items.json`) and `public/` (OUTPUT) are wired so the pipeline can read fixtures and write `output_data.json`, and the dashboard server can serve it, all within the sandbox. **`research_components.json` / `research_subfield_preferences.json` are NOT wired as input — they are Stage-1 output.**
- **Gate (Docker):** the container builds clean; the pipeline and dashboard server both run inside it; `.env` is mounted (not baked) and confirmed gitignored. Do not start Phase 0 application work until the sandbox builds and runs.

---

## 1. Non-Negotiables (settled upstream — do not revisit)

- **Docker sandbox:** the application is containerized; build Docker components first; Claude Code operates inside the sandbox. Do not run the application outside the container.
- **Model ID:** `claude-sonnet-4-6` (pinned snapshot). Do not substitute, do not add a date suffix, do not "upgrade." Governs the built artifact's runtime calls only — **now including both grounding calls** — not your build session.
- **Grounding is validated, not trusted.** Per researcher, `publications.json` → extraction Call 1 → integrity model (sanitize → Layer 1 + repair → Layer 2 → Layer 3) → a **validated** profile, **or** the degraded state with **no partial profile written.** The three integrity prohibitions (§0a) are enforced in code and eval.
- **The council is unreachable until grounding produced a validated profile** for that researcher — enforced in code (`orchestrator.ts`), the same call-ordering discipline applied to `feed_summary`. If grounding ends degraded, the council does **not** run for that researcher.
- **Referential integrity is the backbone of trust.** Every `source_paper_id` in every generated component and subfield resolves to a real paper in that researcher's `publications.json` — **zero orphans** — enforced both at runtime (Layer 2) and as an eval gate. `source_paper_ids` resolve into the `publications` id-space **only**, never the candidate `papers` id-space.
- **`publications` and candidate `papers` are never conflated.** Different roles, different files, different id-spaces: *publications* are the researcher's past work (input to grounding); *candidate papers* are what the council evaluates for the feed.
- **The council decides relevance.** Each (researcher, paper) pair gets a `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason`, and a full `council_deliberation` record — all from the council, all LLM-decided, all **over the grounded, validated profile.** There is **no deterministic LLM-free relevance logic anywhere.**
- **No numeric admission threshold, no "component cleared" constant, no `Read now / Save / Skip` action mapping.** All three v2 constructs are **deleted.** Do not reintroduce any of them.
- **No silent drop.** `relevance_decision: false` items are **retained** and render at their `relevance_score` position with reject reasoning visible — the demo must show the council *declining*, not only accepting. Do not filter any feed item out.
- **No partial profile on grounding failure.** A researcher whose grounding fails carries `grounding_status: "unavailable"` and renders the grounding degraded state; the council does not run for them; nothing partial is written.
- **Display ordering is a pure sort, not a decision.** `relevance_score` descending; tie-break `council_confidence` descending, then `publication_date` recency. This is `sequencer.ts` — LLM-free, ordering only, no relevance judgment.
- **Runtime council is canonical (§1a).** The fixtures ship with pre-populated decision fields as seed input. At runtime the council **overwrites** them. Divergence between fixture seed and runtime output is **expected and is not an eval failure.** Never assert runtime output equals fixture seed values. **The grounded profile is likewise canonical over any seed shape** — eval validates its structural and referential properties, never that it equals a pre-authored conclusion.
- **LLM surface:** the **two grounding calls per researcher** (extraction Call 1 + aptness validation Call 2), the council's per-pair deliberation (decision + score + confidence + reason + grounding + deliberation record), **plus** the post-decision per-researcher `feed_summary`. Nothing else.
- **No guardrail skill.** The escalate-only guardrail has no referent here — there is no urgency enum to ratchet. The integrity model is a *deterministic* three-layer validation gate, **not** the escalate-only wrapper (§0a). Do not add a guardrail. Do not confuse the integrity model with one.
- **No production-pipeline code.** No OpenAlex/arXiv ingestion (the `publications` corpus is synthetic — no live fetch), no embeddings, no cosine/vector similarity, no centroid refresh, no live third-party calls.
- **Batches API for council deliberations, not per-case fan-out.** All 10 per-pair deliberation requests per researcher go through the Message Batches API. The grounding calls (per-researcher, sequential — Call 2 audits Call 1) are single calls, not batched. Do not `Promise.all` one subagent per pair.
- **Call ordering is architectural.** Per researcher: **grounding deliberates first** (extraction → integrity model → validated profile) → council deliberates the full 10-paper set over the grounded profile → sort by `relevance_score` desc → `feed_summary` runs post-decision, post-sort. Enforce in code (`orchestrator.ts`, ARCHITECTURE §2c): the council batch is unreachable before grounding produced a validated profile; the summary call is unreachable before the council batch completes and the feed is sorted.
- **Council never reasons from the title alone, nor from asserted lineage.** Each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the **grounded, validated** research components with their real `source_paper_ids` provenance (into `publications.json`), the **grounded** selected subfields, and the candidate paper's abstract + metadata.
- **Subfield match is an explicit council factor** — weighed alongside component match, focus match, and the substantive-vs-superficial test, as a consideration *inside deliberation*, never a numeric gate.
- **Substantive-vs-superficial discipline:** a paper matching on surface terms but not substance must be **argued down in `council_deliberation`**, never rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
- **`paper_id` is independent of `researcher_id`.** Papers are distinct per researcher in the fixtures, but no logic may assume a paper belongs to exactly one researcher. Join by explicit id only.
- **Recency is a tie-break, not a relevance signal** — age within the window only ever serves as a final tie-break in the sort.

---

## 1a. Observability Is a Phase, Not an Afterthought — and Load-Bearing Across Both Stages

Weave + W&B are the primary instrumentation surface, wired before any LLM call. In v3.1, Weave is **load-bearing for auditability across both stages** — the grounding trace tree (extraction reasoning, repair attempts, validation flags) **and** the council deliberation trace tree are both the audit trail, not just telemetry. All of this runs inside the Docker sandbox.

- **Weave (per-call):** `weave.init("<team>/atomic-research")` is called **once at startup in `run.ts`, before any Anthropic call.** It auto-instruments the Anthropic SDK so **both grounding calls (extraction Call 1, aptness Call 2)**, every per-pair council deliberation call, and every feed_summary call appear in the trace tree. Decorate team functions — **the grounding orchestration + every integrity-layer assertion**, the council orchestration logic, and **every eval assertion** — with `@weave.op()` so they sit in the same trace tree as the SDK calls. Because both stages are non-deterministic, **this trace tree is the auditability mechanism.**
- **W&B (per-run):** one `wandb` run per fixture/prompt iteration logs the pipeline aggregate — v3 council metrics (**per-researcher decision distributions, confidence distributions, accept/reject counts**, batch-call metadata, eval pass/fail) **plus grounding metrics (new): per researcher — components extracted, components surviving the referential gate, repair attempts used, aptness flags raised.**
- **Secrets:** `WANDB_API_KEY` read from a **gitignored `.env`**, mounted into the container (not baked into the image). Confirm `.env` is in `.gitignore` **before any commit.** Never hardcode, never commit the key, never bake it into a Docker layer.
- **Cross-reference:** the Weave trace tree (grounding + council + summary) and the W&B run must reference the same iteration.

---

## 2. Build In This Order

Follow the phase order. Do not start a phase before the prior phase's gate passes. **The Docker sandbox (§0b) is built before Phase 0.**

### Phase 0 — Scaffold, fixtures & observability wiring
- TypeScript project skeleton inside the container; add `@anthropic-ai/sdk`, `ajv`, `typescript` + `tsx`, `weave`, `wandb`.
- Embed the **four input fixtures** as `data/researchers.json`, **`data/publications.json`**, `data/papers.json`, `data/feed_items.json`. Every candidate paper carries a populated abstract; every researcher populated `description` / `research_interests` / `topics`; every publication record shaped like OpenAlex/Semantic Scholar (title, abstract, ids, year, venue, topics) with **obviously-synthetic identifiers.** The synthetic `feed_items` already carry the council's decision fields (seed input — runtime overwrites them, §1a).
- **Do NOT author `research_components.json` / `research_subfield_preferences.json` as input** — they are Stage-1 output (Phase G). Wire their *output* schema here, not an input contract.
- Write Ajv schemas for **all four input fixture field contracts** (`researchers`, **`publications`**, `papers`, `feed_items`), the **grounded Stage-1 output shape** (`research_components` / `research_subfield_preferences` as output — see §4.0), the per-item output contract, **and the feed_summary contract**; wire the validator.
- **Validate `publications.json` at scale:** per researcher **~15–20 records** (×3 ≈ 45–60), obviously-synthetic ids, no live fetch; **never conflated with the candidate `papers` id-space** (assert the two id-spaces are kept distinct in role).
- Validate candidate `papers` honor their coverage roles **per researcher** (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread).
- **Confirm scale:** exactly 3 researchers, 30 candidate papers (10 distinct per researcher, **no cross-researcher paper reuse**), 30 feed_items, **~45–60 publication records (15–20 per researcher).** Confirm candidate `publication_date` values fall in the trailing 6-month window (2025-12-06 → 2026-06-06) relative to currentDate 2026-06-06.
- **Confirm synthetic IDs are obviously synthetic** (both publications and papers) and do not collide with real OpenAlex IDs.
- Wire observability: `weave.init` runs clean; `.env` confirmed gitignored and key not in source (and not in any Docker layer).
- **Gate (Slice 0 / INPUT gate):** container builds; the four input fixtures load and validate; a deliberately malformed entry is rejected; cross-file id joins resolve with no orphans; `publications.json` validated at scale (~15–20 per researcher) and confirmed distinct in role from candidate `papers`; the Stage-1 output schema is wired but not authored; `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes.

### Phase G — Stage 1: LLM grounding + integrity model (NEW, runs before the council)
Per researcher, grounding turns `publications.json` into a **validated authoritative profile**. Enforced in code to be **unreachable-past until complete and validated** — the council cannot run on an ungrounded/unvalidated profile.

- Implement `subagent.ts` grounding calls, `skills/grounding.ts`, and `integrity.ts`.
- **Call 1 — Extraction (one-shot prompt):** feed the researcher's **full `publications` corpus** to the LLM as a **one-shot prompt** (a single worked example demonstrating the required structured output). The LLM reads across the whole corpus and emits structured **research components** and **subfield preferences**, each carrying `name`, `description`, **`source_paper_ids`** (the specific publications evidencing it), and an **`explanation`** of why that evidence supports the conclusion. The extraction is self-documenting — it shows its work for audit.
- **Call 2 — Evidence-aptness validation (advisory):** a second LLM call audits Call 1's output — for each component/subfield, does the cited evidence actually *support* the claim, or is the lineage weak/fabricated? It flags unsupported or weak claims. **Advisory only** — it catches *semantic* fabrication ("cited for X but about Y"); it **cannot** be relied on to catch a fabricated *identifier* (Layer 2 does that).
- **Integrity model (`integrity.ts`, the ordered three layers from §0a):**
  - **Sanitize** Call-1 output (strip fences/control chars/trailing commas; `JSON.parse`).
  - **Layer 1 — structural validity + repair loop:** structural predicate; on failure, repair by re-prompting with the failure — **capped at 4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), sanitize after each. Still invalid after 4 → **degraded state**, no partial profile written.
  - **Layer 2 — referential integrity gate (deterministic, non-negotiable):** every `source_paper_id` must resolve to a real paper in that researcher's `publications.json`. **Hard-reject** any component/subfield with a non-resolving id — **never** repaired by re-prompting. If no component survives, that researcher enters the degraded state.
  - **Layer 3 — aptness flags:** attach Call-2 results as **advisory flags**; weak-but-real evidence is surfaced for inspection, never auto-rejected.
- **Authoritative profile assembled** per researcher from **what passed** — validated `research_components` + `research_subfield_preferences` carrying **real `source_paper_ids`**, written only after the gate passes.
- **Three prohibitions enforced here (§0a):** Layer 3 never auto-rejects; the Layer 1 repair loop never attempts to fix a Layer 2 referential failure; no partial profile is ever returned on failure.
- **Instrumentation:** decorate the grounding orchestration and **every integrity-layer assertion** with `@weave.op()`; both grounding calls are Weave-traced. The grounding trace tree — extraction reasoning, repair attempts, validation flags — is **part of the audit trail**, not telemetry.
- **First runnable slice (Stage 1 first):** `run.ts → weave.init → subagent.ts (extraction Call 1 + aptness Call 2 for ONE researcher) → integrity.ts (sanitize → Layer 1 → Layer 2 → Layer 3) → assemble that researcher's validated profile.` Get this clean before fanning out to all three researchers and before exercising the repair loop.
- **Gate:** per researcher, either (a) a non-empty validated profile is assembled — every component carries `name`, `description`, non-empty `source_paper_ids` (all resolving into `publications.json`), and an `explanation`; or (b) the researcher is in the documented `grounding_status: "unavailable"` degraded state with **no partial profile written.** No grounding run exceeds 4 repair attempts without resolving to acceptance or degraded state. Referential-gate rejections and aptness flags logged via Weave/W&B. Both grounding calls and `@weave.op()` integrity assertions visible in the Weave trace tree.

### Phase 1 — Cross-file join & display ordering (mechanical, NO relevance logic)
- Implement `join.ts` as a **pure, LLM-free function**: `feed_items.researcher_id` / `.paper_id` resolve against parents; **grounded** `research_components.researcher_id` and `research_subfield_preferences.researcher_id` resolve against `researchers`, and their **`source_paper_ids` resolve into `publications.json` (not `papers`).** The join is **never inferred** — assert no orphans. By explicit id only; **no single-ownership assumption for papers.** **Publications and candidate papers are distinct id-spaces.**
- Implement `sequencer.ts` as a **pure, LLM-free function — ordering only.** Per researcher, sort `feed_items` by `relevance_score` descending; tie-break `council_confidence` descending, then `publication_date` recency. Assign the `position` label. This is a pure presentation sort over council outputs — **it makes no relevance decision and introduces no LLM-free relevance logic.**
- **No admission filter:** `relevance_decision: false` items are retained and ordered at their score position (no-silent-drop).
- **Recency gate, not ranking signal:** add a window-eligibility assertion (2025-12-06 → 2026-06-06); all candidate fixtures must be in-window; age within the window only ever serves as a final tie-break.
- **No threshold, no "component cleared" constant, no action mapping.** These v2 constructs are deleted. The sequencer makes a *display order* and nothing more.
- **Gate:** per researcher, all 10 feed_items joined and ordered stably and reproducibly; reject-decision items present at their score position; join asserted orphan-free; grounded-component `source_paper_ids` confirmed to resolve into `publications`; unit tests lock the sort, the no-drop behavior, and the referential resolution into the corpus.

### Phase 2A — Stage 2: LLM council deliberation (batch, DECIDES relevance, over the grounded profile)
- Implement `subagent.ts` council calls (wraps Message Batches API for per-pair deliberations, `maxRetries: 3`), `skills/council.ts`, `orchestrator.ts`, `eval.ts`, `run.ts`, `logger.ts`.
- **Council unreachable until grounding produced a validated profile for that researcher** — enforced in code (`orchestrator.ts`), same discipline as the feed_summary gate.
- **First runnable slice: one (researcher, paper) pair end-to-end, AFTER grounding** — `run.ts → weave.init → grounding for ONE researcher (Phase G slice) → join.ts → subagent.ts (council deliberation for ONE pair over that grounded profile) → sequencer.ts (sort that one-item feed) → eval.ts (schema gate + referential-integrity gate) → write OUTPUT for that one pair.` **Grounding must run and validate before the council call** — the slice proves the call-ordering discipline end-to-end. Get this clean before fanning out to the full 30-pair batch, before the per-researcher feed_summary calls, before the ambiguous-case substantive-vs-superficial verification, before coverage-role and no-drop assertions, and before degraded-state handling.
- **Per researcher, the council deliberates over the full 10-paper set first.** Batch-call the model (Message Batches API) for the council's per-pair decision.
- **Council-call context (required):** each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the **grounded, validated research components with their real `source_paper_ids` provenance** (into `publications.json`), the **grounded** selected subfields, and the candidate paper's **abstract** and metadata (title, categories, topics). **Never title-only, never asserted lineage; subfield match is an explicit factor.**
- **Council output per pair (required):** `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason` (grounded in abstract + matched component(s)/subfield(s)), `matched_components[].match_explanation`, `matched_subfields`, and the full `council_deliberation` record. `matched_components` reference **grounded, validated** components — **real lineage** into `publications.json`.
- **Substantive-vs-superficial instruction (system prompt):** the council must distinguish substantive advancement of a research thread from surface keyword overlap. A paper whose apparent match overstates its true relevance must be **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test — deliberation must show real reasoning, not a coin flip.
- **Subfield weighing recorded:** `council_deliberation.subfield_weighing` must be present and substantive, including the case where subfield match was *not* a deciding factor (the paper matched on components/focus instead). An accepted item need not carry a non-empty `matched_subfields`.
- **Runtime council is canonical (§1a):** the orchestrator **overwrites** the fixture seed decision fields with the runtime council's values in the OUTPUT artifact. Divergence from the seed is expected and not flagged.
- **Instrumentation:** the council orchestration functions and **every eval assertion** are decorated `@weave.op()`, so the deliberation trace tree sits in the same Weave tree as the auto-instrumented SDK calls and the grounding trace tree. **This trace tree is the auditability mechanism.**
- **Gate:** every (researcher, paper) pair carries all five council fields plus the grounding fields; `matched_components` reference grounded components; per-researcher must-surface / must-dismiss / ambiguous roles reflected in the runtime decisions; substantive-vs-superficial reasoning present in deliberation for the ambiguous case; council calls and `@weave.op()` orchestration visible in the Weave trace tree.

### Phase 2B — Feed summary (post-decision, post-sort, per researcher)
- After the council has decided that researcher's full set **and after** the feed is sorted by `relevance_score` descending, issue the single `feed_summary` call against the decided, sorted feed. Enforce ordering in code: the summary call is **unreachable** before that researcher's council batch completes and the sort has produced an order.
- The summary is a **post-decision editorial call**: a single narrative per researcher naming the 2–3 strongest papers and their collective significance.
- It is **not** part of the council batch. Covered by the degraded-state contract: if it fails, that researcher's per-item feed still renders in full.
- Auto-traced by Weave like every other Anthropic call.
- **Gate:** `feed_summary` generated per researcher from the already-decided, already-sorted feed; call ordering verified (summary cannot run before that researcher's council completes); summary visible in Weave trace tree; OUTPUT validates against schema (OUTPUT gate).

### Phase 3 — Two-panel UI (reuse v2 dashboard, add researcher selector + grounding state)
- Implement `dash-app-server.ts`, `dash-app-client.ts`, `dash-app.html`, `dash-app.css`.
- Reuse the **existing v2 two-panel dashboard, unchanged in structure** — left feed panel, right detail panel, independent scroll, collapsible sections.
- Server validates OUTPUT (per-researcher `grounding_status` + grounded profile + `feed` arrays + `feed_summary` objects) at startup; if validation fails, the dashboard does not start. The server is the only component that touches the data file; the client consumes API endpoints only.
- **Researcher selector** added (3 researchers). **Default selection: first researcher, top-ranked feed item.**
- **Feed summary region rendered at the top of the left panel**, above the ranked list — its own region with its own degraded state.
- Left panel feed: per-researcher feed_items in `relevance_score` order (position 1→10), each selectable, below the summary region.
- **Right detail panel** for the selected item: `relevance_reason`, `relevance_decision`, `council_confidence`, the **inspectable `council_deliberation`**, the **grounded matched component(s)**, and the researcher's matched subfield(s).
- **Researcher profile view** surfaces the researcher's **grounded** selected subfields and components — now traceable to their `source_paper_ids` in `publications.json`.
- **A researcher in the grounding degraded state** (`grounding_status: "unavailable"`) renders a **"profile grounding unavailable — retry"** state; the council did not run for that researcher; other researchers are unaffected.
- **No silent drop in the UI:** items with `relevance_decision: false` render at their `relevance_score` position with reject reasoning visible — the demo shows the council *declining*, not only accepting.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) is **core, built here — not deferred to a stretch goal.**
- **Gate:** first researcher + top item selected on load; all right-panel sections collapsed to their label; two-panel layout with independent scroll per spec; feed summary region above the list; researcher selector functional; a `relevance_decision: false` item confirmed to render at its score position with reject reasoning; deliberation inspectable; grounding degraded-state renders correctly for a simulated grounding failure.

### Phase 4 — Degraded-state hardening
- Implement the failure contract as cross-cutting behavior in `integrity.ts` + `subagent.ts` + `orchestrator.ts` + client rendering.
- **Grounding failure (new):** if a researcher's grounding is still structurally invalid after 4 repair attempts **or** no component survives the referential gate, that researcher's profile carries `grounding_status: "unavailable"`; **the council does not run for that researcher; no partial profile is written;** other researchers unaffected. Referential-gate rejections and aptness flags **logged via Weave/W&B** — inspectable, not silent.
- A feed item whose **council decision** could not be produced renders at a **conservative position** with `decision_status: "unavailable"` and an explicit "decision unavailable — retry" state.
- Malformed model JSON from any model call (grounding or council) is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `decision_status: "malformed"` (council) or the grounding degraded state.
- **feed_summary failure is independent:** if a researcher's summary call fails, that researcher's per-item feed still renders in full; the summary region shows "summary unavailable — retry" via `summary_status`. The summary is never a single point of failure for the whole feed.
- No feed item is ever silently dropped or blanked; no partial profile is ever written on grounding failure.
- **Gate:** simulated failures — **grounding (post-4-attempts and referential-wipeout)**, council decision, and feed_summary, independently — render the correct retryable state at the right place without blanking or dropping; malformed-JSON path logged and surfaced; no partial profile written on grounding failure.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the aggregate — v3 council metrics (**per-researcher decision distributions, confidence distributions, accept/reject counts**, batch-call metadata, eval pass/fail) **plus grounding metrics (new): per researcher — components extracted, components surviving the referential gate, repair attempts used, aptness flags raised.**
- Each eval assertion is a `@weave.op()`.
- **Gate:** one clean W&B run logged with council **and grounding** aggregate metrics and eval results; Weave trace tree (grounding + council + summary) and W&B run cross-reference the same iteration; OUTPUT written only on full eval pass.

---

## 3. Component Map (what to build, where)

| File | Layer | Responsibility |
|---|---|---|
| `Dockerfile` (+ compose/`.dockerignore`) | Sandbox | Builds the container the app runs in; `.env` mounted not baked; built first |
| `data/researchers.json` | INPUT | 3 researcher profiles (populated `description` / `research_interests` / `topics`) |
| `data/publications.json` | INPUT (**new**) | Per researcher ~15–20 publication records (the grounding corpus); obviously-synthetic ids; distinct id-space from candidate papers |
| `data/papers.json` | INPUT | 30 distinct candidate papers (10 per researcher, no reuse), populated abstracts |
| `data/feed_items.json` | INPUT | 30 feed_items, council decision fields pre-populated as seed (runtime overwrites, §1a) |
| `research_components.json` / `research_subfield_preferences.json` | **OUTPUT of Stage 1, NOT input** | Grounded, validated per-researcher components/subfields with real `source_paper_ids` into `publications.json`; written only after the integrity model passes |
| `integrity.ts` | Compute (deterministic + LLM repair) | The three-layer integrity model: sanitize → Layer 1 structural+repair (cap 4, backoff 3/6/9/12s) → Layer 2 referential hard-reject → Layer 3 aptness flags → assemble profile from what passed; enforces the three prohibitions; each layer assertion `@weave.op()` |
| `join.ts` | Compute (no LLM) | Explicit, mechanical id-join; grounded `source_paper_ids` resolve into `publications` only; asserts no orphans; no single-ownership assumption |
| `sequencer.ts` | Compute (no LLM) | Per-researcher sort (`relevance_score` desc, tie-break confidence, then recency) + `position` label + window-eligibility assertion + no-drop; pure function, unit-tested |
| `subagent.ts` | Pipeline | Wraps: two sequential grounding single calls per researcher (extraction Call 1 + aptness Call 2, also serves Layer-1 repair re-prompts); Batches API (10 council deliberations per researcher in one batch); single per-researcher feed_summary call; passes grounded profile + abstract/metadata to the council |
| `skills/grounding.ts` | Skill (**new**) | Stage-1 skill: one-shot extraction prompt + aptness validation prompt; `successCriteria` is structural only (Layer 1) — referential validity (Layer 2) belongs to `integrity.ts`, never to a re-prompt |
| `skills/council.ts` | Skill | Stage-2 skill: decides relevance over the grounded profile; decision + substantive-vs-superficial + explicit-factors (subfield) + grounding (real lineage) instructions |
| `orchestrator.ts` | Pipeline | Per researcher: grounding (extraction → integrity → validated profile or degraded) → council batch (unreachable until grounded) → sort → post-decision feed_summary → assembly (overwriting fixture seed, §1a) → eval; enforces call ordering; no per-case fan-out |
| `eval.ts` | Pipeline | Schema gate + sanity checks + referential-integrity gate (Layer 2 as eval) + grounding gates; aggregate errors, no short-circuit; each assertion `@weave.op()` |
| `run.ts` | Entry | CLI; `weave.init` at startup; writes OUTPUT once eval passes; logs W&B run with grounding + council metrics; writes nothing on failure |
| `logger.ts` | Pipeline | JSONL trace; `traceId` through orchestrator → grounding → integrity → subagent → eval; records grounding calls, repair attempts, referential-gate rejections, aptness flags; subordinate to Weave/W&B |
| `dash-app-server.ts` | Dashboard | Validates + serves OUTPUT (per-researcher `grounding_status` + grounded profile + `feed` + `feed_summary`); only file-touching component |
| `dash-app-client.ts` | Dashboard | Rendering/selection/scroll; researcher selector; feed summary region; grounding degraded-state; consumes API only |
| `dash-app.html` | Dashboard | Markup only; no inline styles/scripts |
| `dash-app.css` | Dashboard | External editorial stylesheet |

**Do not build:** `skills/guardrail.ts`, `memory.ts`, any per-case subagent fan-out, any deterministic LLM-free relevance sequencer, any numeric admission threshold, any "component cleared" constant, any `Read now / Save / Skip` action mapping, any treatment of Layer 3 aptness flags as a hard gate, any Layer-1 re-prompt that attempts to "fix" a Layer 2 referential failure, any partial-profile write on grounding failure. These are deliberately dropped, reversed, or prohibited (ARCHITECTURE §0/§0b, STRATEGY §0/§1a/§2a/§6).

---

## 4. The Output Contract

### 4.0 Grounded profile (Stage-1 intermediate) shape

The grounded profile is an intermediate artifact validated before the council consumes it, and carried into OUTPUT per researcher. Ajv enforces this shape (§6).

```json
{
  "researcher_id": "R1",
  "grounding_status": "ok",
  "research_components": [
    {
      "name": "Sparse autoencoder feature steering",
      "description": "<what the component is>",
      "source_paper_ids": ["PUB-R1-03", "PUB-R1-07"],
      "explanation": "<why this evidence supports the conclusion>",
      "aptness_flags": []
    }
  ],
  "research_subfield_preferences": [
    {
      "name": "Mechanistic interpretability",
      "description": "<what the subfield is>",
      "source_paper_ids": ["PUB-R1-01"],
      "explanation": "<why this evidence supports the conclusion>",
      "aptness_flags": []
    }
  ]
}
```

Field rules (eval-locked, §6):
- **`source_paper_ids` resolve into `publications.json` only** — never into the candidate `papers` id-space. This is the genuine-lineage backbone (Layer 2).
- **Every component/subfield carries** a non-empty `name`, `description`, non-empty `source_paper_ids`, and an `explanation` (Layer 1 structural predicate).
- **`aptness_flags`** is the Call-2 advisory output (Layer 3) — surfaced for inspection, **never auto-rejecting.** Empty array = no advisory concern.
- **`grounding_status` ∈ `ok | unavailable`.** `unavailable` = grounding failed (still structurally invalid after 4 repair attempts, or no component survived the referential gate); **no partial profile is written** — the researcher carries the degraded state only and no `feed`.

### 4.1 Per-feed-item contract

Every feed item in `public/output_data.json` must carry these fields. The council-decided fields come from `skills/council.ts` (the runtime council, canonical over any fixture seed, §1a); the grounded `matched_components` originate from the Stage-1 validated profile; `position` comes from `sequencer.ts`; `decision_status` reflects degraded state.

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
      "source_paper_ids": ["PUB-R1-03", "PUB-R1-07"],
      "match_explanation": "<council prose>"
    }
  ],
  "matched_subfields": ["Mechanistic interpretability"],
  "council_deliberation": {
    "voices": [
      { "role": "<deliberation voice>", "argument": "<prose>", "leaning": "<for|against>" }
    ],
    "substantive_vs_superficial": "<argument distinguishing real advancement from surface keyword overlap>",
    "subfield_weighing": "<how subfield match was weighed, including where it was not a deciding factor>",
    "resolution": "<how the council reached its decision>"
  },
  "decision_status": "ok"
}
```

The example `publication_date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06) — every candidate fixture, including this example, is in-window.

**v3.1 lineage note:** `matched_components[].source_paper_ids` reference the **grounded, validated** components from Stage 1 — they resolve into `publications.json` (the researcher's own corpus), **not** the candidate `papers` id-space. The example ids above (`PUB-R1-*`) are publication ids by design. This is real intellectual lineage, not asserted lineage.

**Field provenance — memorize this:**
- **Council-decided (Phase 2A, LLM):** `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, the full `council_deliberation` record. **The council decides these — there is no deterministic LLM-free relevance logic anywhere.** These are the *runtime* council's values, canonical over any fixture seed (§1a).
- **Grounded (Phase G, LLM + integrity model):** the `matched_components` the council references — name and `source_paper_ids` provenance — originate from the Stage-1 validated profile, not from a hand-authored fixture.
- **Deterministic presentation-only (Phase 1, no LLM):** `position` — assigned by the mechanical sort over `relevance_score` descending (tie-break `council_confidence` desc, then `publication_date` recency). `position` is an ordering label, **not a relevance decision.**
- **Component lineage — required and eval-locked:** for every accepted item (`relevance_decision: true`), `matched_components` carries ≥1 entry with a populated `match_explanation` and a populated `source_paper_ids` provenance **resolving into `publications.json`**.
- **Subfield match — weighed, not mandated non-empty (§1a / STRATEGY §2a):** subfield match is an **explicit council factor** weighed *inside* deliberation. Eval does **not** require `matched_subfields` non-empty on every accepted item; it requires `council_deliberation.subfield_weighing` present and substantive, and `matched_subfields` populated **where subfield match was a deciding factor.**
- **`substantive_vs_superficial` — required in deliberation:** a paper whose apparent match overstates its true relevance must be **argued down**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
- **No-silent-drop:** items with `relevance_decision: false` are **retained** and rendered at their `relevance_score` position with reject reasoning visible.
- **Degraded-state (Phase 4):** `decision_status` ∈ `ok | unavailable | malformed`. When not `ok`, council prose fields carry a retryable placeholder and the item renders at a **conservative position**; the deterministic sort over available scores still holds for the rest of the feed.

### 4.2 Feed summary contract

The `feed_summary` is a separate per-researcher output region, not a per-item field. The output artifact is keyed by researcher: each researcher