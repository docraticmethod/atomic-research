# STRATEGY.md

## Atomic Research — Paper Relevance Feed (v3.2): Build Strategy

This document translates the **v3.2 delta** (on top of v3.1) REQUIREMENTS.md into an execution plan. It is binding on downstream implementation. Where requirements decided something at requirements-time (the council reversal, model ID, visual treatment, degraded-state contract, observability stack, the grounding stage + integrity model, **and now the relocation of the data source from local JSON to the live OpenAlex network boundary**), strategy executes it — it does not relitigate it.

**v3.2 supersede notice.** This STRATEGY revises the v3.1 strategy. The v3.1 strategy stands in full **except** where the v3.2 delta governs. The load-bearing v3.2 change: **the four hand-written synthetic input fixtures are replaced with live pulls from `api.openalex.org`.** The orchestrator's `grounding → council → summary` pipeline is **unchanged** — it stops reading files and starts reading the network. **All new behavior lives at the fetch boundary; nothing in the grounding, council, or eval logic changes.**

**The single load-bearing invariant of v3.2.** *Nothing in the grounding (Stage 1 + three-layer integrity model), council (Advocate / Skeptic / Judge), or eval logic changes.* V3.2 is **exclusively** the relocation of the data source. Any change proposed to grounding, council, or eval logic is out of scope and must be rejected — it is a sign the fetch boundary leaked.

**Fixture → source map (the entire surface of v3.2):**

| v3.1 input fixture | v3.2 source | Endpoint |
|---|---|---|
| `researchers.json` | linked author profile | `GET /authors/{id}` |
| `publications.json` | linked author's own recent works | `GET /works?filter=author.id:{id}` |
| `papers.json` | recurring candidate pull by subfield | `GET /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}` |
| `feed_items.json` | **dropped as input** — now the *output* of the council scoring stage | — |

**What v3.2 does NOT change** (carried verbatim from v3/v3.1, do not relitigate): the council *decides* relevance (no deterministic LLM-free sequencer); the grounding stage earns the profile through the three ordered integrity layers (sanitize → Layer 1 → Layer 2 → Layer 3); the two-panel editorial UI; `feed_items` decision fields; `feed_summary` as a post-decision per-researcher call; Docker sandbox first; `claude-sonnet-4-6` pinned; `.env` gitignored and mounted-not-baked; no embeddings; the `publications` (grounding corpus) vs candidate `papers` (council input) role separation. **What moves is the data source only**: from frozen local JSON to a live network boundary that, after its transforms, hands the pipeline the *same shapes* it consumed in v3.1.

---

## 0a. The fetch boundary is the entire job (read first)

V3.2 introduces exactly one new architectural surface: **the fetch boundary** — the seam between `api.openalex.org` and the unchanged pipeline. Everything new lives here; nothing new lives anywhere else. The boundary's contract: **consume OpenAlex JSON, emit the v3.1 fixture shapes, and never throw upward.** Downstream of the boundary, the code cannot tell whether it was fed a file or a network response — that is the success condition.

**The five fetch-boundary transforms (R-3.2-7), applied at the boundary and nowhere else:**

1. **ID normalization** — strip the `https://openalex.org/` prefix from every ID (works, authors, topics, subfields, **and each entry of `referenced_works`**); strip `https://doi.org/` from DOIs; normalize arXiv IDs. Produces the same bare-id id-space the v3.1 joins and the referential gate already assume.
2. **Abstract reconstruction** — rebuild plain text from `abstract_inverted_index` (word → positions); `null` when absent. The council still never reasons from title alone — but an absent abstract is a `null`, not a crash.
3. **Deduplication cascade** — collapse the same paper by the fixed precedence `arxiv_id → doi → openalex_id → new record`.
4. **Polite pool** — send `mailto=<monitored-email>` on every request plus a self-identifying `User-Agent`. An optional `OPENALEX_API_KEY` raises rate limits but is **never required** — the build must run without it.
5. **Degrade-to-empty** — every OpenAlex call returns `[]` / `null` / skips the item on error and **never throws upward.** Total OpenAlex failure yields **zero new feed items, not a crash.**

**Design rule for downstream:** these transforms are the *only* new logic. Anything that reaches past the boundary to "fix" grounding, council, or eval behavior is a boundary leak and must be rejected.

---

## 1. Architecture Overview

A single-page desktop application, run locally, with a clean separation between layers, now fronted by **a fetch boundary that replaces the data layer's file reads with live OpenAlex pulls + transforms**, then the unchanged grounding stage, then the unchanged council:

0. **Fetch boundary (NEW)** — the seam to `api.openalex.org`. Resolves a single confirmed OpenAlex author ID into the `researchers`, `publications`, and `papers` shapes the pipeline expects, applying the five transforms (ID normalization, abstract reconstruction, dedup cascade, polite pool, degrade-to-empty). Emits the same shapes v3.1 loaded from disk; downstream is shape-identical and source-blind.
1. **Data layer** — **no longer input fixtures on disk.** The three data sources (`researchers`, `publications`, `papers`) are now **boundary output**, not files. `research_components` and `research_subfield_preferences` remain **Stage-1 grounding output** (unchanged). **`feed_items` is no longer ingested at all — it is the output of the council scoring stage** (R-3.2-6). **`publications` (grounding corpus) and `papers` (candidate set) are still never conflated** — different roles, different origins (own-works pull vs subfield pull), different join semantics. Schema-validated at the boundary against the same v3.1 field contracts, then frozen for the run.
2. **Compute layer** — **unchanged from v3.1.** Stage 1 grounding (extraction + three-layer integrity model) earns each researcher's validated profile from `publications`; Stage 2 council decides relevance per (researcher, paper) pair over the grounded profile; the per-researcher `feed_summary` runs post-decision. Instrumented end-to-end with Weave + W&B.
3. **Presentation layer** — the reused v2 two-panel editorial UI, with **one-step author-link onboarding (NEW)**, a researcher selector, and the grounding degraded-state — **plus a new "OpenAlex unavailable / zero candidates" degraded surface.**

The crucial design principles:
- **v3 (unchanged):** the council decides relevance; ranking is a pure presentation-order function of `relevance_score`.
- **v3.1 (unchanged):** the profile is validated, not trusted; the three ordered integrity layers; `source_paper_ids` carry genuine lineage into the `publications` corpus.
- **v3.2 (new):** **the data is live, not authored — but the pipeline cannot tell.** The boundary's job is to make a network response indistinguishable from the v3.1 fixture. Onboarding collapses to a single confirmed author identity (R-3.2-1) that sources everything downstream. Every linked user is treated as a **Publisher**; the Follower / free-text / LLM-subfield-inference path is **out of scope.**

**Stage ordering is architectural, not incidental — and now extends to the fetch.** The fetch boundary is **unreachable-past until the author link is confirmed** (no identity, no pull). Grounding remains **unreachable-past until complete and validated**; the council remains unreachable until grounding produced a validated profile; `feed_summary` remains unreachable before that researcher's council completes. Per researcher: confirm author link → fetch + transform → (Stage 1) grounding → (Stage 2) council → feed sort → `feed_summary`. Enforced in code, not convention.

---

## 1a. The integrity model (unchanged from v3.1) — three ordered layers

**Unchanged.** Grounding output is **validated, not trusted.** Three layers run in a fixed, non-negotiable order:

> **sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.**

- **Sanitizer (deterministic):** strip markdown fences, control characters, trailing commas; attempt `JSON.parse`.
- **Layer 1 — Structural validity + repair loop:** structural predicate; on failure, repair by re-prompting — **capped at 4 attempts**, linear backoff (**3s, 6s, 9s, 12s**), sanitize after each. Still invalid after 4 → **degraded state**, no partial profile written.
- **Layer 2 — Referential integrity gate (deterministic, non-negotiable):** every `source_paper_id` must resolve to a real paper in that researcher's `publications` corpus. **Hard-reject** any component/subfield citing a non-resolving id; **never** repaired by re-prompting.
- **Layer 3 — Evidence-aptness flags (advisory):** weak-or-fabricated *semantic* lineage surfaced as advisory flags, never auto-rejected. **Informs**; Layers 1 and 2 **decide**.

**v3.2 note — Layer 2 and the live corpus.** Layer 2 still resolves `source_paper_ids` into the researcher's `publications` set — but that set is now the **live own-works pull**, post-transform. Because the boundary normalizes all IDs to bare form *before* grounding sees them, the referential gate operates on exactly the id-space it always did. **The transform must complete before grounding runs**, or Layer 2 would compare a bare grounding id against a prefixed corpus id and spuriously hard-reject. This ordering is a boundary-correctness requirement (Phase F exit).

---

## 2. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Single-page web app, local | Hackathon laptop target; no server infra needed |
| Language | TypeScript | Type-safe enforcement of the boundary-output shapes, grounding output shape, and council output shape |
| **Data source (NEW)** | **Live `api.openalex.org` REST** — `/authors`, `/authors/{id}`, `/works` | Replaces the four local fixtures; the polite pool is the access contract |
| **Polite pool (NEW)** | **`mailto=<monitored-email>` + self-identifying `User-Agent` on every request; optional `OPENALEX_API_KEY`** | Required on every call; the API key raises limits but is **never required** at prototype scale |
| **Candidate date-window (NEW)** | **`from_publication_date:{d}` = a fixed recency window (most-recent N days before run-time), derived deterministically from run-time, not user input** | Controls the candidate-pool size for the R-3.2-5 subfield pull; a fetch-boundary parameter, not a grounding/council logic change |
| LLM calls | Anthropic Message Batches API (council); single calls (grounding extraction Call 1, grounding validation Call 2, feed_summary) | **Unchanged** — the LLM call topology is untouched by v3.2 |
| Application model | `claude-sonnet-4-6` (pinned snapshot) | **Unchanged** — governs runtime calls only, not the build session |
| Schema validation | Ajv (JSON Schema) | Validates **boundary output** against the v3.1 field contracts (`researchers`, `publications`, `papers`) **and** the Stage-1 grounding-output shape; the malformed-entry reject test now fires on transformed network data |
| Observability — per-call | Weave (`weave.init`; `@weave.op()` on the **fetch boundary + each transform**, grounding orchestration + every integrity-layer assertion, council orchestration, every eval assertion) | **Extended:** the fetch boundary and its transforms join the trace tree; a degraded OpenAlex call must be **visible, not silent** |
| Observability — per-run | Weights & Biases (one run per author-link/prompt iteration) | **Extended** with **fetch metrics (new): authors-search hit count, works pulled per author, candidate papers pulled per subfield, dedup collapses, abstract-null count, per-endpoint error/degrade count)** alongside v3.1 grounding + v3 council metrics |
| Secrets | `WANDB_API_KEY` (required) + **`OPENALEX_API_KEY` (optional)** from gitignored `.env`, mounted into Docker (not baked) | `WANDB_API_KEY` required as before; `OPENALEX_API_KEY` is optional and the build **must run without it** |
| Sandbox | Docker container; **dashboard (OUTPUT) wired in; `.env` mounted; outbound network to `api.openalex.org` permitted** | Required: build the container first. **v3.2 change: the container needs egress to OpenAlex; INPUT is no longer mounted fixtures but live pulls** |
| Styling | Hand-authored CSS, no heavy framework | Editorial visual treatment is bespoke |

**Out of scope (must not be built):** Follower / free-text / LLM-subfield-inference path (R-3.2-4 — **every linked user is a Publisher**); **pagination** (first page only, most-recent N); embedding/centroid/cosine changes (V3.2 swaps inputs only); unifying the API key across all calls (polite pool suffices); **and — carried from v3.1 — any change to grounding, council, or eval logic.** These are explicitly frozen for v3.2.

---

## 2a. Decision model (unchanged from v3 / v3.1)

The decision model stands in full. The council decides admission, not a threshold; `relevance_decision: false` items render at their score position, never dropped; `relevance_score` is the only ordering signal; `council_confidence` is a distinct axis; subfield match is an explicit council factor. **No numeric cutoffs are strategy-originated.** The components and subfields the council weighs are the grounded, validated ones from Stage 1, carrying real lineage into the (now live-pulled) `publications` corpus.

**v3.2 note:** `matched_components` still reference grounded components with real `source_paper_ids` into `publications` — those publications are now live works, normalized to bare IDs at the boundary. The lineage is no less genuine; it now points at the author's *actual* OpenAlex works.

---

## 3. Build Phases

### Phase 0 — Docker sandbox, scaffold, OpenAlex client & observability wiring
- **Build the Docker container first** (requirement): wire the dashboard (OUTPUT); mount `.env`, do not bake it; **permit outbound network egress to `api.openalex.org`.** INPUT is **no longer mounted fixtures** — it is the live OpenAlex client.
- Project skeleton, TypeScript config.
- **Build the OpenAlex client with the polite pool baked in:** `mailto=<monitored-email>` + self-identifying `User-Agent` on **every** request; read optional `OPENALEX_API_KEY` from `.env` and attach when present; **confirm the client runs without it.**
- **Ajv schemas for the boundary-output field contracts** (`researchers`, `publications`, `papers` — the same v3.1 shapes) **and** the Stage-1 grounding-output shape. The schemas now validate *transformed network data*, not files.
- **`.env` setup:** `WANDB_API_KEY` (required) and `OPENALEX_API_KEY` (optional) read from gitignored `.env`; confirm `.env` is in `.gitignore` before any commit.
- **`weave.init("<team>/atomic-research")`** once at startup; confirm the Anthropic SDK is auto-instrumented; **decorate the OpenAlex client and each transform with `@weave.op()`** so the fetch is in the trace tree from the start.
- **Exit:** container builds with OpenAlex egress; the OpenAlex client issues a polite-pool request (with and without the optional API key) and parses a response; boundary-output Ajv schemas load; schema rejects a deliberately malformed transformed record; `weave.init` runs clean; the fetch is visible in the Weave trace tree; `.env` confirmed gitignored, neither key in source.

### Phase F — The fetch boundary + the five transforms (NEW, the heart of v3.2)
Implement the seam to `api.openalex.org`. The contract: **consume OpenAlex JSON, emit the v3.1 fixture shapes, never throw upward.** Every transform decorated `@weave.op()`.

- **R-3.2-1 — One-step author-link onboarding:** `GET /authors?search=<name>` returns relevance-ranked matches; surface, per match, name, current affiliation, and `{works_count} papers · {cited_by_count} citations` for disambiguation; the user confirms "is this you?"; **persist the single confirmed OpenAlex author ID.** That one confirmed identity sources everything downstream — it is the sole human decision in the flow. **The fetch is unreachable-past until the link is confirmed.**
- **R-3.2-2 — `researchers` record from author profile:** on link, `GET /authors/{id}` with `select=id,display_name,works_count,cited_by_count,summary_stats,topics`; build the researcher record — name, h-index (`summary_stats.h_index`), citation count, works count, topics. Emits the same `researchers` shape v3.1 loaded.
- **R-3.2-3 — `publications` from the author's own works:** `GET /works?filter=author.id:{id}&sort=publication_date:desc&per_page=50` → the `publications` set, the **only** input to Stage 1 grounding. First page only (no pagination — scope cut).
- **R-3.2-4 — Subfields from publications only, no user-inputted text:** derive research components and subfield preferences **purely** from the publication record and its OpenAlex subfield tags (`primary_topic.subfield`). **No free-text description, no LLM-over-description inference.** Every linked user is a **Publisher** (Follower path out of scope). **Assumption flagged (R-3.2-4):** if subfield-tag coverage on the author's own works is thin, **fall back to the author-profile `topics`** — wire this fallback explicitly.
- **R-3.2-5 — `papers` from the recurring subfield pull:** for each derived subfield, `GET /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}&sort=publication_date:desc&per_page=50`, **one call per subfield.** This candidate pool feeds the council. First page only.
  - **`{d}` — the date floor (defined here, not left to downstream choice):** `{d}` is a **fixed recency window computed deterministically from run-time** — i.e. `{d} = today − N days` for a fixed N (the most-recent-N-days candidate window). It is **not** user input and **not** a per-researcher value; it is a single boundary-level constant applied identically to every subfield call. This is a fetch-boundary parameter that controls candidate-pool size only — it touches **no grounding, council, or eval logic.** Downstream must use this derivation rather than picking a date arbitrarily.
- **R-3.2-6 — `feed_items` is output, not input:** **no feed-items fetch exists.** Feed items become the output of the council scoring stage. Any code path reading feed items from disk is **removed.**
- **The five transforms (R-3.2-7), at the boundary and nowhere else:**
  - **ID normalization** — strip `https://openalex.org/` from every ID (works, authors, topics, subfields, **and every `referenced_works` entry**); strip `https://doi.org/` from DOIs; normalize arXiv IDs. **Must complete before grounding runs** so Layer 2 compares bare-against-bare (see §1a v3.2 note).
  - **Abstract reconstruction** — rebuild plain text from `abstract_inverted_index`; `null` when absent.
  - **Deduplication cascade** — collapse the same paper by `arxiv_id → doi → openalex_id → new record` (fixed precedence).
  - **Polite pool** — already wired in Phase 0; assert it fires on every endpoint here.
  - **Degrade-to-empty** — every call returns `[]` / `null` / skips the item on error and never throws upward; total OpenAlex failure yields zero new feed items, not a crash.
- **Exit:** from a confirmed author ID, the boundary emits valid `researchers`, `publications`, and `papers` shapes that pass the Phase 0 Ajv schemas; the subfield pull uses the fixed run-time-derived `{d}` recency window (not an arbitrary date); all IDs are bare (no `openalex.org`/`doi.org` prefixes, including `referenced_works`); abstracts reconstructed or `null`; dedup cascade collapses a planted duplicate by the correct precedence; polite-pool headers present on every request; **a simulated per-endpoint failure degrades to `[]`/`null`/skip without throwing**; thin-subfield-coverage falls back to author `topics`; no feed-items read path exists; every transform visible in the Weave trace tree.

### Phase G — Stage 1: LLM grounding + integrity model (UNCHANGED from v3.1)
**No logic changes.** Per researcher, grounding turns the (now live-pulled, transformed) `publications` set into a validated authoritative profile via Call 1 extraction (one-shot) → Call 2 aptness validation (advisory) → the three-layer integrity model. Unreachable-past until complete and validated; the council cannot run on an ungrounded/unvalidated profile.

- **The only v3.2 touchpoint:** grounding now reads `publications` from the **fetch boundary output**, not from disk — and depends on ID normalization having already run (Layer 2 resolves bare grounding ids against bare corpus ids). No grounding, extraction, repair-loop, or integrity-layer behavior changes.
- Call 1 extraction, Call 2 aptness validation, sanitize → Layer 1 (4-attempt repair, 3/6/9/12s backoff) → Layer 2 (deterministic referential hard-reject into `publications`) → Layer 3 (advisory flags) → authoritative profile assembled from what passed — **all exactly as v3.1.**
- **Exit (unchanged):** per researcher, either a non-empty validated profile (every component carries name, description, non-empty resolving `source_paper_ids`, explanation) or the documented "profile grounding unavailable — retry" degraded state with no partial profile written; ≤4 repair attempts; rejections and flags logged via Weave/W&B; both grounding calls and `@weave.op()` integrity assertions visible in the trace tree. **Plus:** confirm grounding consumes boundary output and Layer 2 resolves against the bare-id corpus.

### Phase 1 — Cross-file join & display ordering (UNCHANGED logic; joins now over boundary output)
- The explicit, mechanical id-join is **unchanged** — but now operates over **bare, normalized IDs from the boundary**. `feed_items` (council output) join against `researchers` and `papers`; grounded `research_components` / `research_subfield_preferences` resolve against `researchers`; their `source_paper_ids` resolve into `publications`.
- **`paper_id` independent of `researcher_id`** (unchanged); join by explicit id only.
- **`source_paper_ids` resolve into `publications` (own-works pull), never the candidate `papers` (subfield pull)** — the two id-spaces remain distinct in role even though both now originate from `/works`.
- **Display ordering unchanged:** per researcher, sort by `relevance_score` desc, tie-break `council_confidence` desc then `publication_date` recency. Pure presentation sort; no relevance decision.
- **No admission filter** — `relevance_decision: false` items retained at score position.
- **Exit:** joins resolve orphan-free over boundary output (all bare IDs); display order stable and reproducible; reject-decision items present; grounded `source_paper_ids` resolve into the live `publications` set. Unit tests lock the sort, no-drop, and referential resolution.

### Phase 2A — Stage 2: LLM council deliberation (UNCHANGED from v3.1)
**No logic changes.** Council unreachable until grounding produced a validated profile. Per researcher, deliberates over the full candidate-paper set (now the subfield pull) first; batch-call for per-pair decision.
- Council-call context (unchanged): researcher profile, grounded validated components with real `source_paper_ids` provenance into `publications`, grounded subfields, candidate paper **abstract** (now reconstructed from `abstract_inverted_index`, possibly `null`) and metadata. **Never title-only; subfield match an explicit factor.** A `null` abstract is handled by the existing council reasoning, not a crash.
- Council output per pair (unchanged): `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, `council_deliberation`; `matched_components` reference grounded validated components.
- Substantive-vs-superficial discipline preserved.
- **Exit (unchanged):** every (researcher, paper) pair carries all five council fields; `matched_components` reference grounded components; substantive-vs-superficial reasoning present for ambiguous cases; council calls + `@weave.op()` orchestration in the trace tree. **Plus:** confirm the council operates correctly on live candidate papers, including ones with `null` abstracts.

### Phase 2B — Feed summary (UNCHANGED from v3.1)
**No logic changes.** Runs after the council decides that researcher's full set and after the feed is sorted; post-decision editorial call naming the 2–3 strongest papers; covered by the degraded-state contract; auto-traced by Weave; unreachable before the council finishes that researcher's set.
- **Exit (unchanged):** `feed_summary` generated per researcher from the decided, sorted feed; call ordering verified; visible in the trace tree.

### Phase 3 — Two-panel UI (reuse v2 dashboard; add author-link onboarding + OpenAlex degraded state)
- Reuse the existing v2 two-panel dashboard, **unchanged in structure** (left feed panel, right detail panel, independent scroll, collapsible sections retaining label height).
- **NEW — one-step author-link onboarding (R-3.2-1):** a search box (`GET /authors?search=`) showing relevance-ranked matches with name, current affiliation, and `{works_count} papers · {cited_by_count} citations`; an "is this you?" confirm; persist the linked author ID. **This is the sole onboarding input and the sole human decision.** No free-text description field (R-3.2-4).
- **Researcher selector** retained.
- **Feed summary at top of the left panel**, own region, own degraded state (unchanged).
- Left panel feed in `relevance_score` order; right detail panel shows `relevance_reason`, `relevance_decision`, `council_confidence`, inspectable `council_deliberation`, grounded matched component(s), matched subfield(s).
- **Researcher profile view** surfaces grounded subfields/components traceable to `source_paper_ids` in the (live) `publications` set.
- **Grounding degraded state** ("profile grounding unavailable — retry") unchanged.
- **NEW — OpenAlex degraded surface:** total OpenAlex failure / zero candidate papers renders a **"no new papers available — retry"** state (the UI face of degrade-to-empty); no blank panel, no crash.
- **Items decided against not dropped** — render at score position with reject reasoning.
- Editorial visual treatment (dark background, bright legible type, serif paper titles) retained as a required deliverable.
- **Exit:** author-link onboarding flows search → disambiguate → confirm → persisted ID; default state (first researcher + top item) on load; sections collapsed to label; full layout per spec; a `relevance_decision: false` item renders at its score position with reject reasoning; deliberation inspectable; grounding degraded-state and **OpenAlex/zero-candidate degraded-state** both render correctly under simulation.

### Phase 4 — Degraded-state hardening (extends v3.1 with the fetch boundary)
Implement the failure contract: no blank panels, no silently dropped feed items, **no crash on OpenAlex failure.**
- **OpenAlex / fetch-boundary failure (NEW):** every OpenAlex call degrades to `[]` / `null` / skip and **never throws upward.** Total OpenAlex failure yields **zero new feed items, not a crash** — the UI shows "no new papers available — retry." A degraded call is **logged via Weave/W&B**, never silent. An absent abstract is `null`, handled downstream, not an error.
- **Author-search / link failure (NEW):** a failed `/authors?search=` or `/authors/{id}` degrades to an empty result set with a retryable onboarding state; no identity is persisted on failure.
- **Grounding failure (unchanged):** still-invalid after 4 attempts or referential-wipeout → "profile grounding unavailable — retry"; council does not run for that researcher; no partial profile written; others unaffected.
- **Council-decision failure (unchanged):** feed item renders at a conservative position with "decision unavailable — retry."
- **`feed_summary` failure (unchanged):** per-item feed still renders in full; summary region shows "summary unavailable — retry."
- Malformed/partial JSON from any model call **or any OpenAlex response** is caught, logged via Weave/W&B, surfaced as retryable.
- **Exit:** simulated failures — **OpenAlex per-endpoint degrade, total-OpenAlex-failure (zero feed items, no crash), author-search/link failure**, grounding (post-4-attempts and referential-wipeout), council decision, and feed_summary, each independently — render the correct retryable state at the right place without blanking, dropping, or crashing; every degrade logged, none silent; no partial profile written on grounding failure.

### Phase 5 — Run logging & eval pass
- **W&B run:** one `wandb` run per author-link/prompt iteration logs the aggregate — v3 council metrics + v3.1 grounding metrics **plus fetch metrics (new): authors-search hit count, works pulled per author, candidate papers pulled per subfield, dedup collapses, abstract-null count, per-endpoint error/degrade count.**
- **Eval gates (each a `@weave.op()`); aggregate all errors; on any failure, OUTPUT is not written.** **The grounding, council, and ordering eval gates are UNCHANGED from v3.1 — their pass/fail predicates are byte-for-byte the same.** New/relocated gates target the fetch boundary:
  - **Boundary-output validity (relocated):** every emitted `researchers`, `publications`, `papers` record validates against its v3.1 field contract (Ajv) — now over transformed network data, not files.
  - **ID normalization (new):** no emitted ID retains an `https://openalex.org/` or `https://doi.org/` prefix — including every `referenced_works` entry; arXiv IDs normalized.
  - **Referential integrity (Layer 2 as eval gate, unchanged logic):** every `source_paper_id` in every generated component/subfield resolves to a real paper in that researcher's (live) `publications` set — **zero orphans.** Confirms bare-against-bare resolution post-transform.
  - **Dedup cascade (new):** no two emitted papers share an `arxiv_id`, `doi`, or `openalex_id`; precedence honored.
  - **Polite pool (new):** every OpenAlex request carried `mailto` + `User-Agent`; the run completed without `OPENALEX_API_KEY` present.
  - **Degrade-to-empty (new):** under simulated total OpenAlex failure, the pipeline yields zero feed items and does not throw.
  - **No feed-items read path (new):** assert no code reads feed items from disk; feed items exist only as council output.
  - **Grounding gates (unchanged):** non-empty validated profile per researcher (or degraded state); every component carries name/description/non-empty resolving `source_paper_ids`/explanation; repair loop terminates ≤4 attempts.
  - **Council + ordering gates (unchanged):** every feed_item carries all council fields; display order matches `relevance_score`-desc sort; reject items not dropped; `feed_summary` present (or degraded).
- **Note on the dropped coverage-spread *assertion* (not a gate change):** in v3.1 the eval also asserted a hand-authored must-surface / must-dismiss / ambiguous **coverage spread** — but that spread was a property of the **synthetic fixtures**, not of any pipeline logic. With the fixtures gone, that fixture-property assertion is simply no longer applicable and is dropped. **This is not a relaxation of any eval gate:** every grounding, council, and ordering gate keeps its exact v3.1 pass/fail predicate, applied now to the live candidate set (validate, dedup, decide, order, degrade). **Do not** reintroduce synthetic coverage planting to manufacture a spread over live data — that would contradict the live-data swap.
- **Exit:** one clean W&B run with council + grounding + **fetch** aggregate metrics + eval results; Weave trace tree (fetch + transforms + grounding + council + summary) and the W&B run cross-reference the same iteration; OUTPUT written only on full eval pass.

---

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **A change leaks past the fetch boundary into grounding/council/eval logic** (the single v3.2 invariant violated) | §0a + the v3.2 invariant: all new logic lives at the boundary; Phases G/2A/2B explicitly UNCHANGED; review/eval reject any pipeline-logic change |
| **An OpenAlex call throws upward and crashes the pipeline** | Degrade-to-empty: every call returns `[]`/`null`/skip, never throws; total failure → zero feed items, not a crash; eval gate + Phase 4 simulation |
| **ID normalization missed somewhere → Layer 2 spuriously hard-rejects** (prefixed vs bare mismatch) | Transform completes before grounding; eval gate asserts no prefix survives anywhere (incl. `referenced_works`); §1a v3.2 note; Phase F exit |
| **`referenced_works` entries left prefixed** (easy to forget in the array) | ID normalization explicitly covers every `referenced_works` entry; eval gate checks the array |
| **Subfield pull `{d}` date-floor picked arbitrarily downstream → unpredictable candidate-pool size** | `{d}` defined in Phase F (R-3.2-5) as a fixed run-time-derived recency window (`today − N days`), a boundary constant applied to every subfield call; Phase F exit asserts the fixed window is used, not an arbitrary date |
| **Duplicate papers double-counted** | Dedup cascade `arxiv_id → doi → openalex_id → new record`; eval asserts no shared id across emitted papers; planted-duplicate test in Phase F |
| **Polite pool omitted on some endpoint → rate-limited/blocked** | `mailto` + `User-Agent` baked into the client (Phase 0), fires on every request; eval gate asserts presence on every call |
| **Build assumes `OPENALEX_API_KEY` is present** | Optional only; build must run without it; Phase 0 + eval confirm a keyless run completes |
| **Thin subfield-tag coverage on author works → empty subfields → empty candidate pull** | Flagged assumption (R-3.2-4): fall back to author-profile `topics`; wired explicitly in Phase F |
| **Free-text description or LLM-subfield-inference reintroduced** | R-3.2-4 forbids it; every user is a Publisher; no description field in the UI; review rejects any LLM-over-description path |
| **Follower (no-publications) path built** | Explicitly out of scope for V3.2; every linked user treated as Publisher |
| **Pagination introduced** | Out of scope: first page only (most-recent N); no `cursor`/page loop |
| **Feed items read from disk somewhere** | R-3.2-6: feed items are council output only; eval asserts no feed-items read path exists |
| **Absent abstract crashes the council** | Abstract reconstruction yields `null` when absent; council handles `null` via existing reasoning; never title-only assumption holds |
| **A degraded OpenAlex call fails silently** | Degrade-to-empty is logged via Weave/W&B; per-endpoint error/degrade count in the W&B run; never silent |
| **Author disambiguation links the wrong identity** | UI surfaces affiliation + `{works_count} papers · {cited_by_count} citations` + "is this you?" confirm; the single confirmed ID sources everything, so the confirm step is load-bearing |
| **Synthetic coverage-role planting reintroduced over live data** | Live pull replaces synthetic fixtures; the v3.1 coverage-spread *assertion* (a fixture property) is dropped while every grounding/council/ordering gate keeps its exact predicate; eval asserts correct *handling* of the live set, not a planted spread |
| Council runs on an ungrounded/unvalidated profile | Unchanged v3.1 mitigation: unreachable-past until validated; enforced in code |
| Layer 3 treated as a hard gate / Layer 1 repairs a referential failure | Unchanged v3.1 mitigations: only Layers 1 & 2 decide; Layer 2 hard-rejects, never repaired |
| Downstream reintroduces a deterministic LLM-free relevance sequencer | Forbidden; council decides; ordering is a mechanical sort only |
| `publications` (own-works pull) and candidate `papers` (subfield pull) conflated | Distinct roles, distinct origins, distinct join semantics; `source_paper_ids` resolve into `publications` only; asserted (Phase 1) |
| Reject-decision item silently dropped | No-silent-drop; render at score position; eval asserts presence |
| Observability bolted on late | Weave wired Phase 0; `@weave.op()` on fetch + transforms + grounding + integrity + council + evals; W&B fetch + grounding + council metrics Phase 5 |
| `WANDB_API_KEY` hardcoded/committed; `.env` baked into image | `.env` gitignored, confirmed Phase 0; both keys mounted not baked |
| Container lacks OpenAlex egress | Phase 0 wires outbound network to `api.openalex.org`; client smoke-tested |
| Scope creep into production pipeline / embeddings / centroid | Explicit out-of-scope list; V3.2 swaps inputs only |

---

## 5. Definition of Done

- **The pipeline reads the network, not files:** from a single confirmed OpenAlex author ID, the fetch boundary emits `researchers`, `publications`, and `papers` in the exact v3.1 shapes, and the grounding → council → summary pipeline runs over them **with no logic change.** A network response is indistinguishable downstream from a v3.1 fixture.
- **One-step onboarding works:** `GET /authors?search=` → relevance-ranked matches with name, affiliation, `{works_count} papers · {cited_by_count} citations` → "is this you?" confirm → persisted linked author ID. That single confirmed identity sources everything downstream; it is the sole human decision. Every linked user is a Publisher; no free-text, no LLM-subfield-inference, no Follower path.
- **The candidate date-window is deterministic, not arbitrary:** the R-3.2-5 subfield pull uses `from_publication_date:{d}` where `{d} = today − N days` for a fixed N — a single boundary-level recency constant derived from run-time, applied identically to every subfield call, picked nowhere downstream.
- **The five fetch-boundary transforms hold:** (1) every ID is bare — no `openalex.org`/`doi.org` prefix anywhere, including every `referenced_works` entry, arXiv IDs normalized; (2) abstracts reconstructed from `abstract_inverted_index` or `null`; (3) duplicates collapsed by `arxiv_id → doi → openalex_id → new record`; (4) `mailto` + `User-Agent` on every request, `OPENALEX_API_KEY` optional and the run completes without it; (5) every OpenAlex call degrades to `[]`/`null`/skip and never throws — total OpenAlex failure yields zero feed items, not a crash.
- **The transforms are the only new logic.** Grounding (Stage 1 + three-layer integrity model), council (Advocate / Skeptic / Judge), and eval logic are **byte-for-byte unchanged in behavior;** the only touchpoint is that grounding/council now consume boundary output, and ID normalization runs before grounding so Layer 2 resolves bare-against-bare.
- **Grounding still earns each profile (unchanged):** per researcher, the live `publications` set → Call 1 extraction → integrity model (sanitize → Layer 1 → Layer 2 → Layer 3) → a validated profile, or the documented degraded state with no partial profile written; every component carries name, description, non-empty resolving `source_paper_ids`, explanation; repair loop terminates ≤4 attempts (3/6/9/12s backoff).
- **Referential integrity holds over live data:** every `source_paper_id` resolves to a real paper in that researcher's live `publications` set — zero orphans — at runtime (Layer 2) and as an eval gate; resolution is bare-against-bare post-transform.
- **The council still decides relevance (unchanged):** unreachable until grounding produced a validated profile; decides every (researcher, paper) pair over the grounded profile; each decision carries `relevance_decision`, `relevance_score`, `council_confidence`, `relevance_reason`, full `council_deliberation`; `matched_components` reference grounded validated components with real lineage; never title-only; subfield match an explicit factor; `null` abstracts handled, not crashed.
- **Feed items are output, not input:** no feed-items read path exists; feed items are produced by the council scoring stage only.
- Display order is `relevance_score` descending (tie-break confidence, then recency), reproducible and unit-tested; reject-decision items render at their score position, not dropped.
- `feed_summary` generated per researcher from the decided, sorted feed after the council completes that researcher's set; renders at top of the left panel; degrades independently.
- **Two-panel editorial UI** matches the output-surface spec with the new author-link onboarding and the new "no new papers available — retry" OpenAlex degraded surface; researcher selector; default state (first researcher + top item); independent scroll; collapsible sections; detail panel shows reason, decision, confidence, inspectable deliberation, grounded matched component(s), matched subfield(s); profile surfaces grounded subfields/components traceable to the live `publications` set; v2 editorial dark theme with serif titles retained.
- **Degraded-state contract holds under simulated failure** for OpenAlex per-endpoint degrade, total-OpenAlex-failure (zero feed items, no crash), author-search/link failure, grounding (post-4-attempts and referential-wipeout), council decision, and `feed_summary`, each independently; no partial profile written on grounding failure; every degrade logged via Weave/W&B, none silent; malformed JSON from any model call or OpenAlex response caught, logged, surfaced as retryable.
- **The eval gates are byte-for-byte unchanged in predicate:** the grounding, council, and ordering gates keep their exact v3.1 pass/fail logic; only the v3.1 synthetic-fixture **coverage-spread assertion** is dropped (it was a fixture property, not pipeline logic), with **no** synthetic coverage planting reintroduced over the live set.
- **Observability complete and load-bearing:** Weave traces the fetch boundary + each transform, every Anthropic call (both grounding calls, council, summary), and every `@weave.op()` orchestration/integrity/eval function; one W&B run logs fetch metrics (authors-search hits, works per author, candidates per subfield, dedup collapses, abstract-null count, per-endpoint error/degrade count) plus grounding and council metrics; both keys share the single gitignored `.env` mounted into Docker.
- Runs inside the Docker sandbox with outbound egress to `api.openalex.org`; dashboard (OUTPUT) wired in; `.env` mounted not baked.
- Eval gates aggregate all errors; OUTPUT is written only on a full pass.
- No Follower/free-text/LLM-subfield-inference path; no pagination; no embedding/centroid/cosine changes; no API-key unification; no change to grounding, council, or eval logic; no local fixture reads.

---

## 6. Explicit Non-Goals

- **No change to grounding, council, or eval logic** — V3.2 is exclusively the relocation of the data source from local JSON to the OpenAlex network boundary. This is the single load-bearing invariant.
- **No logic outside the fetch boundary** — the five transforms (ID normalization, abstract reconstruction, dedup cascade, polite pool, degrade-to-empty) plus the deterministic `{d}` recency-window derivation are the only new behavior; anything reaching past the boundary to alter the pipeline is a boundary leak.
- **No local fixture reads** — `researchers`, `publications`, and `papers` come from the network; `feed_items` is council output, never read from disk.
- **No Follower / free-text / LLM-subfield-inference path** — every linked user is a Publisher; subfields derive purely from the publication record and its OpenAlex subfield tags (with fallback to author `topics`).
- **No free-text description field** — the sole onboarding input is the confirmed author link.
- **No pagination** — first page only, most-recent N per call.
- **No arbitrary candidate date-floor** — `{d}` is a fixed run-time-derived recency window (`today − N days`), not a value chosen ad hoc downstream or supplied by the user.
- **No requiring `OPENALEX_API_KEY`** — optional, raises rate limits; the polite pool (`mailto` + `User-Agent`) is the required access contract and is sufficient at prototype scale.
- **No unifying the API key across all calls** — the polite pool suffices.
- **No prefixed IDs anywhere downstream** — every ID normalized to bare form at the boundary, including `referenced_works` and DOIs.
- **No crash on OpenAlex failure** — degrade-to-empty; total failure yields zero feed items.
- **No synthetic coverage-role planting over live data** — the live pull replaces the authored fixtures; the v3.1 coverage-spread assertion is dropped as a fixture property while every eval gate keeps its exact predicate; eval asserts correct handling, not a planted spread.
- **No embedding / centroid / cosine pre-filter changes** — V3.2 swaps inputs only.
