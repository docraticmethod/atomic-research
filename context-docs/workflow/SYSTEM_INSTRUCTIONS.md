# SYSTEM_INSTRUCTIONS.md

## Atomic Research — Paper Relevance Feed (v3): Build Instructions for Claude Code

These are operational instructions for building this project. They execute ARCHITECTURE.md, which executes STRATEGY.md, which executes REQUIREMENTS.md. **Do not relitigate decisions made upstream** — the council reversal, the model ID, the council-decides design, the dropped guardrail, the two-stage LLM call ordering, the Docker sandbox, the degraded-state contract, and the observability stack are all settled. Your job is to implement them faithfully.

**v3 supersede notice.** This document supersedes the prior (v2-aligned) SYSTEM_INSTRUCTIONS in full. The load-bearing change: **relevance is now DECIDED by a multi-agent LLM council, not computed by a deterministic LLM-free function.** The prior central principle — "ranking and recommended action are deterministic, LLM-free pure functions; the LLM only explains" — is **deliberately reversed and removed.** If you find yourself building a deterministic LLM-free relevance sequencer, a numeric admission threshold, a "component cleared" constant, or a `Read now / Save / Skip` action mapping, **stop — you have misread the architecture and contradicted STRATEGY §0/§2a.**

---

## 0. The One Principle You Must Not Violate

**The council DECIDES relevance per (researcher, paper) pair. The only thing that stays deterministic is the display ordering — a mechanical sort over the council's `relevance_score`.**

Every decision below flows from this. The council produces `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, the grounding fields (`matched_components[].match_explanation`, `matched_subfields`), and the full `council_deliberation` record. The sort is *not* a relevance decision — it is a pure presentation-order function over council outputs (`relevance_score` descending, tie-break `council_confidence` descending, then `publication_date` recency).

If you ever find yourself wiring an LLM-free function into the relevance *decision* — a threshold gate, a "component cleared" constant, an action mapping — stop. Those v2 constructs are **deleted in v3**. The council decides; ordering only sorts.

**The deliberation record is load-bearing.** Because the council is non-deterministic, `council_deliberation` captured per decision and traced in Weave **is the audit trail** that buys back the defensibility determinism gave up. It is not optional polish.

---

## 0a. Docker Sandbox — Build This First

**The entire application runs inside a Docker sandbox container.** This is settled upstream (ARCHITECTURE §0a-a) and is not optional.

- **Build all Docker components first**, before any application code. The container is the secure boundary Claude Code operates within.
- The pipeline, the dashboard server, and all dependencies (`@anthropic-ai/sdk`, `ajv`, `typescript`/`tsx`, `weave`, `wandb`) run inside the container.
- The gitignored `.env` carrying `WANDB_API_KEY` is mounted into the container, not baked into the image. The key never lands in a layer, never gets committed.
- `data/` (INPUT — five fixtures) and `public/` (OUTPUT) are wired so the pipeline can read fixtures and write `output_data.json`, and the dashboard server can serve it, all within the sandbox.
- **Gate (Docker):** the container builds clean; the pipeline and dashboard server both run inside it; `.env` is mounted (not baked) and confirmed gitignored. Do not start Phase 0 application work until the sandbox builds and runs.

---

## 1. Non-Negotiables (settled upstream — do not revisit)

- **Docker sandbox:** the application is containerized; build Docker components first; Claude Code operates inside the sandbox. Do not run the application outside the container.
- **Model ID:** `claude-sonnet-4-6` (pinned snapshot). Do not substitute, do not add a date suffix, do not "upgrade." Governs the built artifact's runtime calls only — not your build session.
- **The council decides relevance.** Each (researcher, paper) pair gets a `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason`, and a full `council_deliberation` record — all from the council, all LLM-decided. There is **no deterministic LLM-free relevance logic anywhere.**
- **No numeric admission threshold, no "component cleared" constant, no `Read now / Save / Skip` action mapping.** All three v2 constructs are **deleted in v3**. Do not reintroduce any of them.
- **No silent drop.** `relevance_decision: false` items are **retained** and render at their `relevance_score` position with reject reasoning visible — the demo must show the council *declining*, not only accepting. Do not filter any feed item out.
- **Display ordering is a pure sort, not a decision.** `relevance_score` descending; tie-break `council_confidence` descending, then `publication_date` recency. This is `sequencer.ts` — LLM-free, ordering only, no relevance judgment.
- **Runtime council is canonical (§1a).** The fixtures ship with pre-populated decision fields as seed input. At runtime the council **overwrites** them. Divergence between fixture seed and runtime output is **expected and is not an eval failure.** Never assert runtime output equals fixture seed values.
- **LLM surface:** the council's per-pair deliberation (decision + score + confidence + reason + grounding + deliberation record) **plus the post-decision per-researcher `feed_summary`.** Nothing else.
- **No guardrail skill.** The escalate-only guardrail has no referent here — there is no urgency enum to ratchet, only a relevance decision to argue. The council's multi-voice deliberation + substantive-vs-superficial argue-down **is** the internal conservative check. Do not add a guardrail.
- **No production-pipeline code.** No OpenAlex/arXiv ingestion, no embeddings, no cosine/vector similarity, no centroid refresh, no live third-party calls. The five fixtures are canonical.
- **Batches API for council deliberations, not per-case fan-out.** All 10 per-pair deliberation requests per researcher go through the Message Batches API. Do not `Promise.all` one subagent per pair.
- **Call ordering is architectural.** Per researcher: council deliberates the full 10-paper set first → sort by `relevance_score` desc → `feed_summary` runs post-decision, post-sort. The summary takes the decided, sorted feed as input and **must not** be issued before that researcher's council set is complete. Enforce in code (`orchestrator.ts`, ARCHITECTURE §2c): the summary call is unreachable before the council batch completes and the feed is sorted.
- **Council never reasons from the title alone.** Each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the researcher's research components with `source_paper_ids` provenance, the researcher's selected subfields, and the candidate paper's abstract + metadata.
- **Subfield match is an explicit council factor** — weighed alongside component match, focus match, and the substantive-vs-superficial test, as a consideration *inside deliberation*, never a numeric gate.
- **Substantive-vs-superficial discipline:** a paper matching on surface terms but not substance must be **argued down in `council_deliberation`**, never rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
- **`paper_id` is independent of `researcher_id`.** Papers are distinct per researcher in the fixtures, but no logic may assume a paper belongs to exactly one researcher. Join by explicit id only.
- **Recency is a tie-break, not a relevance signal** — age within the window only ever serves as a final tie-break in the sort.

---

## 1a. Observability Is a Phase, Not an Afterthought — and Load-Bearing

Weave + W&B are the primary instrumentation surface, wired before any LLM call. In v3, Weave is **load-bearing for auditability** — the deliberation trace tree is the audit trail, not just telemetry. All of this runs inside the Docker sandbox.

- **Weave (per-call):** `weave.init("<team>/atomic-research")` is called **once at startup in `run.ts`, before any Anthropic call.** It auto-instruments the Anthropic SDK so every per-pair council deliberation call and every feed_summary call appear in the trace tree. Decorate team functions — the council orchestration logic and **every eval assertion** — with `@weave.op()` so they sit in the same trace tree as the SDK calls. Because the council is non-deterministic, **this trace tree is the auditability mechanism.**
- **W&B (per-run):** one `wandb` run per fixture/prompt iteration logs the pipeline aggregate — **per-researcher decision distributions, confidence distributions, accept/reject counts**, batch-call metadata (latency, token count, per-pair decision status), and eval pass/fail results.
- **Secrets:** `WANDB_API_KEY` read from a **gitignored `.env`**, mounted into the container (not baked into the image). Confirm `.env` is in `.gitignore` **before any commit.** Never hardcode, never commit the key, never bake it into a Docker layer.
- **Cross-reference:** the Weave trace tree and the W&B run must reference the same iteration.

---

## 2. Build In This Order

Follow the phase order. Do not start a phase before the prior phase's gate passes. **The Docker sandbox (§0a) is built before Phase 0.**

### Phase 0 — Scaffold, fixtures & observability wiring
- TypeScript project skeleton inside the container; add `@anthropic-ai/sdk`, `ajv`, `typescript` + `tsx`, `weave`, `wandb`.
- Embed the five fixtures as `data/researchers.json`, `data/papers.json`, `data/research_components.json`, `data/feed_items.json`, `data/research_subfield_preferences.json`. Every paper carries a populated abstract; every component a populated `source_paper_ids` provenance; every researcher populated `description` / `research_interests` / `topics`. The synthetic `feed_items` already carry the council's decision fields (seed input — runtime overwrites them, §1a).
- Write Ajv schemas for **all five fixture field contracts**, the per-item output contract, **and the feed_summary contract**; wire the validator.
- Validate fixtures honor their coverage roles **per researcher** (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous, plus a mid-tier spread).
- **Confirm scale:** exactly 3 researchers, 30 papers (10 distinct per researcher, **no cross-researcher paper reuse**), 30 feed_items, components and subfield preferences per researcher. Confirm all `publication_date` values fall in the trailing 6-month window (2025-12-06 → 2026-06-06) relative to currentDate 2026-06-06.
- **Confirm synthetic IDs are obviously synthetic** and do not collide with real OpenAlex IDs.
- Wire observability: `weave.init` runs clean; `.env` confirmed gitignored and key not in source (and not in any Docker layer).
- **Gate (Slice 0 / INPUT gate):** container builds; fixtures load and validate; a deliberately malformed entry is rejected; cross-file id joins resolve with no orphans; `weave.init` runs clean; `.env` confirmed gitignored. No application component before this passes.

### Phase 1 — Cross-file join & display ordering (mechanical, NO relevance logic)
- Implement `join.ts` as a **pure, LLM-free function**: `feed_items.researcher_id` / `.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id` all resolve against their parents. The join is **never inferred** — assert no orphans. By explicit id only; **no single-ownership assumption for papers.**
- Implement `sequencer.ts` as a **pure, LLM-free function — ordering only.** Per researcher, sort `feed_items` by `relevance_score` descending; tie-break `council_confidence` descending, then `publication_date` recency. Assign the `position` label. This is a pure presentation sort over council outputs — **it makes no relevance decision and introduces no LLM-free relevance logic.**
- **No admission filter:** `relevance_decision: false` items are retained and ordered at their score position (no-silent-drop).
- **Recency gate, not ranking signal:** add a window-eligibility assertion (2025-12-06 → 2026-06-06); all fixtures must be in-window; age within the window only ever serves as a final tie-break.
- **No threshold, no "component cleared" constant, no action mapping.** These v2 constructs are deleted. The sequencer makes a *display order* and nothing more.
- **Gate:** per researcher, all 10 feed_items joined and ordered stably and reproducibly; reject-decision items present at their score position; join asserted orphan-free; unit tests lock the sort and the no-drop behavior.

### Phase 2A — LLM council deliberation (batch, DECIDES relevance)
- Implement `subagent.ts` (wraps Message Batches API for per-pair deliberations + a single per-researcher feed_summary call, `maxRetries: 3`), `skills/council.ts`, `orchestrator.ts`, `eval.ts`, `run.ts`, `logger.ts`.
- **First runnable slice: one (researcher, paper) pair end-to-end** — `run.ts → weave.init → join.ts → subagent.ts (council deliberation for ONE pair) → sequencer.ts (sort that one-item feed) → eval.ts (schema gate) → write OUTPUT for that one pair.** Get this clean before fanning out to the full 30-pair batch, before the per-researcher feed_summary calls, before the ambiguous-case substantive-vs-superficial verification, before coverage-role and no-drop assertions, and before degraded-state handling.
- **Per researcher, the council deliberates over the full 10-paper set first.** Batch-call the model (Message Batches API) for the council's per-pair decision.
- **Council-call context (required):** each deliberation receives the researcher's profile (`description`, `research_interests`, `topics`), the researcher's **research components with `source_paper_ids` provenance**, the researcher's **selected subfields**, and the candidate paper's **abstract** and metadata (title, categories, topics). **Never title-only; subfield match is an explicit factor.**
- **Council output per pair (required):** `relevance_decision` (bool), `relevance_score` (0–1), `council_confidence` (0–100), `relevance_reason` (grounded in abstract + matched component(s)/subfield(s)), `matched_components[].match_explanation`, `matched_subfields`, and the full `council_deliberation` record.
- **Substantive-vs-superficial instruction (system prompt):** the council must distinguish substantive advancement of a research thread from surface keyword overlap. A paper whose apparent match overstates its true relevance must be **argued down in `council_deliberation`**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test — deliberation must show real reasoning, not a coin flip.
- **Runtime council is canonical (§1a):** the orchestrator **overwrites** the fixture seed decision fields with the runtime council's values in the OUTPUT artifact. Divergence from the seed is expected and not flagged.
- **Instrumentation:** the council orchestration functions and **every eval assertion** are decorated `@weave.op()`, so the deliberation trace tree sits in the same Weave tree as the auto-instrumented SDK calls. **This trace tree is the auditability mechanism.**
- **Gate:** every (researcher, paper) pair carries all five council fields plus the grounding fields; per-researcher must-surface / must-dismiss / ambiguous roles reflected in the runtime decisions; substantive-vs-superficial reasoning present in deliberation for the ambiguous case; council calls and `@weave.op()` orchestration visible in the Weave trace tree.

### Phase 2B — Feed summary (post-decision, post-sort, per researcher)
- After the council has decided that researcher's full set **and after** the feed is sorted by `relevance_score` descending, issue the single `feed_summary` call against the decided, sorted feed. Enforce ordering in code: the summary call is **unreachable** before that researcher's council batch completes and the sort has produced an order.
- The summary is a **post-decision editorial call**: a single narrative per researcher naming the 2–3 strongest papers and their collective significance.
- It is **not** part of the council batch. Covered by the degraded-state contract: if it fails, that researcher's per-item feed still renders in full.
- Auto-traced by Weave like every other Anthropic call.
- **Gate:** `feed_summary` generated per researcher from the already-decided, already-sorted feed; call ordering verified (summary cannot run before that researcher's council completes); summary visible in Weave trace tree; OUTPUT validates against schema (OUTPUT gate).

### Phase 3 — Two-panel UI (reuse v2 dashboard, add researcher selector)
- Implement `dash-app-server.ts`, `dash-app-client.ts`, `dash-app.html`, `dash-app.css`.
- Reuse the **existing v2 two-panel dashboard, unchanged in structure** — left feed panel, right detail panel, independent scroll, collapsible sections.
- Server validates OUTPUT (per-researcher `feed` arrays + `feed_summary` objects) at startup; if validation fails, the dashboard does not start. The server is the only component that touches the data file; the client consumes API endpoints only.
- **Researcher selector** added (3 researchers). **Default selection: first researcher, top-ranked feed item.**
- **Feed summary region rendered at the top of the left panel**, above the ranked list — its own region with its own degraded state.
- Left panel feed: per-researcher feed_items in `relevance_score` order (position 1→10), each selectable, below the summary region.
- **Right detail panel** for the selected item: `relevance_reason`, `relevance_decision`, `council_confidence`, the **inspectable `council_deliberation`**, the matched component(s), and the researcher's matched subfield(s).
- **Researcher profile view** surfaces the researcher's selected subfields (`research_subfield_preferences`) — in addition to the council consuming them.
- **No silent drop in the UI:** items with `relevance_decision: false` render at their `relevance_score` position with reject reasoning visible — the demo shows the council *declining*, not only accepting.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) is **core, built here — not deferred to a stretch goal.**
- **Gate:** first researcher + top item selected on load; all right-panel sections collapsed to their label; two-panel layout with independent scroll per spec; feed summary region above the list; researcher selector functional; a `relevance_decision: false` item confirmed to render at its score position with reject reasoning; deliberation inspectable.

### Phase 4 — Degraded-state hardening
- Implement the failure contract as cross-cutting behavior in `subagent.ts` + `orchestrator.ts` + client rendering.
- A feed item whose **council decision** could not be produced renders at a **conservative position** with `decision_status: "unavailable"` and an explicit "decision unavailable — retry" state.
- Malformed model JSON for a pair is caught, **logged via the observability layer (Weave/W&B)**, and surfaced as `decision_status: "malformed"`.
- **feed_summary failure is independent:** if a researcher's summary call fails, that researcher's per-item feed still renders in full; the summary region shows "summary unavailable — retry" via `summary_status`. The summary is never a single point of failure for the whole feed.
- No feed item is ever silently dropped or blanked — a decision failure renders a retryable placeholder at a conservative position, not an empty panel.
- **Gate:** simulated failures (council decision and feed_summary, independently) render the correct retryable state at the right place without blanking or dropping; malformed-JSON path logged and surfaced.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per fixture/prompt iteration logs the aggregate — **per-researcher decision distributions, confidence distributions, accept/reject counts**, batch-call metadata (latency, token count, per-pair decision status), and eval pass/fail results.
- Each eval assertion is a `@weave.op()`.
- **Gate:** one clean W&B run logged with aggregate metrics and eval results; Weave trace tree and W&B run cross-reference the same iteration; OUTPUT written only on full eval pass.

---

## 3. Component Map (what to build, where)

| File | Layer | Responsibility |
|---|---|---|
| `Dockerfile` (+ compose/`.dockerignore`) | Sandbox | Builds the container the app runs in; `.env` mounted not baked; built first |
| `data/researchers.json` | INPUT | 3 researcher profiles (populated `description` / `research_interests` / `topics`) |
| `data/papers.json` | INPUT | 30 distinct papers (10 per researcher, no reuse), populated abstracts |
| `data/research_components.json` | INPUT | Per-researcher components, populated `source_paper_ids` provenance |
| `data/feed_items.json` | INPUT | 30 feed_items, council decision fields pre-populated as seed (runtime overwrites, §1a) |
| `data/research_subfield_preferences.json` | INPUT | Per-researcher selected subfields |
| `join.ts` | Compute (no LLM) | Explicit, mechanical id-join; asserts no orphans; no single-ownership assumption |
| `sequencer.ts` | Compute (no LLM) | Per-researcher sort (`relevance_score` desc, tie-break confidence, then recency) + `position` label + window-eligibility assertion + no-drop; pure function, unit-tested |
| `subagent.ts` | Pipeline | Wraps Batches API (10 deliberations per researcher in one batch) + single per-researcher feed_summary call; passes profile + components + subfields + abstract/metadata; returns council decision fields |
| `skills/council.ts` | Skill | The only skill; decides relevance; decision + substantive-vs-superficial + explicit-factors + grounding instructions |
| `orchestrator.ts` | Pipeline | Per researcher: join → council batch → sort → post-decision feed_summary → assembly (overwriting fixture seed, §1a) → eval; enforces call ordering; no per-case fan-out |
| `eval.ts` | Pipeline | Schema gate + sanity checks; aggregate errors, no short-circuit; each assertion `@weave.op()` |
| `run.ts` | Entry | CLI; `weave.init` at startup; writes OUTPUT once eval passes; logs W&B run; writes nothing on failure |
| `logger.ts` | Pipeline | JSONL trace; `traceId` through orchestrator → subagent → eval; subordinate to Weave/W&B |
| `dash-app-server.ts` | Dashboard | Validates + serves OUTPUT (per-researcher `feed` + `feed_summary`); only file-touching component |
| `dash-app-client.ts` | Dashboard | Rendering/selection/scroll; researcher selector; feed summary region; consumes API only |
| `dash-app.html` | Dashboard | Markup only; no inline styles/scripts |
| `dash-app.css` | Dashboard | External editorial stylesheet |

**Do not build:** `skills/guardrail.ts`, `memory.ts`, any per-case subagent fan-out, any deterministic LLM-free relevance sequencer, any numeric admission threshold, any "component cleared" constant, any `Read now / Save / Skip` action mapping. These are deliberately dropped or reversed (ARCHITECTURE §0, STRATEGY §0/§2a/§6).

---

## 4. The Output Contract

### 4.1 Per-feed-item contract

Every feed item in `public/output_data.json` must carry these fields. The council-decided fields come from `skills/council.ts` (the runtime council, canonical over any fixture seed, §1a); `position` comes from `sequencer.ts`; `decision_status` reflects degraded state.

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

The example `publication_date` (`2026-02-14`) sits within the recency window (2025-12-06 → 2026-06-06) — every fixture, including this example, is in-window.

**Field provenance — memorize this:**
- **Council-decided (Phase 2A, LLM):** `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, the full `council_deliberation` record. **The council decides these — there is no deterministic LLM-free relevance logic anywhere.** These are the *runtime* council's values, canonical over any fixture seed (§1a).
- **Deterministic presentation-only (Phase 1, no LLM):** `position` — assigned by the mechanical sort over `relevance_score` descending (tie-break `council_confidence` desc, then `publication_date` recency). `position` is an ordering label, **not a relevance decision.**
- **Grounding/subfield fields — required and eval-locked:** for every accepted item (`relevance_decision: true`), `matched_components` carries ≥1 entry with a populated `match_explanation` and a populated `source_paper_ids` provenance, and `matched_subfields` is populated.
- **`substantive_vs_superficial` — required in deliberation:** a paper whose apparent match overstates its true relevance must be **argued down**, not rubber-stamped. The per-researcher ambiguous coverage-role paper is the canonical test.
- **No-silent-drop:** items with `relevance_decision: false` are **retained** and rendered at their `relevance_score` position with reject reasoning visible.
- **Degraded-state (Phase 4):** `decision_status` ∈ `ok | unavailable | malformed`. When not `ok`, council prose fields carry a retryable placeholder and the item renders at a **conservative position**; the deterministic sort over available scores still holds for the rest of the feed.

### 4.2 Feed summary contract

The `feed_summary` is a separate per-researcher output region, not a per-item field. The output artifact is keyed by researcher: each researcher carries a `feed` array (per-item contract above) and a `feed_summary` object.

```json
{
  "feed_summary": {
    "text": "<council/editorial prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. When not `ok`, the summary region shows a retryable placeholder; the per-item feed renders in full regardless.

---

## 5. The LLM Calls — Exactly How

- **API:** Anthropic **Message Batches API** for the council deliberations. **One deliberation request per (researcher, paper) pair, 10 requests per researcher in batch submissions**, no nesting (the full council deliberation, decision fields, reason, and per-component/subfield explanations come back in one structured response — no per-component sub-calls). **Plus one post-decision `feed_summary` call per researcher.**
- **Total: 33 model calls per run** — 3 researchers × 10 deliberations = 30 council calls, plus 3 feed_summary calls. REQUIREMENTS specifies no numeric call/budget cap; 33 is the concrete pipeline cost. Should REQUIREMENTS later introduce a cap, verify against it.
- **Client:** `@anthropic-ai/sdk`, initialized with `maxRetries: 3`.
- **Model:** `claude-sonnet-4-6`. Pinned. No substitution.
- **Input to each council deliberation call:** the researcher's profile (`description`, `research_interests`, `topics`), the researcher's research components with `source_paper_ids` provenance, the researcher's selected subfields, and the candidate paper's abstract + metadata. **Never title-only; subfield match an explicit factor.**
- **Input to each feed_summary call:** the decided, sorted feed for that researcher. Issued **after** that researcher's council batch completes and **after** the sort has produced an order.
- **Output from each council call:** the full decision (decision, score, confidence, reason, grounding fields, deliberation record). The council decides — it is not handed a decision to explain.
- **Latency:** irrelevant by design — batch is asynchronous; poll for completion. Do not optimize for speed.
- **Tracing:** every call is auto-instrumented by Weave (`weave.init` at startup). The deliberation trace tree is the audit trail.

---

## 6. Eval Gates (eval.ts)

Aggregate all errors — do not short-circuit on first failure. On any failure, **OUTPUT is not written.** Each assertion is decorated `@weave.op()`.

- `validateSchema`: every fixture validates against its field contract (Ajv); every per-item output matches the per-item contract; **every feed_summary matches its contract.**
- `sanityCheck`:
  - Every cross-file id reference resolves (`feed_items.researcher_id`/`.paper_id`, `research_components.researcher_id`, `research_subfield_preferences.researcher_id`) — no orphans.
  - Scale: exactly 3 researchers, 30 papers (10 distinct per researcher, **no cross-researcher reuse**), 30 feed_items.
  - Every feed_item carries all five council fields (decision, score, confidence, reason, deliberation).
  - **Grounding/subfield fields populated per accepted item:** every `relevance_decision: true` item carries ≥1 `matched_components` entry with a populated `match_explanation` and a populated `source_paper_ids` provenance, and a populated `matched_subfields`.
  - Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous).
  - **Substantive-vs-superficial reasoning present** in `council_deliberation` for the ambiguous case — apparent overstatements argued down, not rubber-stamped.
  - **Display order matches `relevance_score`-descending sort** (tie-break confidence, then recency), recomputed and compared.
  - **No-silent-drop:** every `relevance_decision: false` item present at its score position; no feed_item dropped or hidden.
  - `feed_summary` present per researcher (or its degraded state).
  - **Recency window assertion** — all fixtures in-window.
  - **Runtime-canonical, no fixture-equality check (§1a):** eval validates the *runtime* council fields for presence, well-formedness, and internal consistency; it **never** asserts runtime output equals fixture-provided seed decisions — divergence is expected and not a failure.
- On failure: errors aggregated and reported; OUTPUT not written.

**Note:** there is no threshold to recompute, no action mapping to verify, no "component cleared" count to check — those v2 gates are deleted. Eval verifies the runtime council fields are present, well-formed, internally consistent, and that the coverage-role *intent* is reflected in the decisions (not a field-equality check, §1a).

---

## 7. Dashboard Rules

- **Server (`dash-app-server.ts`):** Node/Express, running inside the Docker sandbox. Reads and validates `public/output_data.json` (per-researcher `feed` arrays + `feed_summary` objects) at startup; if validation fails, **does not start** — no partial-success state. Only component that touches the data file. Add an ESM main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) so the HTTP server starts only when run directly, not when imported in tests.
- **Client (`dash-app-client.ts`):** consumes server API endpoints only — **never reads the data file directly.** Holds all rendering, researcher selection, feed-item selection, expansion, and scroll logic, including the feed summary region and its independent degraded state.
- **HTML (`dash-app.html`):** markup only — no inline styles, no inline scripts beyond loading the client module.
- **CSS (`dash-app.css`):** external stylesheet; editorial dark theme with serif titles.

**Layout invariants:**
- Two panels: left feed (the selected researcher's 10 items in `relevance_score` order 1→10, selectable), right detail.
- **Researcher selector:** 3 researchers selectable. **Default selection: first researcher, top-ranked feed item.**
- **Feed summary region at the top of the left panel**, above the ranked list — its own region with its own degraded state. When `summary_status` ≠ `ok`, it shows "summary unavailable — retry" while the per-item list renders in full.
- Each list item shows position, title, top matched component label, and the council's `relevance_decision` (accept/reject visibly distinct). **Position 1 selected by default on load.**
- Right panel sections (`relevance_reason`, `relevance_decision`, `council_confidence`, inspectable `council_deliberation`, matched component(s), matched subfield(s)) **all load collapsed to their label.** A **researcher profile view** surfaces the researcher's selected subfields.
- Both panels scroll independently.
- Collapsed sections have a fixed minimum height sufficient to show the label.
- **No-silent-drop in the UI:** items with `relevance_decision: false` render at their `relevance_score` position with reject reasoning visible — the demo shows the council *declining*, not only accepting.
- A feed item with `decision_status` ≠ `ok` still renders at a conservative position with a retryable placeholder — never a blank panel.

---

## 8. Definition of Done

- **Docker sandbox built first**; the application builds clean and runs entirely inside the container; `.env` mounted (not baked), confirmed gitignored, key never in any layer or commit.
- **The council decides relevance** for all 30 (researcher, paper) pairs; each decision carries `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, grounding fields, and a full `council_deliberation` record. No deterministic LLM-free relevance sequencer, no numeric admission threshold, no "component cleared" constant, no action mapping exists anywhere.
- Five fixture files validate against their field contracts; all cross-file id joins resolve orphan-free; the join is explicit and mechanical, with no single-ownership assumption for papers.
- Scale confirmed: 3 researchers, 30 papers (10 distinct each, no cross-researcher reuse), 30 feed_items; all `publication_date` in-window; synthetic IDs obviously synthetic.
- Per researcher, coverage roles present (≥1 must-surface, ≥1 must-dismiss, ≥1 genuinely ambiguous with non-trivial deliberation, plus a mid-tier spread).
- Council-call context complete: profile + components (with `source_paper_ids`) + subfields + paper abstract/metadata; subfield match weighed explicitly; never title-only.
- Substantive-vs-superficial reasoning preserved in `council_deliberation` for the ambiguous cases — apparent overstatements argued down, not rubber-stamped.
- Display order is `relevance_score` descending (tie-break confidence, then recency), reproducible and unit-tested; reject-decision items render at their score position, not dropped.
- Runtime council canonical: runtime values overwrite the fixture seed; divergence is expected and never flagged as an eval failure.
- LLM surface is exactly the council deliberation plus the post-decision per-researcher feed summary; 33 model calls per run (30 council deliberations + 3 feed_summary); the council decides — it is not handed a decision to explain.
- `feed_summary` generated per researcher from the decided, sorted feed after the council completes that researcher's set; rendered at the top of the left panel; degrades independently of the per-item feed; call ordering enforced in code (summary unreachable before the council completes and the feed is sorted).
- Two-panel editorial UI per spec — dark theme, serif titles, researcher selector, first researcher + top item selected on load, all right-panel sections collapsed to label, independent scroll, feed summary region above the list; detail panel shows reason, decision, confidence, inspectable deliberation, matched component(s), matched subfield(s); researcher profile surfaces selected subfields.
- Degraded-state contract holds under simulated failure for both council decision and feed_summary, independently; no blank panels, no dropped feed items; malformed JSON caught, logged to observability, surfaced as retryable.
- Observability complete and **load-bearing:** Weave traces every Anthropic call and every `@weave.op()` orchestration + eval function (deliberation trees are the audit trail); one W&B run logs per-researcher decision/confidence distributions, accept/reject counts, batch metadata, eval results; both share the single gitignored `.env` key and cross-reference the same iteration.
- Eval gates aggregate all errors; OUTPUT written only on a full pass.
- No guardrail skill, no `memory.ts`, no per-case fan-out; no deterministic LLM-free relevance logic, no numeric threshold/action mapping; no production-pipeline code, no live OpenAlex/arXiv/embedding/vector calls.