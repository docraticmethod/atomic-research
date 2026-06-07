# REQUIREMENTS.md
# REQUIREMENTS.md — v3.1 Delta

# Atomic Research — Paper Relevance Feed (v3.1)

## How to read this document

**This is a delta on top of v3, not a replacement.** Everything in the v3 REQUIREMENTS.md still holds — the council that *decides* relevance, the synthetic demo scale (3 researchers), the existing two-panel dashboard, the degraded-state contract, the Weave/W&B observability split, the Docker sandbox, the `.env` discipline. v3.1 adds **one new pipeline stage in front of the council** and the **integrity model that validates its output**. Where this delta and v3 conflict, the delta governs; everywhere else, v3 stands.

## Why v3.1 exists (the defect being fixed)

In v3, the researcher profile — the research components and subfield preferences the council reasons over — is **hand-authored synthetic data**. Topic labels, relevance scores, and interest strings are asserted, not derived from the researcher's actual body of work. This means `matched_components` in feed items reference an *asserted* lineage, not a genuine one, and every downstream council decision is built on an unearned profile.

**v3.1 fixes this by making the profile *earned*.** A new first stage ingests a researcher's publication corpus and uses an LLM to extract research components and subfield preferences **grounded in specific source papers**, with the evidence and reasoning recorded. The grounded, validated profile becomes the authoritative input the council consumes. The data remains synthetic (no live ingestion — that boundary from v3 is unchanged); what changes is that the components are no longer hand-asserted — they are LLM-derived from a corpus and validated against it. The hand-authoring moves back one step: from authoring the *conclusions* (components) to authoring the *raw material* (a synthetic publication corpus) the LLM reasons across.

## New input: the publication corpus

A new synthetic fixture, per researcher:

- **`publications.json`** — each researcher's own prior body of work: **~15–20 publication records per researcher** (×3 researchers ≈ 45–60 records), shaped like OpenAlex/Semantic Scholar data (title, abstract, ids, year, venue, topics). Synthetic, obviously-synthetic identifiers, no live fetch.

This corpus is the **raw material the grounding stage reads**. It is distinct from the candidate papers the council scores: *publications* are the researcher's past work (input to grounding); *candidate papers* are what the council evaluates for the feed. The two sets must not be conflated — different roles, different files.

## Fixture inversion: components become output, not input

In v3, `research_components.json` and `research_subfield_preferences.json` were hand-authored **input** fixtures. In v3.1 they become **pipeline output** — produced by the grounding stage, not authored by hand. Specifically:

- `research_components.json` and `research_subfield_preferences.json` are no longer canonical input. They are *generated* by Stage 1 (below), carry real `source_paper_ids` into `publications.json`, and are written only after passing the integrity model.
- The authoritative researcher profile that the council (v3) consumes is now the *validated output of grounding*, not a fixture.

## New Stage 1: LLM grounding (runs before the council)

Grounding is the new first stage of the pipeline. It runs per researcher, before any council deliberation, and is enforced in code to be **unreachable-past until complete and validated** — the council cannot run on an ungrounded or unvalidated profile.

### Call 1 — Extraction (one-shot prompt)

The researcher's full `publications` corpus is fed to the LLM as a **one-shot prompt** (a single worked example demonstrating the required structured output). The LLM reads across the whole corpus and emits structured output: the researcher's **research components** and **subfield preferences**, where each component/subfield carries:

- a name and description (the thread or subfield),
- `source_paper_ids` — the specific publications that evidence it,
- an **explanation** of why the LLM reached this conclusion from that evidence.

The extraction is self-documenting: it shows its work, so the validation layers and a human can audit the reasoning.

### Call 2 — Evidence-aptness validation (advisory)

A second LLM call audits Call 1's output: for each component/subfield, does the cited evidence (the real papers named in `source_paper_ids`) actually *support* the claim, or is the lineage weak or fabricated? It flags unsupported or weak claims.

**This layer is advisory, not authoritative.** It is an LLM validating an LLM — non-deterministic. It raises confidence that evidence is *apt*; it does not *guarantee* truth, and it must not be treated downstream as a hard guarantee. It catches semantic fabrication ("this paper is cited as evidence for X but is about Y"); it cannot be relied upon to catch a fabricated *identifier* (it may hallucinate agreement). That is what the deterministic gate below is for.

## The integrity model (three layers, ordered)

Grounding output is **validated, not trusted.** Three layers run in order; each catches what the others cannot.

### Layer 1 — Structural validity + repair loop (carried from the architect's existing pattern)

The output is first passed through a **deterministic sanitizer** (strip markdown fences, control characters, trailing commas; attempt `JSON.parse`). It is then checked against a structural predicate: parseable object, non-empty, every component carries a non-empty `source_paper_ids` array and the required fields.

If structurally invalid, the output is **repaired by re-prompting the LLM** with the failure, using the architect's established loop: **capped at 4 attempts**, linear backoff (3s, 6s, 9s, 12s), deterministic sanitize after each attempt. If still invalid after 4 attempts, the researcher's grounding terminates in a **degraded state** (see Degraded-state contract) — it does not write a partial profile.

### Layer 2 — Referential integrity gate (new, deterministic, non-negotiable)

Every `source_paper_id` in the extracted components and subfields **must resolve to a real paper in that researcher's `publications.json` corpus.** Any component or subfield citing a non-existent id is **hard-rejected** — this is deterministic and cannot be repaired away by re-prompting, because a re-prompt might "fix" a fabricated id by inventing a different fabricated id.

This is the layer that makes "genuine intellectual lineage" *true* rather than aspirational. Structural validity (Layer 1) would happily accept a well-formed component citing a hallucinated paper; Layer 2 is what catches it. **A grounding output is not accepted unless every cited source resolves.**

### Layer 3 — Evidence-aptness flags (Call 2 output, advisory)

The Call-2 validation results are attached as advisory flags. Weak-but-real evidence is surfaced for inspection, not auto-rejected. This layer informs; Layers 1 and 2 decide.

**Ordering:** sanitize → Layer 1 (structural validity + repair) → Layer 2 (referential hard-reject) → Layer 3 (aptness flags) → authoritative profile assembled from what passed.

## Pipeline ordering (v3.1, enforced in code)

1. **Stage 1 — Grounding:** per researcher, `publications.json` → Call 1 (extract) → integrity model (Layers 1–3) → validated `research_components` + `research_subfield_preferences` with real `source_paper_ids`.
2. **Authoritative profile** assembled per researcher from validated grounding output only.
3. **Stage 2 — Council** (unchanged from v3): consumes the *grounded* profile; deliberates and decides each candidate paper. `matched_components` now reference grounded, validated components — real lineage.
4. **feed_summary**, degraded-state, observability — as in v3.

The council must be **unreachable until grounding has produced a validated profile** for that researcher — same call-ordering discipline v3 applied to `feed_summary`, now applied to the grounding→council dependency.

## Degraded-state contract (extends v3)

The v3 contract holds, plus:

- If grounding fails for a researcher (still structurally invalid after 4 repair attempts, or no component survives the referential gate), that researcher renders in a **"profile grounding unavailable — retry"** state. The council does not run on that researcher with an unvalidated profile, and no partial profile is written. Other researchers are unaffected.
- Referential-gate rejections and aptness flags are **logged via the observability layer** (Weave/W&B), so a grounding failure is inspectable, not silent.

## Observability (extends v3)

The v3 Weave/W&B split holds, plus:

- **Both grounding LLM calls (extraction and validation) are Weave-traced**, alongside the existing council and feed_summary calls. Because grounding is now the trust foundation for everything downstream, its trace tree — the extraction reasoning, the repair attempts, the validation flags — is part of the audit trail.
- **W&B run aggregate adds grounding metrics:** per researcher, components extracted, components surviving the referential gate, repair attempts used, and aptness flags raised.
- Decorate the grounding orchestration and every new integrity-layer assertion with `@weave.op()`.

## Eval gates (extends v3)

The v3 eval gates hold, plus:

- **`publications.json` validates** against its field contract; ~15–20 records per researcher.
- **Referential integrity:** every `source_paper_id` in every generated component and subfield resolves to a real paper in that researcher's publications corpus — zero orphans (this is the deterministic enforcement of Layer 2; it is an eval gate, not only a runtime check).
- **Grounding produced a non-empty validated profile** for each researcher (or that researcher is in the documented degraded state).
- **Every generated component carries** name, description, non-empty `source_paper_ids`, and an extraction explanation.
- **Repair loop terminates:** no grounding run exceeds 4 repair attempts without resolving to either acceptance or the degraded state.

## Unchanged from v3 (for the avoidance of doubt)

The council decides relevance (not a deterministic sequencer); 3 researchers, 10 distinct candidate papers each; the existing two-panel dashboard with editorial dark theme and serif titles; `feed_items` carrying decision/confidence/reason/deliberation; `feed_summary` as a post-decision per-researcher call; Docker sandbox built first; `claude-sonnet-4-6` pinned; `.env` gitignored and mounted-not-baked; no live OpenAlex/arXiv ingestion; no real embeddings.