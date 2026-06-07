# ARCHITECTURE.md

## Atomic Research — Paper Relevance Feed (v3.2): Component Architecture

This document specifies what components exist and how they wire together. It executes the **v3.2** STRATEGY.md; it does not relitigate decisions made there (the council reversal, model ID, the council-decides design, degraded-state contract, two-stage LLM call ordering, the decision model in §2a, observability stack, the grounding stage + integrity model, **and now the relocation of the data source from local JSON fixtures to the live OpenAlex network boundary**).

**v3.2 supersede notice.** This ARCHITECTURE revises the v3.1 architecture. The v3.1 architecture stands in full **except** where the v3.2 delta governs. The load-bearing v3.2 change: **the four hand-written synthetic input fixtures are replaced with live pulls from `api.openalex.org`.** The grounding → council → summary pipeline is **unchanged** — it stops reading files and starts reading the output of a new fetch boundary. Three structural consequences:

1. The three former input fixtures (`researchers.json`, `publications.json`, `papers.json`) are **no longer files on disk** — they are **the output of a new fetch boundary** (§0c) that pulls from OpenAlex and applies five transforms. The pipeline downstream of the boundary is **shape-identical and source-blind**: it cannot tell a network response from a v3.1 fixture.
2. `feed_items.json` is **dropped as input entirely** — feed items are now the **output of the council scoring stage** (R-3.2-6). No code path reads feed items from disk.
3. `research_components` / `research_subfield_preferences` remain **Stage-1 grounding output** (unchanged), exactly as v3.1.

**The single load-bearing invariant of v3.2.** *Nothing in the grounding (Stage 1 + three-layer integrity model), council (Advocate / Skeptic / Judge), or eval logic changes.* V3.2 is **exclusively** the relocation of the data source. **All new behavior lives at the fetch boundary; nothing new lives anywhere else.** Any component, schema field, or eval gate below that reaches past the boundary to alter grounding, council, or eval logic is a **boundary leak** and is wrong (STRATEGY §0a, §6).

**v3.1 carry-over (do not relitigate):** the grounded profile is validated, not trusted; the three ordered integrity layers (sanitize → Layer 1 → Layer 2 → Layer 3); `source_paper_ids` carry genuine lineage into the `publications` corpus. **v3 carry-over (do not relitigate):** relevance is DECIDED by a multi-agent LLM council, not computed by a deterministic LLM-free function. Any component, schema field, or eval gate that reintroduces a deterministic LLM-free relevance sequencer, a numeric admission threshold, a "component cleared" constant, a `Read now / Save / Skip` action mapping, that treats Layer 3 as a hard gate, repairs a Layer 2 referential failure by re-prompting, or writes a partial profile on grounding failure is wrong and contradicts STRATEGY §2a/§1a/§6.

---

## 0. Architectural Confirmation & Adjustment

The agentic-harness template assumes the LLM produces the consequential judgment (triage, scoring, classification). **v3.2 leaves that alignment untouched** — Stage 1 (grounding) still *earns* the profile through an LLM extraction validated by an integrity model, and Stage 2 (council) still *decides* relevance per (researcher, paper) pair over the grounded profile. What v3.2 changes is **upstream of both**: a new fetch boundary replaces file reads with live OpenAlex pulls + five deterministic transforms. What remains deterministic is the *display ordering* (a mechanical sort over `relevance_score`), the integrity model's Layers 1–2, **and now the five fetch-boundary transforms** — none of which introduce LLM-free *relevance* logic.

The template's per-case fan-out applies, adapted to a fetch-boundary-fronted two-stage shape:

| Template component | Disposition in this build |
|---|---|
| **fetch boundary (NEW)** | **Added — the entire surface of v3.2.** Per confirmed author ID: resolves the author profile, own-works, and per-subfield candidate pulls from `api.openalex.org`; applies the five transforms (ID normalization, abstract reconstruction, dedup cascade, polite pool, degrade-to-empty); emits the v3.1 `researchers` / `publications` / `papers` shapes. Never throws upward. See §0c. |
| orchestrator.js | **Kept**, adapted — per researcher: (Stage 0) obtains boundary output for the confirmed author; (Stage 1) runs grounding extraction → integrity model → assembles the validated profile (or degraded state); (Stage 2) fans out the council deliberation batch over the candidate papers → sorts by `relevance_score` desc → issues the post-decision `feed_summary` call → assembles records → runs eval. Enforces the §2c call ordering (link→fetch→grounding→council→sort→summary) in code. |
| subagent.js | **Kept**, unchanged in topology — wraps the Anthropic SDK for: the two sequential single grounding calls (extraction Call 1, aptness validation Call 2) per researcher; the Message Batches API (per-pair council deliberations); and the single post-decision call (feed_summary). The LLM call topology is **untouched** by v3.2. |
| skills/primary.js | **Kept**, unchanged — `skills/grounding.ts` (Stage 1) and `skills/council.ts` (Stage 2), byte-for-byte unchanged from v3.1. |
| skills/guardrail.js | **Dropped** (as in v3/v3.1) — the v3.1 integrity model is a *deterministic* three-layer validation gate, **not** the escalate-only LLM guardrail. See §0b. |
| skills/sequencer.js | **Kept as a pure function, LLM-free.** Mechanical sort over council outputs (`relevance_score` desc, tie-break confidence, then recency). **No relevance decision** (STRATEGY §1, §2a). |
| eval.js | **Kept**, extended — v3 council gates + v3.1 grounding gates (byte-for-byte unchanged predicates) **plus new/relocated fetch-boundary gates** (boundary-output validity, ID normalization, dedup cascade, polite pool, degrade-to-empty, no-feed-items-read-path). See §5. |
| memory.js | **Dropped for v1.** Batch call with deterministic retry; the grounding repair loop handles grounding-failure replay in-place; degraded-state contract (Phase 4) handles surfacing; degrade-to-empty handles fetch failure. |
| logger.js | **Kept**, but **subordinate to the observability stack.** Weave (per-call) + W&B (per-run) are the primary instrumentation surface, now **extended to the fetch boundary + each transform.** |

This is a deliberate, documented alignment with the council-decides reversal (v3), the grounding-is-validated-not-trusted foundation (v3.1), and the data-source-is-live-but-source-blind relocation (v3.2).

## 0b. The Integrity Model Is Not the Guardrail (read before §5 Stage 1)

(Unchanged from v3.1.) The v3.1 grounding stage introduces a validation discipline that **must not be confused with the dropped escalate-only guardrail.** The GUARDRAIL_SPEC escalate-only pattern still has no referent here — there is no urgency enum.

The integrity model is a **three-layer validation pipeline** with a fixed, non-negotiable order (STRATEGY §1a):

> **sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.**

The load-bearing distinctions, enforced architecturally:

- **Layer 1 is deterministic structural validation with an LLM repair loop.** Predicate deterministic; repair re-prompts the LLM. Capped at **4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), deterministic sanitize after each. Still invalid after 4 → degraded state, **no partial profile written.**
- **Layer 2 is the deterministic referential gate — the backbone of trust.** Every `source_paper_id` in every component/subfield must resolve to a real paper in that researcher's `publications` corpus. Any non-resolving id is **hard-rejected deterministically** — **never repaired by re-prompting.** **v3.2 note:** the corpus is now the live own-works pull, post-transform; because the boundary normalizes all IDs to bare form *before* grounding runs, Layer 2 resolves bare-against-bare exactly as it did over fixtures (§0c, STRATEGY §1a v3.2 note).
- **Layer 3 is advisory.** Call 2's evidence-aptness flags surface weak-or-fabricated *semantic* lineage; they **inform, never auto-reject.**

**Three architectural prohibitions (enforced in code + eval):** never let Layer 3 auto-reject; never let Layer 1's repair loop attempt to "fix" a referential (Layer 2) failure; never write a partial profile on grounding failure (STRATEGY §1a, §6).

---

## 0c. The Fetch Boundary (NEW — the entire surface of v3.2; read before §5)

V3.2 introduces exactly one new architectural surface: **the fetch boundary** — the seam between `api.openalex.org` and the unchanged pipeline. Everything new lives here; nothing new lives anywhere else. The boundary's contract: **consume OpenAlex JSON, emit the v3.1 `researchers` / `publications` / `papers` shapes, and never throw upward.** Downstream of the boundary, the code cannot tell whether it was fed a file or a network response — that is the success condition (STRATEGY §0a).

**The boundary is implemented across two files (§5): `openalex-client.ts` (the polite-pool HTTP client) and `fetch-boundary.ts` (the five transforms + shape emission).** Every endpoint call and every transform is decorated `@weave.op()` so the fetch is in the trace tree from the start.

**Stage 0 — the fetch, sourced from a single confirmed author ID:**

- **R-3.2-1 — One-step author-link onboarding.** `GET /authors?search=<name>` returns relevance-ranked matches; the UI surfaces per match name, current affiliation, and `{works_count} papers · {cited_by_count} citations`; the user confirms "is this you?"; the **single confirmed OpenAlex author ID is persisted.** That one identity sources everything downstream — the sole human decision. **The fetch is unreachable-past until the link is confirmed.**
- **R-3.2-2 — `researchers` record.** `GET /authors/{id}` with `select=id,display_name,works_count,cited_by_count,summary_stats,topics` → the researcher record (name, h-index from `summary_stats.h_index`, citation count, works count, topics). Emits the v3.1 `researchers` shape.
- **R-3.2-3 — `publications` from own works.** `GET /works?filter=author.id:{id}&sort=publication_date:desc&per_page=50` → the `publications` set, the **only** input to Stage 1 grounding. First page only (no pagination — scope cut).
- **R-3.2-4 — Subfields from publications only, no user text.** Derive research components and subfield preferences **purely** from the publication record and its OpenAlex subfield tags (`primary_topic.subfield`). **No free-text description, no LLM-over-description inference.** Every linked user is a **Publisher** (Follower path out of scope). **Fallback (flagged):** if subfield-tag coverage on the author's own works is thin, **fall back to the author-profile `topics`** — wired explicitly.
- **R-3.2-5 — `papers` from the recurring subfield pull.** For each derived subfield, `GET /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}&sort=publication_date:desc&per_page=50`, **one call per subfield.** This candidate pool feeds the council. First page only.
  - **`{d}` — the date floor (a boundary constant, not a downstream choice):** `{d} = today − N days` for a fixed N — a single boundary-level recency window computed deterministically from run-time, applied identically to every subfield call. **Not** user input, **not** per-researcher. It controls candidate-pool size only and touches **no grounding, council, or eval logic.**
- **R-3.2-6 — `feed_items` is output, not input.** No feed-items fetch exists; feed items become the output of the council scoring stage. Any code path reading feed items from disk is **removed.**

**The five fetch-boundary transforms (R-3.2-7) — at the boundary and nowhere else:**

1. **ID normalization** — strip `https://openalex.org/` from every ID (works, authors, topics, subfields, **and each entry of `referenced_works`**); strip `https://doi.org/` from DOIs; normalize arXiv IDs. Produces the same bare-id id-space the v3.1 joins and the referential gate assume. **Must complete before grounding runs** so Layer 2 compares bare-against-bare (§0b v3.2 note).
2. **Abstract reconstruction** — rebuild plain text from `abstract_inverted_index` (word → positions); **`null` when absent.** The council still never reasons from title alone; an absent abstract is a `null`, not a crash, handled by existing council reasoning.
3. **Deduplication cascade** — collapse the same paper by the fixed precedence `arxiv_id → doi → openalex_id → new record`.
4. **Polite pool** — send `mailto=<monitored-email>` plus a self-identifying `User-Agent` on **every** request; an optional `OPENALEX_API_KEY` raises rate limits but is **never required** — the build must run without it.
5. **Degrade-to-empty** — every OpenAlex call returns `[]` / `null` / skips the item on error and **never throws upward.** Total OpenAlex failure yields **zero new feed items, not a crash** (the UI face is the "no new papers available — retry" surface, §6). Every degrade is **logged via Weave/W&B, never silent.**

**Design rule, enforced in code + eval:** these transforms are the *only* new logic. Anything that reaches past the boundary to "fix" grounding, council, or eval behavior is a boundary leak and must be rejected.

---

## 0a-a. Docker

Put the application in a Docker sandbox container so it is secure and Claude Code operates inside that sandbox. Build all Docker components first (STRATEGY §3 Phase 0): wire the dashboard (OUTPUT); mount `.env` at runtime, do not bake it into the image; **permit outbound network egress to `api.openalex.org`.** **v3.2 change: INPUT is no longer mounted fixtures — it is the live OpenAlex client.** `research_components` / `research_subfield_preferences` are **not** wired as input — they are Stage-1 output; `researchers` / `publications` / `papers` are **not** wired as input either — they are fetch-boundary output; `feed_items` is **not** read at all — it is council output.

---

## 0a. Observability Stack (cross-cutting, wired Phase 0)

Per STRATEGY §2 and §3, observability is a phase, not an afterthought, and in v3.2 it is **load-bearing for auditability across the fetch boundary and both stages** — the fetch trace tree (every endpoint call + each transform, including degrades), the grounding trace tree, and the council deliberation trace tree are all the audit trail. Wired before any LLM or network call.

- **Weave (per-call).** `weave.init("<team>/atomic-research")` is called once at pipeline startup (`run.ts`), before any Anthropic or OpenAlex call. It auto-instruments the Anthropic SDK so both grounding calls, every per-pair council deliberation call, and the feed_summary call appear in the trace tree. Team functions — **the OpenAlex client + each of the five transforms (new)**, the grounding orchestration + every integrity-layer assertion, the council orchestration logic, and every eval assertion — are decorated `@weave.op()` so they sit in the same trace tree. **A degraded OpenAlex call must be visible, not silent.**
- **W&B (per-run).** One `wandb` run per author-link/prompt iteration logs the pipeline-level aggregate: v3 council metrics + v3.1 grounding metrics **plus fetch metrics (new): authors-search hit count, works pulled per author, candidate papers pulled per subfield, dedup collapses, abstract-null count, per-endpoint error/degrade count** (Phase 5).
- **Secrets.** `WANDB_API_KEY` (required) **and `OPENALEX_API_KEY` (optional)** read from a gitignored `.env`; confirmed in `.gitignore` before any commit. Never hardcoded, never committed. Mounted into Docker, not baked. **The build must run without `OPENALEX_API_KEY`.**
- **Cross-reference.** The Weave trace tree (fetch + transforms + grounding + council + summary) and the W&B run reference the same iteration (Phase 5 exit).

Application model for the built artifact's runtime calls is `claude-sonnet-4-6` (pinned snapshot, STRATEGY §2), governing both grounding calls, council, and summary — **unchanged by v3.2** (the fetch boundary makes no LLM calls). This governs the artifact's runtime only — not the build session.

---

## 1. Pipeline Shape — Three Stages, File-Based Handoffs

Stage boundaries are files, not live connections. The pipeline writes; the server serves; the client reads. **v3.2 note: the INPUT stage is no longer a set of mounted files — it is the fetch boundary's output, validated at the boundary against the same v3.1 field contracts and frozen for the run.** The OUTPUT stage and the file-based dashboard handoff are unchanged.

**INPUT (now boundary output, not files)** — per confirmed author ID, the fetch boundary (§0c) emits the `researchers`, `publications`, and `papers` shapes the pipeline expects, schema-validated against the same v3.1 field contracts (Ajv), then frozen for the run. Read by the pipeline; never modified during a run. **`publications` (own-works pull) and candidate `papers` (subfield pull) are never conflated — different roles, different origins, different join semantics, different id-spaces** (even though both now originate from `/works`). Each candidate paper carries a reconstructed abstract or `null`; each researcher carries name, h-index, citation/works counts, topics; each publication carries OpenAlex-shaped fields with **bare, normalized identifiers.** **`feed_items` is no longer ingested at all — it is council output** (R-3.2-6). **There is no numeric feed-admission cutoff** — every feed_item renders at its score position (STRATEGY §2a, no-silent-drop).

**`research_components` / `research_subfield_preferences` are NOT input** — they are Stage-1 *output*, produced by the grounding stage and validated by the integrity model before the council can run (unchanged from v3.1).

**PIPELINE** — `run.ts` + **fetch boundary (openalex-client + fetch-boundary)** + orchestrator + subagent + grounding skill + council skill + integrity model (sanitizer + three layers) + deterministic sequencer (sort only) + eval. Reads boundary output, produces OUTPUT. Per researcher: confirm author link → Stage-0 fetch + five transforms → Stage-1 grounding (extraction → integrity model → validated profile or degraded state) → Stage-2 council deliberation batch → the `relevance_score`-descending sort → the post-decision `feed_summary` call → schema validation and assembly. Writes OUTPUT exactly once per run, after eval gates pass.

**OUTPUT** — single validated artifact at `public/output_data.json`. Written by `run.ts` after eval gates pass; never modified after write. The dashboard reads this file via the dashboard server.

No data flow between stages at render time. The dashboard renders finalized output; it does not fetch, ground, decide relevance, sort, or call the LLM.

---

## 1a. Runtime Council Is Canonical; No Fixture-Equality Check

(Adapted from v3.1.) With the synthetic fixtures gone, there is **no fixture-provided decision seed at all** — feed items are produced purely as council output (R-3.2-6). The runtime council is canonical, and there is no pre-populated decision to overwrite or compare against.

- **The runtime council produces the decision fields.** For each (researcher, paper) pair, the OUTPUT artifact carries the runtime council's `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and `council_deliberation`.
- **No fixture-equality check exists** — there is no authored conclusion to match. The council is non-deterministic by design; eval validates *structural*, *referential*, and *internal-consistency* properties of its output, never equality to a pre-authored answer (which §2a forbids).
- **No synthetic coverage-role planting over live data.** In v3.1 the eval also asserted a hand-authored must-surface / must-dismiss / ambiguous **coverage spread** — but that spread was a property of the *synthetic fixtures*, not of any pipeline logic. With the fixtures gone, **that fixture-property assertion is dropped** (STRATEGY §5, §6). This is **not** a relaxation of any eval gate: every grounding, council, and ordering gate keeps its exact v3.1 pass/fail predicate, applied now to the live candidate set. **Do not** reintroduce synthetic coverage planting to manufacture a spread over live data.

**v3.1 carry-over — the grounded profile is canonical over any seed shape.** The components/subfields the council reasons over at runtime are the **Stage-1 grounded, validated** ones (carrying real `source_paper_ids` into the live `publications` corpus). Eval validates the grounded profile's *structural* and *referential* properties (Layers 1–2 as eval gates), never that it equals a pre-authored conclusion.

---

## 1b. Grounding Output (Stage-1 Intermediate) — Schema & Lineage

(Unchanged from v3.1 in shape; the `source_paper_ids` now resolve into the **live, bare-normalized** `publications` set.) The grounded profile is an intermediate artifact, validated before the council consumes it. Per researcher, after the integrity model passes:

```json
{
  "researcher_id": "A5023888391",
  "grounding_status": "ok",
  "research_components": [
    {
      "name": "Sparse autoencoder feature steering",
      "description": "<what the component is>",
      "source_paper_ids": ["W2034567890", "W3145678901"],
      "explanation": "<why this evidence supports the conclusion>",
      "aptness_flags": []
    }
  ],
  "research_subfield_preferences": [
    {
      "name": "Mechanistic interpretability",
      "description": "<what the subfield is>",
      "source_paper_ids": ["W2034567890"],
      "explanation": "<why this evidence supports the conclusion>",
      "aptness_flags": []
    }
  ]
}
```

The example ids are **bare OpenAlex work ids** (`W…`) and a bare author id (`A…`) — post-normalization, no `https://openalex.org/` prefix, by design.

Field rules (eval-locked, §5):
- **`source_paper_ids` resolve into the live `publications` set only** — never into the candidate `papers` id-space. Genuine-lineage backbone (Layer 2), now bare-against-bare post-transform.
- **Every component/subfield carries** a non-empty `name`, `description`, non-empty `source_paper_ids`, and an `explanation`. Structural predicate (Layer 1).
- **`aptness_flags`** is the Call-2 advisory output (Layer 3) — never auto-rejecting.
- **`grounding_status` ∈ `ok | unavailable`.** `unavailable` = grounding failed (still structurally invalid after 4 repair attempts, or no component survived the referential gate); **no partial profile is written.**

---

## 2. Output Schema

### 2.1 Per-feed-item contract

Proposed JSON shape for one feed item in a researcher's feed array. This is the per-item output contract Ajv enforces.

```json
{
  "feed_item_id": "FEED-A5023888391-03",
  "researcher_id": "A5023888391",
  "paper_id": "W4392011234",
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
      "source_paper_ids": ["W2034567890", "W3145678901"],
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

All ids are **bare OpenAlex ids** (`researcher_id` an `A…` author id; `paper_id` and `source_paper_ids` `W…` work ids) — post-normalization, no prefixes. The `publication_date` is consistent with the `{d}` recency window in force for the run (computed `today − N days`).

**Schema-shape note on `feed_item_id`, `position`, and `decision_status` (presentation/assembly detail, not logic change).** `feed_item_id` (a derived `FEED-{researcher_id}-{NN}` assembly label), `position` (the deterministic sort label, §2.1 below), and `decision_status` (`ok | unavailable | malformed`, the per-item degraded-state marker, Phase 4) are **output-artifact assembly/presentation fields**, not pipeline-logic fields. They carry **no grounding, council, or eval logic**: `feed_item_id` is a stable identity label assembled deterministically from the bare `researcher_id` and the item's sorted position; `position` is the mechanical-sort label (no relevance decision); `decision_status` is the degraded-state surface marker (STRATEGY degraded-state contract, §6). They are surfaced here as the concrete per-item output schema shape consistent with the v3.1 field contracts referenced by STRATEGY; if any is new relative to v3.1, it is a schema-shape elaboration of the same output contract, **never** a change to the no-logic-change invariant.

**v3.2 lineage note:** `matched_components[].source_paper_ids` reference the **grounded, validated** components from Stage 1 — they resolve into the live `publications` set (the author's actual OpenAlex own works), **not** the candidate `papers` id-space. The lineage is no less genuine than v3.1; it now points at the author's actual OpenAlex works. **An absent candidate abstract is reconstructed as `null` and handled by existing council reasoning — never a crash, never title-only.**

Field provenance:

- **Council-decided (Phase 2A, LLM):** `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `matched_components[].match_explanation`, `matched_subfields`, and the full `council_deliberation` record. Canonical; no fixture seed (§1a).
- **Grounded (Phase G, LLM + integrity model):** the `matched_components` the council references — name and `source_paper_ids` provenance — originate from the Stage-1 validated profile.
- **Boundary-emitted (Stage 0, transforms only):** `paper_id`, `title`, `publication_date`, and the candidate abstract the council reasons over — all bare-normalized; abstract reconstructed or `null`.
- **Deterministic presentation-only (Phase 1, no LLM):** `position` — assigned by the mechanical sort over `relevance_score` descending (tie-break `council_confidence` desc, then `publication_date` recency). An ordering label, **not a relevance decision.** `feed_item_id` is assembled deterministically alongside `position`.
- **Component lineage — required and eval-locked:** for every accepted item, `matched_components` must carry ≥1 entry with a populated `match_explanation` and `source_paper_ids` provenance **resolving into the live `publications` set**. §5 asserts this.
- **Subfield match — weighed, not mandated non-empty (STRATEGY §2a):** subfield match is an **explicit council factor** weighed *inside* deliberation; eval does **not** require `matched_subfields` non-empty on every accepted item; it requires subfield match was *weighed* (`council_deliberation.subfield_weighing` present and substantive) and `matched_subfields` populated **where subfield match was a deciding factor**.
- **`substantive_vs_superficial` — required in deliberation:** distinguish substantive advancement from surface keyword overlap; overstatements **argued down in `council_deliberation`**, not rubber-stamped.
- **No-silent-drop:** `relevance_decision: false` items **retained** at their score position with reject reasoning visible.
- **Degraded-state (Phase 4):** `decision_status` ∈ `ok | unavailable | malformed`. When not `ok`, council prose fields carry a retryable placeholder and the item renders at a **conservative position**.

### 2.2 Feed summary contract

(Unchanged from v3.1.) The `feed_summary` is a separate per-researcher output region. Generated by a single post-decision call (Phase 2B), takes the decided, sorted feed as input, degrades independently.

```json
{
  "feed_summary": {
    "text": "<editorial prose naming the 2–3 strongest papers and their collective significance>",
    "summary_status": "ok"
  }
}
```

`summary_status` ∈ `ok | unavailable | malformed`. The output artifact is keyed by researcher: each researcher carries `grounding_status`, the grounded profile (§1b), a `feed` array (the per-item contract above), and a `feed_summary` object. A researcher in `grounding_status: "unavailable"` carries no feed (the council does not run for them) and renders the grounding degraded state. **A run where total OpenAlex failure yielded zero candidate papers renders the "no new papers available — retry" OpenAlex degraded surface (§6).**

### Model-call estimate

The pipeline uses three LLM call families; **the fetch boundary makes no LLM calls** (it issues OpenAlex HTTP requests only). Multiplying through every level, per confirmed author / researcher:

- **Fetch (Stage 0) — OpenAlex HTTP requests, no LLM:** 1 author-search (onboarding) + 1 author-profile + 1 own-works pull + **one candidate pull per derived subfield** (typically a small number per researcher). These are network calls, not model calls; they do not count against the model-call budget but **do** carry the polite pool and degrade-to-empty.
- **Grounding (Stage 1) — 2 sequential single calls per researcher** (extraction Call 1 + aptness Call 2), with up to 4 repair re-prompts per researcher worst case (structural failures only). **Unchanged from v3.1.**
- **Council (Stage 2) — Message Batches API, one deliberation per (researcher, paper) pair** over the live candidate set. **Unchanged in topology.**
- **Feed summary — one post-decision call per researcher.** **Unchanged.**

The model-call topology is **identical to v3.1**; only the *candidate-set size* now derives from the live subfield pull rather than a fixed 10-per-researcher fixture. **Cap check:** the subfield pull is first-page-only (`per_page=50`, no pagination) and the `{d}` recency window bounds the candidate pool; this keeps the council batch within the test-data sizing budget (runtime under ~5 min, burst under the rate ceiling). REQUIREMENTS.md does not specify a numeric call/budget cap; should it later introduce one, the live candidate-pool size (bounded by `{d}` and `per_page=50` first-page-only) is the value to verify against it. **Architecture flag:** if a future widening of `{d}` or per-subfield count pushes the council batch past the rate ceiling, that is a boundary-parameter tuning concern (narrow `{d}` / fewer subfields), never a change to council logic.

---

## 2c. Call Ordering (architectural, enforced in code)

Per STRATEGY §1 and §3 Phase F/G/2A/2B, call ordering is architectural, not incidental, and **now extends to the fetch.** **Per researcher:**

0. **Author link confirmed first (Stage 0a).** The fetch is **unreachable-past until the link is confirmed** — no identity, no pull. The single confirmed OpenAlex author ID sources everything downstream.
1. **Fetch + five transforms second (Stage 0b).** The boundary resolves author profile, own-works, and per-subfield candidate pulls, applies ID normalization (**before grounding**), abstract reconstruction, dedup cascade, polite pool, and degrade-to-empty, and emits the `researchers` / `publications` / `papers` shapes. **Grounding is unreachable-past until the boundary has emitted normalized output** — ID normalization **must complete before grounding** so Layer 2 resolves bare-against-bare (§0b, §0c).
2. **Grounding deliberates third (Stage 1)** — extraction Call 1 → integrity model (sanitize → Layer 1 structural+repair → Layer 2 referential gate → Layer 3 aptness flags from Call 2) → authoritative profile assembled from what passed. **The council is unreachable-past until grounding produced a validated profile.** If grounding ends degraded, the council does **not** run for that researcher.
3. **Council deliberates the candidate set fourth (Stage 2)** — the batch of per-pair deliberation calls decides relevance over the **grounded** profile. Each call receives the researcher's profile, the **grounded, validated research components with real `source_paper_ids` provenance** (into the live `publications` set), the **grounded selected subfields**, and the candidate paper's **abstract** (reconstructed or `null`) and metadata (never title-only; subfield match an explicit factor).
4. **Sort runs fifth** (deterministic) — `relevance_score` descending, tie-break `council_confidence` desc, then `publication_date` recency. Pure sort; makes no relevance decision.
5. **`feed_summary` runs sixth** — takes the decided, sorted feed as input. **Not** a peer of the council batch and **must not** be issued before the council has finished that researcher's set and the sort has produced an order.

This ordering is enforced in code in `orchestrator.ts`: the fetch is unreachable before the link is confirmed; grounding is unreachable before the boundary emitted normalized output; the council batch is unreachable before grounding produced a validated profile; the summary call is unreachable before that researcher's council batch completes and the feed is sorted.

---

## 3. First Slice (smallest end-to-end)

Per template stage gates, adapted for the fetch-boundary-fronted two-stage build:

1. **Slice 0 — INPUT gate (now the boundary, not files).** From a single confirmed OpenAlex author ID, the fetch boundary emits valid `researchers`, `publications`, and `papers` shapes that pass the Ajv field contracts; the subfield pull uses the fixed run-time-derived `{d}` recency window (not an arbitrary date); **all IDs are bare** (no `openalex.org` / `doi.org` prefixes, including every `referenced_works` entry; arXiv IDs normalized); abstracts reconstructed or `null`; the dedup cascade collapses a planted duplicate by the correct precedence; polite-pool headers (`mailto` + `User-Agent`) present on every request; a **simulated per-endpoint failure degrades to `[]`/`null`/skip without throwing**; thin-subfield-coverage falls back to author `topics`; **no feed-items read path exists**; every transform visible in the Weave trace tree; the build runs **without `OPENALEX_API_KEY`**. The Stage-1 *output* schema (§1b) is wired but not authored. `weave.init` runs clean; `.env` confirmed gitignored; container builds with OpenAlex egress. **No application component downstream of the boundary before this passes.**
2. **First runnable slice (boundary → Stage 1 → one council pair):** `run.ts` → confirm one author link → `openalex-client.ts` + `fetch-boundary.ts` (emit `researchers`/`publications`/`papers` for that author, all transforms applied) → `subagent.ts` (grounding extraction Call 1 + aptness Call 2 for that **one** researcher) → integrity model (sanitize → Layer 1 → Layer 2 over the bare-normalized live `publications` → Layer 3) → assemble that researcher's validated profile → `subagent.ts` (council deliberation call for **one** (researcher, paper) pair over that profile) → `sequencer.ts` (sort that one-item feed) → `eval.ts` (schema gate + ID-normalization gate + referential-integrity gate) → write OUTPUT for that one pair. **ID normalization must complete before grounding; grounding must run and validate before the council call** — the slice proves the link→fetch→grounding→council ordering end-to-end.
3. Defer the full multi-subfield candidate pull, the grounding repair-loop exercise, the per-researcher feed_summary calls, the substantive-vs-superficial ambiguous-case verification, the dedup/degrade-to-empty/polite-pool eval gates at scale, and full degraded-state handling until the one-author / one-pair path runs clean end-to-end.
4. **OUTPUT gate.** `public/output_data.json` validates against the output schema (grounded profile + feed + feed_summary) before the dashboard slice begins.
5. Dashboard is the final phase. It renders finalized output only.

---

## 4. New Dependencies

| Dependency | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic client: grounding extraction + aptness calls (single), Message Batches API (per-pair council deliberations), per-researcher feed_summary calls. **Unchanged by v3.2.** |
| **`undici` / native `fetch` (NEW)** | **OpenAlex HTTP client** in `openalex-client.ts` — polite-pool requests (`mailto` + `User-Agent`, optional `OPENALEX_API_KEY`) to `/authors`, `/authors/{id}`, `/works`. Native `fetch` (Node 18+) suffices; no heavy HTTP framework. |
| `ajv` | JSON Schema validation: **boundary-output field contracts** (`researchers` / `publications` / `papers` — same v3.1 shapes, now over transformed network data) + grounded Stage-1 output shape + per-item output contract + feed_summary contract |
| `typescript` + `tsx` (or `ts-node`) | Type-safe enforcement of the **boundary-output shapes**, grounding output shape, and council output shape; run `.ts` directly |
| `weave` | Per-call observability; auto-instruments the Anthropic SDK; `@weave.op()` on **the OpenAlex client + each of the five transforms (new)** + grounding orchestration + every integrity-layer assertion + council orchestration + every eval assertion (STRATEGY §2) |
| `wandb` | Per-run observability; one run per author-link/prompt iteration, **fetch + grounding + council metrics** (STRATEGY §2) |

No other runtime dependencies. Styling is hand-authored CSS (STRATEGY §2). **No embedding/centroid/cosine libraries, no pagination loop, no local fixture reads — explicitly out of scope (STRATEGY §6).** The `publications` corpus and candidate `papers` now come from the live network, not synthetic files.

---

## 5. Component Architecture

### Fetch boundary (NEW — deterministic transforms; no LLM, no relevance logic)

0a. **openalex-client.ts** — the **polite-pool HTTP client.** Wraps native `fetch` for `GET /authors?search=`, `GET /authors/{id}`, and `GET /works?filter=…`. Baked-in policy:
   - **Polite pool** — `mailto=<monitored-email>` + a self-identifying `User-Agent` attached to **every** request; reads optional `OPENALEX_API_KEY` from `.env` and attaches when present; **runs without it.**
   - **Degrade-to-empty** — every call returns `[]` / `null` / skips the item on error and **never throws upward**; a degraded call is **logged via Weave/W&B, never silent.**
   - First-page-only (`per_page=50`, no `cursor`/page loop — pagination out of scope).
   - Each endpoint method decorated `@weave.op()` so the fetch is in the trace tree.

0b. **fetch-boundary.ts** — the **five transforms + shape emission.** Consumes raw OpenAlex JSON from `openalex-client.ts`, emits the v3.1 `researchers` / `publications` / `papers` shapes. Pure/deterministic. Implements, at the boundary and nowhere else (§0c):
   - **`normalizeIds(raw)`** — strip `https://openalex.org/` from every ID (works, authors, topics, subfields, **and every `referenced_works` entry**); strip `https://doi.org/` from DOIs; normalize arXiv IDs. **Runs before grounding sees any data** so Layer 2 resolves bare-against-bare.
   - **`reconstructAbstract(invertedIndex)`** — rebuild plain text from `abstract_inverted_index`; **`null` when absent.**
   - **`dedupeCascade(papers)`** — collapse by fixed precedence `arxiv_id → doi → openalex_id → new record`.
   - **`buildResearcher(authorProfile)`** (R-3.2-2), **`buildPublications(ownWorks)`** (R-3.2-3), **`buildCandidatePapers(subfieldPulls)`** (R-3.2-5) — emit the three v3.1 shapes.
   - **`deriveSubfields(publications, authorProfile)`** (R-3.2-4) — derive components/subfields **purely** from the publication record and its OpenAlex subfield tags (`primary_topic.subfield`); **no free-text, no LLM-over-description inference.** **Fallback:** if subfield-tag coverage is thin, fall back to author-profile `topics` — wired explicitly.
   - **`{d}` derivation** — `{d} = today − N days` for a fixed N, computed once per run from run-time, applied identically to every subfield call. **Not** user input, **not** per-researcher.
   - Each transform decorated `@weave.op()`; the boundary itself **never throws upward** (degrade-to-empty propagated from the client).
   - **Boundary prohibition (enforced in code + eval):** these transforms are the *only* new logic; nothing here reaches past the boundary to alter grounding, council, or eval behavior. **No feed-items read path exists** (R-3.2-6).

### Compute layer (deterministic — NO relevance logic; integrity Layers 1–2 deterministic)

1. **sequencer.ts** — pure function, **LLM-free, ordering only.** (Unchanged from v3.1.) Takes a researcher's feed items *after the council has decided them*, returns the array ordered by:
   - `relevance_score` descending (the council's calibrated relevance — the only ordering signal).
   - Tie-break: `council_confidence` descending, then `publication_date` recency.
   - Assigns the `position` label per item.
   - **No admission filter:** `relevance_decision: false` items retained at their score position (no-silent-drop).
   - **No recency filtering in the sequencer.** The `{d}` recency window is enforced **solely at the fetch boundary** (the subfield pull's `from_publication_date:{d}` floor); all candidates the sequencer ever sees are already in-window by construction. The sequencer performs **no candidate-pool filtering of any kind** — `publication_date` recency is used **only** as a final tie-break in the sort, never to admit or drop an item. The sequencer remains a pure sort.
   - **No relevance decision, no numeric admission threshold, no "component cleared" constant, no action mapping.** These v2 constructs remain deleted (STRATEGY §2a, §6).
   - **`paper_id` independent of `researcher_id`:** the sort operates per researcher over explicit id-joined items; no single-ownership assumption.
   - Fully unit-tested for order stability, tie-break correctness, no-drop behavior.

2. **join.ts** — pure function, **LLM-free.** (Unchanged logic; now operates over bare, normalized IDs from the boundary.) Implements the explicit, mechanical id-join: feed-item `researcher_id` / `paper_id` resolve against parents; **grounded** `research_components.researcher_id` / `research_subfield_preferences.researcher_id` resolve against `researchers`, and their `source_paper_ids` **resolve into the live `publications` set (not `papers`)**. The join is never inferred — asserts no orphans. By explicit id only; no single-ownership assumption for papers. **Publications (own-works pull) and candidate papers (subfield pull) remain distinct id-spaces — `source_paper_ids` resolve into `publications` only** (STRATEGY §3 Phase 1).

3. **integrity.ts** — the **deterministic integrity model** (Layers 1 & 2; Layer 3 attached from Call 2). (Unchanged from v3.1.) Pure/deterministic except the repair re-prompt (delegated to `subagent.ts`). Implements, in fixed order (§0b, STRATEGY §1a):
   - **`sanitize(raw)`** — strip markdown fences, control characters, trailing commas; attempt `JSON.parse`.
   - **Layer 1 — `validateStructural(profile)` + repair loop:** structural predicate (parseable object, non-empty, every component/subfield carries non-empty `source_paper_ids` and required fields `name` / `description` / `explanation`). On failure, **repair by re-prompting the LLM** — capped at **4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), `sanitize` after each. Still invalid after 4 → degraded state; **no partial profile.**
   - **Layer 2 — `validateReferential(profile, publications)`:** every `source_paper_id` must resolve to a real paper in that researcher's **live `publications` set** (