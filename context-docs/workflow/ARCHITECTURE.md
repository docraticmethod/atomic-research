# ARCHITECTURE.md

## Atomic Research — Paper Relevance Feed (v3.1): Component Architecture

This document specifies what components exist and how they wire together. It executes the **v3.1** STRATEGY.md; it does not relitigate decisions made there (the council reversal, model ID, the council-decides design, degraded-state contract, two-stage LLM call ordering, the decision model in §2a, observability stack, **and now the grounding stage + integrity model**).

**v3.1 supersede notice.** This ARCHITECTURE revises the v3 architecture. The v3 architecture stands in full **except** where the v3.1 delta governs. The load-bearing v3.1 change: **the researcher profile the council consumes is no longer a hand-authored input fixture — it is the validated OUTPUT of a new grounding stage (Stage 1) that runs *before* the council, LLM-derived from a synthetic publication corpus and validated against it.** Two structural consequences:

1. `research_components.json` and `research_subfield_preferences.json` are **no longer input fixtures** — they are **pipeline output** of Stage 1, written only after passing the integrity model. The architecture wires their *output* schema, not an input contract.
2. A **new input fixture** appears: `publications.json` (the researcher's own prior body of work), the raw material grounding reads.

**v3 carry-over (do not relitigate):** relevance is DECIDED by a multi-agent LLM council, not computed by a deterministic LLM-free function. The prior v2 inversion — "ranking and recommended action are deterministic, LLM-free pure functions; the LLM only explains" — remains **deliberately reversed and removed.** Any component, schema field, or eval gate below that reintroduces a deterministic LLM-free relevance sequencer, a numeric admission threshold, a "component cleared" constant, or a `Read now / Save / Skip` action mapping is wrong and contradicts STRATEGY §2a/§6. **v3.1 adds a second forbidden pattern:** any component that treats Layer 3 (aptness flags) as a hard gate, that repairs a referential (Layer 2) failure by re-prompting, or that writes a partial profile on grounding failure is wrong and contradicts STRATEGY §1a/§6.

---

## 0. Architectural Confirmation & Adjustment

The agentic-harness template assumes the LLM produces the consequential judgment (triage, scoring, classification). **v3.1 aligns with that assumption twice** — Stage 1 (grounding) *earns* the profile through an LLM extraction validated by an integrity model, and Stage 2 (council) *decides* relevance per (researcher, paper) pair over the grounded profile. What remains deterministic is only the *display ordering* (a mechanical sort over `relevance_score`) **and the integrity model's Layers 1–2** (structural predicate + referential gate). Those deterministic checks introduce no LLM-free *relevance* logic.

The template's per-case fan-out applies, adapted to a two-stage shape:

| Template component | Disposition in this build |
|---|---|
| orchestrator.js | **Kept**, adapted — per researcher: (Stage 1) runs grounding extraction → integrity model → assembles the validated profile (or degraded state); (Stage 2) fans out the council deliberation batch over the 10 papers → sorts by `relevance_score` desc → issues the post-decision `feed_summary` call → assembles records → runs eval. Enforces the §2c call ordering (grounding→council→sort→summary) in code. |
| subagent.js | **Kept**, adapted — wraps the Anthropic SDK for: the two sequential single grounding calls (extraction Call 1, aptness validation Call 2) per researcher; the Message Batches API (per-pair council deliberations); and the single post-decision call (feed_summary). |
| skills/primary.js | **Kept**, adapted — **two skills now.** `skills/grounding.ts` (Stage 1: extraction + aptness validation) and `skills/council.ts` (Stage 2: decides relevance). |
| skills/guardrail.js | **Dropped** (as in v3) — but note the v3.1 integrity model is a *deterministic* three-layer validation gate (sanitize + structural + referential + advisory aptness), **not** the escalate-only LLM guardrail. The conservative two-pass escalate-only wrapper still has no referent here. See §0b. |
| skills/sequencer.js | **Kept as a pure function, LLM-free.** Ordering is a mechanical sort over council outputs (`relevance_score` desc, tie-break confidence, then recency). It makes **no relevance decision** (STRATEGY §1, §2a). |
| eval.js | **Kept**, extended — v3 council gates **plus** grounding gates (referential integrity as eval gate, profile-validated-or-degraded, component completeness, repair-loop termination). |
| memory.js | **Dropped for v1.** Batch call with deterministic retry; the grounding repair loop (capped 4 attempts, linear backoff) handles grounding-failure replay in-place; degraded-state contract (Phase 4) handles surfacing. No per-case failure-context JSONL replay. |
| logger.js | **Kept**, but **subordinate to the observability stack.** Weave (per-call) + W&B (per-run) are the primary instrumentation surface per STRATEGY §2; `logger.ts` provides a local JSONL trace alongside them. |

This is a deliberate, documented alignment with the council-decides reversal (v3) and the grounding-is-validated-not-trusted foundation (v3.1).

## 0b. The Integrity Model Is Not the Guardrail (read before §5 Stage 1)

The v3.1 grounding stage introduces a validation discipline that **must not be confused with the dropped escalate-only guardrail.** The GUARDRAIL_SPEC escalate-only pattern wraps a single consequential judgment with an asymmetric-cost urgency ramp and an LLM postflight that can only *escalate, never relax*. That pattern still has no referent here — there is no urgency enum.

The v3.1 integrity model is a **three-layer validation pipeline** with a fixed, non-negotiable order (STRATEGY §1a):

> **sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.**

The load-bearing distinctions, enforced architecturally:

- **Layer 1 is deterministic structural validation with an LLM repair loop.** The *predicate* is deterministic (parseable, non-empty, required fields, non-empty `source_paper_ids`); the *repair* re-prompts the LLM. Capped at **4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), deterministic sanitize after each. Still invalid after 4 → degraded state, **no partial profile written.**
- **Layer 2 is the deterministic referential gate — the backbone of trust.** Every `source_paper_id` in every component/subfield must resolve to a real paper in that researcher's `publications.json`. Any non-resolving id is **hard-rejected deterministically** — **never repaired by re-prompting** (a re-prompt could "fix" a fabricated id by inventing another). This is the layer that makes "genuine intellectual lineage" *true*.
- **Layer 3 is advisory.** Call 2's evidence-aptness flags surface weak-or-fabricated *semantic* lineage; they **inform, never auto-reject.** Layer 3 **must not** be treated as a hard gate, and **cannot** stand in for Layer 2 (it catches "cited for X but about Y," not a fabricated identifier).

**Three architectural prohibitions (enforced in code + eval):** never let Layer 3 auto-reject; never let Layer 1's repair loop attempt to "fix" a referential (Layer 2) failure; never write a partial profile on grounding failure (STRATEGY §1a, §6).

---

## 0a-a. Docker

Put the application in a Docker sandbox container so it is secure and Claude Code operates inside that sandbox. Build all Docker components first (STRATEGY §3 Phase 0): wire the input fixtures — now `researchers.json`, **`publications.json` (new)**, `papers.json`, `feed_items.json` (INPUT) — and the dashboard (OUTPUT); mount `.env` at runtime, do not bake it into the image. Note `research_components.json` / `research_subfield_preferences.json` are **not** wired as input — they are Stage-1 output.

---

## 0a. Observability Stack (cross-cutting, wired Phase 0)

Per STRATEGY §2 and §3, observability is a phase, not an afterthought, and in v3.1 it is **load-bearing for auditability across both stages** — the grounding trace tree (extraction reasoning, repair attempts, validation flags) and the council deliberation trace tree are both the audit trail, not just telemetry. Wired before any LLM call.

- **Weave (per-call).** `weave.init("<team>/atomic-research")` is called once at pipeline startup (`run.ts`), before any Anthropic call. It auto-instruments the Anthropic SDK so **both grounding calls (extraction Call 1, aptness Call 2)**, every per-pair council deliberation call, and the feed_summary call appear in the trace tree. Team functions — **the grounding orchestration + every integrity-layer assertion**, the council orchestration logic, and **every eval assertion** — are decorated `@weave.op()` so they sit in the same trace tree as the SDK calls. Because both stages are non-deterministic, **this trace tree is the auditability mechanism.**
- **W&B (per-run).** One `wandb` run per fixture/prompt iteration logs the pipeline-level aggregate: v3 council metrics (per-researcher decision distributions, confidence distributions, accept/reject counts, batch metadata, eval pass/fail) **plus grounding metrics (new): per researcher — components extracted, components surviving the referential gate, repair attempts used, aptness flags raised** (Phase 5).
- **Secrets.** `WANDB_API_KEY` is read from a gitignored `.env`; confirmed in `.gitignore` before any commit. Never hardcoded, never committed. Mounted into Docker, not baked.
- **Cross-reference.** The Weave trace tree (grounding + council + summary) and the W&B run reference the same iteration (Phase 5 exit).

Application model for the built artifact's runtime calls is `claude-sonnet-4-6` (pinned snapshot, STRATEGY §2) — now governing **both grounding calls** as well as council and summary. This governs the artifact's runtime only — not the build session.

---

## 1. Pipeline Shape — Three Stages, File-Based Handoffs

Stage boundaries are files, not live connections. The pipeline writes; the server serves; the client reads.

**INPUT** — four versioned, id-joined fixtures at `data/researchers.json`, **`data/publications.json` (new)**, `data/papers.json`, and `data/feed_items.json`. Built and validated before any application component is written (Slice 0 / INPUT gate). Read by the pipeline; never modified during a run. Contains **3 researchers, ~45–60 publication records (15–20 per researcher), 30 distinct candidate papers (10 each, no cross-researcher reuse), 30 feed_items.** Each candidate paper carries a populated abstract; each researcher populated `description` / `research_interests` / `topics`; each publication record shaped like OpenAlex/Semantic Scholar (title, abstract, ids, year, venue, topics) with **obviously-synthetic identifiers.** **`publications` and candidate `papers` are never conflated — different roles, different files, different id-spaces.** The synthetic `feed_items` already carry the council's decision fields; the runtime council reproduces/validates decisions over the same inputs (see §1a). **There is no numeric feed-admission cutoff** — every feed_item renders at its score position (STRATEGY §2a, no-silent-drop).

**`research_components.json` / `research_subfield_preferences.json` are NOT input** — they are Stage-1 *output*, produced by the grounding stage and validated by the integrity model before the council can run. The pipeline writes them (or holds the per-researcher degraded state) as an intermediate, in-memory grounded profile; the architecture wires their output schema (STRATEGY §3 Phase 0/G).

**PIPELINE** — `run.ts` + orchestrator + subagent + **grounding skill** + council skill + **integrity model (sanitizer + three layers)** + deterministic sequencer (sort only) + eval. Reads INPUT, produces OUTPUT. Per researcher: Stage-1 grounding (extraction → integrity model → validated profile or degraded state); then Stage-2 council deliberation batch; then the `relevance_score`-descending sort; then the post-decision `feed_summary` call; then schema validation and assembly. Writes OUTPUT exactly once per run, after eval gates pass.

**OUTPUT** — single validated artifact at `public/output_data.json`. Written by `run.ts` after eval gates pass; never modified after write. The dashboard reads this file via the dashboard server.

No data flow between stages at render time. The dashboard renders finalized output; it does not ground, decide relevance, sort, or call the LLM.

---

## 1a. Runtime Council vs. Fixture Decision Fields — Council Is Canonical

(Unchanged from v3.) The synthetic `feed_items` ship with the council's decision fields pre-populated (so the fixtures are self-consistent and the INPUT gate can validate shapes without a live call). At runtime, **the runtime council is canonical.**

- **The runtime council overwrites the fixture decision fields.** For each (researcher, paper) pair, the OUTPUT artifact carries the *runtime* council's `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and `council_deliberation` — not the fixture-provided values.
- **Divergence between fixture-provided and runtime-produced decisions is acceptable and is not an eval failure.** The council is non-deterministic by design; requiring runtime output to match pre-populated fixture decisions would smuggle a deterministic relevance check back in, which §2a forbids.
- **The fixtures' coverage-role design still binds.** The must-surface / must-dismiss / ambiguous roles are properties of the *input* the council reasons over, so a well-functioning council reproduces those roles' intent (Phase 2A exit asserts the roles are reflected in the runtime decisions).

**v3.1 addition — the grounded profile is canonical over any seed shape.** The components/subfields the council reasons over at runtime are the **Stage-1 grounded, validated** ones (carrying real `source_paper_ids` into `publications.json`), not any hand-authored seed. There is no fixture-equality check on the grounding output either: eval validates the grounded profile's *structural* and *referential* properties (Layers 1–2 as eval gates), never that it equals a pre-authored conclusion.

---

## 1b. Grounding Output (Stage-1 Intermediate) — Schema & Lineage

The grounded profile is an intermediate artifact, validated before the council consumes it. Per researcher, after the integrity model passes:

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

Field rules (eval-locked, §5):
- **`source_paper_ids` resolve into `publications.json` only** — never into the candidate `papers` id-space. This is the genuine-lineage backbone (Layer 2).
- **Every component/subfield carries** a non-empty `name`, `description`, non-empty `source_paper_ids`, and an `explanation`. Structural predicate (Layer 1).
- **`aptness_flags`** is the Call-2 advisory output (Layer 3) — weak-or-fabricated *semantic* lineage surfaced for inspection, **never auto-rejecting.** Empty array = no advisory concern.
- **`grounding_status` ∈ `ok | unavailable`.** `unavailable` = the researcher's grounding failed (still structurally invalid after 4 repair attempts, or no component survived the referential gate); **no partial profile is written** — the field carries the degraded state only.

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
    "subfield_weighing": "<how subfield match was weighed in this decision, including where it was not a deciding factor>",
    "resolution": "<how the council reached its decision>"
  },
  "decision_status": "ok"
}
```

The example `publication_date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06), consistent with the window-eligibility assertion in §5.

**v3.1 lineage note:** `matched_components[].source_paper_ids` reference the **grounded, validated** components from Stage 1 — they resolve into `publications.json` (the researcher's own corpus), **not** the candidate `papers` id-space. This is real intellectual lineage, not asserted lineage. The example ids above (`PUB-R1-*`) are publication ids by design.

Field provenance:

- **Council-decided (Phase 2A, LLM):** `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and the full `council_deliberation` record. The *runtime* council's values, canonical over any fixture seed (§1a).
- **Grounded (Phase G, LLM + integrity model):** the `matched_components` the council references — name and `source_paper_ids` provenance — originate from the Stage-1 validated profile, not from a hand-authored fixture.
- **Deterministic presentation-only (Phase 1, no LLM):** `position` — assigned by the mechanical sort over `relevance_score` descending (tie-break `council_confidence` desc, then `publication_date` recency). An ordering label, **not a relevance decision.**
- **Component lineage — required and eval-locked:** for every accepted item (`relevance_decision: true`), `matched_components` must carry ≥1 entry with a populated `match_explanation` and a populated `source_paper_ids` provenance **resolving into `publications.json`**. §5 asserts this.
- **Subfield match — weighed, not mandated non-empty (STRATEGY §2a):** subfield match is an **explicit council factor** weighed *inside* deliberation, alongside component / focus / substantive-vs-superficial — never a numeric gate. An accepted paper may legitimately match on components/focus without a strong subfield match. Therefore eval does **not** require `matched_subfields` to be non-empty on every accepted item; it requires that subfield match was *weighed* (the `council_deliberation.subfield_weighing` field is present and substantive), and that `matched_subfields` is populated **where subfield match was a deciding factor**. §5 asserts this relaxed form.
- **`substantive_vs_superficial` — required in deliberation:** the council must distinguish substantive advancement from surface keyword overlap; apparent overstatements **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
- **No-silent-drop:** `relevance_decision: false` items **retained** and rendered at their score position with reject reasoning visible.
- **Degraded-state (Phase 4):** `decision_status` ∈ `ok | unavailable | malformed`. When not `ok`, council prose fields carry a retryable placeholder and the item renders at a **conservative position**.

### 2.2 Feed summary contract

(Unchanged from v3.) The `feed_summary` is a separate per-researcher output region. Generated by a single post-decision call (Phase 2B), takes the decided, sorted feed as input, degrades independently.

```json
{
  "feed_summary": {
    "text": "<editorial prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. When not `ok`, the summary region shows a retryable placeholder; the per-item feed renders in full regardless. The output artifact is keyed by researcher: each researcher carries `grounding_status`, the grounded profile (§1b), a `feed` array (the per-item contract above), and a `feed_summary` object. A researcher in `grounding_status: "unavailable"` carries no feed (the council does not run for them) and renders the grounding degraded state.

### Model-call estimate

The pipeline uses three call families. Multiplying through every level:

- **Grounding (Stage 1) — 2 sequential single calls per researcher** (extraction Call 1 + aptness validation Call 2): **3 researchers × 2 = 6 calls.** Repair re-prompts add **up to 4 additional calls per researcher** in the worst case (structural failures only); typical runs use 0–1. Worst-case grounding ceiling: 6 + (3 × 4) = **18 calls.**
- **Council (Stage 2) — Message Batches API, one deliberation per (researcher, paper) pair:** **3 × 10 = 30 council calls**, submitted as batches.
- **Feed summary — one post-decision call per researcher:** **3 calls.**

**Typical total: ~39 model calls per run** (6 grounding + 30 council + 3 summary, near-zero repairs). **Worst-case ceiling: ~51 calls** (18 grounding + 30 council + 3 summary). No nesting beyond this — each grounding/council call returns a single structured response. The grounding calls run *before* each council batch; the three feed_summary calls run *after* each council batch completes and that feed is sorted. **Cap check:** the test-data sizing budget keeps runtime under ~5 min and burst under the rate ceiling; ~39–51 calls (council batched, grounding/summary sequential per researcher) clears that comfortably. REQUIREMENTS.md does not specify a numeric call/budget cap; should it later introduce one, this is the value to verify against it.

---

## 2c. Call Ordering (architectural, enforced in code)

Per STRATEGY §1 and §3 Phase G/2A/2B, call ordering is architectural, not incidental. **Per researcher:**

1. **Grounding deliberates first (Stage 1)** — extraction Call 1 → integrity model (sanitize → Layer 1 structural+repair → Layer 2 referential gate → Layer 3 aptness flags from Call 2) → authoritative profile assembled from what passed. **The council is unreachable-past until grounding produced a validated profile for that researcher** — enforced in code, the same discipline v3 applied to feed_summary. If grounding ends in the degraded state, the council does **not** run for that researcher.
2. **Council deliberates the full 10-paper set second (Stage 2)** — the batch of per-pair deliberation calls decides relevance over the **grounded** profile. Each call receives the researcher's profile (`description`, `research_interests`, `topics`), the **grounded, validated research components with their real `source_paper_ids` provenance** (into `publications.json`), the **grounded selected subfields**, and the candidate paper's **abstract** and metadata (never title-only; subfield match an explicit factor).
3. **Sort runs third** (deterministic) — the feed is ordered by `relevance_score` descending, tie-break `council_confidence` desc, then `publication_date` recency. A pure sort over completed council outputs; makes no relevance decision.
4. **`feed_summary` runs fourth** — takes the decided, sorted feed as input. **Not** a peer of the council batch and **must not** be issued before the council has finished that researcher's set and the sort has produced an order.

This ordering is enforced in code in `orchestrator.ts`: the council batch is unreachable before grounding produced a validated profile; the summary call is unreachable before that researcher's council batch completes and the feed is sorted.

---

## 3. First Slice (smallest end-to-end)

Per template stage gates, adapted for the two-stage build:

1. **Slice 0 — INPUT gate.** All four input fixtures exist and validate against their field contracts (Ajv); cross-file id joins resolve orphan-free; per researcher, coverage roles honored (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread); every candidate paper carries a populated abstract, every researcher populated `description` / `research_interests` / `topics`; **`publications.json` validated at scale (~15–20 per researcher) with obviously-synthetic ids, never conflated with the candidate `papers` id-space**; scale confirmed (3 researchers, 30 distinct papers, 30 feed_items, no cross-researcher reuse); all `publication_date` in-window; synthetic IDs obviously synthetic. The Stage-1 *output* schema (§1b) is wired but not authored. `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes.
2. **First runnable slice (Stage 1 first):** `run.ts` → `subagent.ts` (grounding extraction Call 1 + aptness Call 2 for **one** researcher) → integrity model (sanitize → Layer 1 → Layer 2 → Layer 3) → assemble that researcher's validated profile → then `subagent.ts` (council deliberation call for **one** (researcher, paper) pair over that profile) → `sequencer.ts` (sort that one-item feed) → `eval.ts` (schema gate + referential-integrity gate) → write OUTPUT for that one pair. **Grounding must run and validate before the council call** — the slice proves the call-ordering discipline end-to-end.
3. Defer the full 6-grounding-call / 30-pair-council batch, the repair-loop exercise, the per-researcher feed_summary calls, the substantive-vs-superficial ambiguous-case verification, coverage-role and no-drop assertions, and full degraded-state handling until the one-researcher / one-pair path runs clean end-to-end.
4. **OUTPUT gate.** `public/output_data.json` validates against the output schema (grounded profile + feed + feed_summary) before the dashboard slice begins.
5. Dashboard is the final phase. It renders finalized output only.

---

## 4. New Dependencies

| Dependency | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic client: **grounding extraction + aptness calls (single)**, Message Batches API (per-pair council deliberations), per-researcher feed_summary calls |
| `ajv` | JSON Schema validation (four input fixtures + **grounded Stage-1 output shape** + per-item output contract + feed_summary contract) |
| `typescript` + `tsx` (or `ts-node`) | Type-safe build per STRATEGY §2; run `.ts` directly |
| `weave` | Per-call observability; auto-instruments the Anthropic SDK; `@weave.op()` on **grounding orchestration + every integrity-layer assertion** + council orchestration + every eval assertion (STRATEGY §2) |
| `wandb` | Per-run observability; one run per fixture/prompt iteration, **grounding + council metrics** (STRATEGY §2) |

No other runtime dependencies. Styling is hand-authored CSS (STRATEGY §2). No production-pipeline libraries (OpenAlex/arXiv/embeddings explicitly out of scope; the publications corpus is synthetic, no live fetch).

---

## 5. Component Architecture

### Compute layer (deterministic — NO relevance logic; integrity Layers 1–2 deterministic)

1. **sequencer.ts** — pure function, **LLM-free, ordering only.** Takes a researcher's 10 feed items *after the council has decided them*, returns the array ordered by:
   - `relevance_score` descending (the council's calibrated relevance — the only ordering signal).
   - Tie-break: `council_confidence` descending, then `publication_date` recency.
   - Assigns the `position` label per item.
   - **No admission filter:** `relevance_decision: false` items retained at their score position (no-silent-drop).
   - **Recency gate, not ranking signal:** a window-eligibility assertion (2025-12-06 → 2026-06-06) verifies all candidate fixtures are in-window; age within the window only ever serves as a final tie-break.
   - **No relevance decision, no numeric admission threshold, no "component cleared" constant, no action mapping.** These v2 constructs are deleted (STRATEGY §2a, §6).
   - **`paper_id` independent of `researcher_id`:** the sort operates per researcher over explicit id-joined items; no single-ownership assumption (STRATEGY §3 Phase 1).
   - Fully unit-tested for order stability, tie-break correctness, no-drop behavior.

2. **join.ts** — pure function, **LLM-free.** Implements the explicit, mechanical id-join: `feed_items.researcher_id` / `.paper_id` resolve against parents; **grounded** `research_components.researcher_id` / `research_subfield_preferences.researcher_id` resolve against `researchers`, and their `source_paper_ids` **resolve into `publications.json` (not `papers`)**. The join is never inferred — asserts no orphans. By explicit id only; no single-ownership assumption for papers. **Publications and candidate papers are distinct id-spaces — `source_paper_ids` resolve into `publications` only** (STRATEGY §3 Phase 1).

3. **integrity.ts** — the **deterministic integrity model** (Layers 1 & 2; Layer 3 attached from Call 2). Pure/deterministic except the repair re-prompt (which it delegates to `subagent.ts`). Implements, in fixed order (§0b, STRATEGY §1a):
   - **`sanitize(raw)`** — strip markdown fences, control characters, trailing commas; attempt `JSON.parse`. (Carried from the architect's existing pattern.)
   - **Layer 1 — `validateStructural(profile)` + repair loop:** structural predicate (parseable object, non-empty, every component/subfield carries non-empty `source_paper_ids` and required fields `name` / `description` / `explanation`). On failure, **repair by re-prompting the LLM** with the failure — capped at **4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), `sanitize` after each. Still invalid after 4 → return degraded state; **no partial profile.**
   - **Layer 2 — `validateReferential(profile, publications)`:** every `source_paper_id` in every component/subfield **must resolve to a real paper in that researcher's `publications.json`.** Hard-reject any component/subfield with a non-resolving id — **deterministic, never repaired by re-prompting.** If no component survives the gate, return degraded state.
   - **Layer 3 — `attachAptnessFlags(profile, call2Output)`:** attach Call-2 advisory flags to surviving components/subfields; **never auto-reject.**
   - **`assembleProfile(...)`** — build the authoritative profile (§1b) from **what passed** Layers 1–2, with Layer-3 flags attached. Written only after the gate passes.
   - Each layer assertion decorated `@weave.op()` so it appears in the trace tree as part of the audit trail.
   - **Three prohibitions enforced here (§0b):** Layer 3 never auto-rejects; the Layer 1 repair loop never attempts to fix a Layer 2 referential failure; no partial profile is ever returned on failure.

### Pipeline layer

4. **orchestrator.ts** — sequences the run **per researcher**, enforcing the §2c call ordering in code:
   - **Stage 1 (grounding):** invokes `subagent.ts` for extraction Call 1 + aptness Call 2 → runs `integrity.ts` (sanitize → Layer 1 + repair → Layer 2 → Layer 3 → assemble) → obtains a validated grounded profile **or** the `grounding_status: "unavailable"` degraded state. **The council branch is unreachable when grounding ends degraded** — no partial profile, council does not run for that researcher.
   - **Stage 2 (council):** for a grounded researcher, invokes `join.ts` (deterministic) → fans out the council deliberation batch over that researcher's 10 papers via the subagent, **passing the grounded components/subfields (with real `source_paper_ids`) as context** → sorts via `sequencer.ts` → issues the post-decision `feed_summary` call against the sorted feed → assembles per-item records (overwriting fixture seed decision fields with runtime council values, §1a) → runs eval.
   - **Enrichment-at-call-time (template alignment):** when the council batch or the `feed_summary` call requires fields not present in the grounded profile or the per-item council records (e.g., candidate-paper abstract/metadata not carried on a finalized record), the orchestrator enriches at call time by merging from the original INPUT payloads. The per-researcher output contracts (grounded profile §1b, per-item §2.1, feed_summary §2.2) remain untouched.
   - Hands the validated artifact (per-researcher `grounding_status` + grounded profile + `feed` arrays + `feed_summary` objects) to `run.ts` for writing.
   - The grounding orchestration **and** council orchestration functions are decorated `@weave.op()` (STRATEGY §3 Phase G/2A).

5. **subagent.ts** — wraps the Anthropic SDK for three call families:
   - **Grounding (Stage 1):** two sequential single calls per researcher — extraction Call 1 (the researcher's full `publications` corpus fed as a **one-shot prompt**) and aptness validation Call 2 (audits Call 1's output for weak/fabricated semantic lineage). Also serves the Layer-1 repair re-prompts on request from `integrity.ts`.
   - **Council (Stage 2):** Message Batches API, one deliberation request per (researcher, paper) pair; polls for completion; parses structured responses. Each call receives the researcher's profile, **grounded** components (with `source_paper_ids`), grounded selected subfields, and the candidate paper's abstract + metadata — **never title-only.**
   - **Feed summary:** one post-decision call per researcher.
   - Anthropic client initialized with `maxRetries: 3`. The subagent does not decide ordering, does not validate referential integrity (that is `integrity.ts`), and does not sort.

### Skills

**Skill contract — every file in `skills/` exports exactly four things:** `name` (string), `systemPrompt` (string), `tools` (array, possibly empty), `successCriteria` (object with a `validate` function). Both skills below honor this contract.

6. **skills/grounding.ts** — the Stage-1 skill. Exports the four-part skill contract:
   - `name`: `"profile-grounding"`.
   - `systemPrompt`: a **one-shot prompt** (a single worked example demonstrating the required structured output) instructing the LLM to read across the researcher's **full `publications` corpus** and emit structured **research components** and **subfield preferences**, each carrying `name`, `description`, **`source_paper_ids`** (the specific publications evidencing it), and an **`explanation`** of why that evidence supports the conclusion. The extraction must be **self-documenting** — it shows its work for audit. A second prompt (`aptnessSystemPrompt`) drives Call 2: for each component/subfield, judge whether the cited evidence actually *supports* the claim or whether the lineage is weak/fabricated, returning advisory flags.
   - `tools`: `[]` (none — structured extraction generation).
   - `successCriteria.validate`: asserts the structural predicate (Layer 1) — parseable, non-empty, every component/subfield carries `name` / `description` / non-empty `source_paper_ids` / `explanation`. **Referential validity (Layer 2) is enforced by `integrity.ts`, not here** — `successCriteria` is structural only; the deterministic referential gate is the integrity model's job (§0b prohibition: never let a re-prompt "fix" a referential failure).

7. **skills/council.ts** — the Stage-2 skill. Exports the four-part skill contract:
   - `name`: `"relevance-council"`.
   - `systemPrompt`: guidance + output schema for the council's structured decision. Includes:
     - The **decision instruction**: produce `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason`, and the full multi-voice `council_deliberation` record.
     - The **substantive-vs-superficial instruction**: distinguish substantive advancement from surface keyword overlap; apparent overstatements **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
     - The **explicit-factors instruction**: weigh component match, **subfield match** (an explicit factor), focus match, and the substantive-vs-superficial test — each a consideration *inside deliberation*, never a numeric gate. Subfield weighing must be recorded in `council_deliberation.subfield_weighing`, including the case where subfield match was *not* a deciding factor (the paper matched on components/focus instead) — an accepted item need not carry a non-empty `matched_subfields`.
     - The **grounding instruction (v3.1):** reasoning is grounded in the abstract and the **grounded, validated** matched-component `source_paper_ids` provenance (into `publications.json`) and the researcher's grounded selected subfields — never inferred from the title alone, **and never from asserted (ungrounded) lineage.** Accepted items must emit populated `matched_components[].match_explanation` and `source_paper_ids`; `matched_subfields` is populated **where subfield match was a deciding factor** (eval-locked, §5).
   - `tools`: `[]`.
   - `successCriteria.validate`: asserts all five council fields present and well-formed per pair; asserts the ambiguous coverage-role paper carries non-trivial substantive-vs-superficial deliberation; asserts subfield match is **weighed** (the `subfield_weighing` record present) — not that `matched_subfields` is non-empty on every accepted item.

   **No guardrail skill.** Per §0/§0b, the escalate-only guardrail has no referent — there is no urgency enum to ratchet. The v3.1 integrity model is a deterministic validation gate (Layers 1–2), **not** the LLM escalate-only wrapper; do not confuse the two.

### Eval

8. **eval.ts** — gates, aggregate errors (no short-circuit). Each assertion decorated `@weave.op()` (STRATEGY §3 Phase G/2A/5):
   - `validateSchema` — every input fixture validates against its field contract (Ajv), **including `publications.json` (~15–20 per researcher)**; the **grounded Stage-1 output** validates against its shape (§1b); every per-item output matches the per-item contract; every feed_summary matches its contract.
   - `sanityCheck`:
     - Every cross-file id reference resolves (`feed_items.researcher_id`/`.paper_id`, grounded `research_components.researcher_id`, `research_subfield_preferences.researcher_id`) — no orphans.
     - **Referential integrity (Layer 2 as eval gate, non-negotiable):** every `source_paper_id` in every generated component and subfield resolves to a real paper in that researcher's `publications.json` — **zero orphans.** Deterministic enforcement of Layer 2 as an eval gate, not only a runtime check.
     - **Publications/papers never conflated:** `source_paper_ids` resolve into the `publications` id-space, never the candidate `papers` id-space.
     - **Grounding produced a non-empty validated profile** for each researcher (or that researcher is in the documented `grounding_status: "unavailable"` degraded state with **no partial profile written**).
     - **Every generated component carries** `name`, `description`, non-empty `source_paper_ids`, and an extraction `explanation`; `aptness_flags` present as advisory only (never causing auto-rejection).
     - **Repair loop terminates:** no grounding run exceeds 4 repair attempts without resolving to acceptance or the degraded state.
     - Scale: exactly 3 researchers, 30 papers (10 distinct per researcher, **no cross-researcher reuse**), 30 feed_items, **~45–60 publication records (15–20 per researcher).**
     - Every feed_item carries all five council fields (decision, score, confidence, reason, deliberation).
     - **Component lineage populated per accepted item:** every `relevance_decision: true` item carries ≥1 `matched_components` entry with a populated `match_explanation` and a `source_paper_ids` provenance **resolving into `publications.json`**.
     - **Subfield match weighed, not mandated non-empty (STRATEGY §2a):** every item's `council_deliberation` carries a substantive `subfield_weighing` record showing subfield match was an explicit factor; `matched_subfields` is asserted non-empty **only where the deliberation records subfield match as a deciding factor.** Eval does **not** require `matched_subfields` to be non-empty on every accepted item — a paper accepted on components/focus without a strong subfield match is valid.
     - Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous).
     - **Substantive-vs-superficial reasoning present** in `council_deliberation` for the ambiguous case.
     - **Display order matches `relevance_score`-descending sort** (tie-break confidence, then recency), recomputed and compared.
     - **No-silent-drop:** every `relevance_decision: false` item present at its score position.
     - `feed_summary` present per researcher (or its degraded state).
     - **Recency window assertion** — all candidate fixtures in-window.
     - **Runtime-canonical, no fixture-equality check (§1a):** eval validates the *runtime* council fields and the *grounded* profile for presence, well-formedness, referential and internal consistency; it **never** asserts runtime output equals fixture seed decisions or that the grounded profile equals a pre-authored conclusion — divergence is expected and not a failure.
   - On failure: errors aggregated and reported; OUTPUT not written.

### Log trace & observability

9. **logger.ts** — JSONL trace per run, `traceId` threaded through orchestrator → grounding → integrity → subagent → eval. Records grounding calls, repair attempts, referential-gate rejections, aptness flags, batch submission/completion, feed_summary calls, eval results. Subordinate to the Weave/W&B observability stack (§0a), which is the primary instrumentation surface and the load-bearing audit trail. (Referential-gate rejections and aptness flags are additionally logged via Weave/W&B per STRATEGY §3 Phase G/4.)

### Application entry

10. **run.ts** — CLI entry. `node --import tsx src/run.ts [data/feed_items.json]`. Calls `weave.init` once at startup before any LLM call (§0a). On a clean run (eval gates pass), writes `public/output_data.json`, logs the W&B run with **grounding + council metrics** (Phase 5), and exits. On eval failure, writes nothing and reports.

### Degraded-state handling (Phase 4)

11. **Degraded-state contract** — a cross-cutting behavior in `integrity.ts` + `subagent.ts` + `orchestrator.ts`:
   - **Grounding failure (new):** if a researcher's grounding is still structurally invalid after 4 repair attempts **or** no component survives the referential gate, that researcher's profile carries `grounding_status: "unavailable"`; **the council does not run for that researcher; no partial profile is written;** other researchers unaffected. Referential-gate rejections and aptness flags logged via Weave/W&B — inspectable, not silent.
   - A feed item whose **council decision** could not be produced renders at a **conservative position** with `decision_status: "unavailable"` and an explicit "decision unavailable — retry" state.
   - Malformed model JSON (grounding or council) is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `decision_status: "malformed"` (council) or the grounding degraded state.
   - **feed_summary failure is independent:** if a researcher's summary call fails, that researcher's per-item feed still renders in full; the summary region carries `summary_status: "unavailable"` (or `"malformed"`).
   - No feed item is ever silently dropped or blanked; no partial profile is ever written on grounding failure.

---

## 6. Dashboard Architecture

Four files with explicit responsibilities. The server validates the OUTPUT artifact at startup; if validation fails, the dashboard does not start. No partial-success state.

12. **dash-app-server.ts** — Node/Express. Reads `public/output_data.json`, validates it against the output schema (per-researcher `grounding_status` + grounded profile + `feed` arrays + `feed_summary` objects), exposes API endpoints to the client. The only component that touches the data file. ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server only starts when run directly, not when imported in tests.

13. **dash-app-client.ts** — consumes the server's API endpoints. Never reads the data file directly. Holds all rendering, researcher selection, feed-item selection, expansion, and scroll