# STRATEGY.md

## Atomic Research — Paper Relevance Feed: Build Strategy

This document translates REQUIREMENTS.md into an execution plan. It is binding on downstream implementation. Where requirements decided something at requirements-time (model ID, visual treatment, degraded-state contract), strategy executes it — it does not relitigate it.

---

## 1. Architecture Overview

A single-page desktop application, run locally, with a clean separation between three layers:

1. **Data layer** — the embedded fixtures (one researcher profile, 10 candidate papers). Loaded once, validated against schema, frozen. No network fetch.
2. **Compute layer** — deterministic scoring/sequencing (pure functions, no LLM) plus LLM-driven rationale generation (the only LLM surface).
3. **Presentation layer** — the two-panel editorial UI.

The crucial design principle: **the ranking is deterministic and LLM-free; the explanations are LLM-driven**. Scores are mocked fixtures, ordering is a pure function of those scores. The LLM never decides rank — it only explains a rank already computed. This keeps the feed reproducible and the "every position must be defensible by the rule" contract mechanically enforceable.

**Recommended action is also deterministic**, derived from the same frozen scores (see Phase 1). The LLM produces only the three rationale types — it never decides rank or recommended action.

---

## 2. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Single-page web app, local | Hackathon laptop target; no server infra needed |
| Language | TypeScript | Type-safe enforcement of the per-paper output contract |
| LLM calls | Anthropic Message Batches API | Requirements prefer batching: ~half token cost, latency-insensitive |
| Application model | `claude-sonnet-4-6` (pinned snapshot) | Requirements-level commitment; dateless pinned ID, bump deliberately |
| Schema validation | JSON Schema validator (e.g. Ajv) | Required dependency for per-paper output contract |
| Styling | Hand-authored CSS, no heavy framework | Editorial visual treatment is bespoke; frameworks fight the design |

**Out of scope (must not be built or stubbed with live calls):** OpenAlex/arXiv ingestion, `text-embedding-3-small` embedding, cosine-similarity computation, weekly centroid refresh. These are production-pipeline concerns explicitly frozen for this POC.

---

## 3. Build Phases

### Phase 0 — Scaffold & fixtures
- Project skeleton, TypeScript config, fixtures embedded as a typed module.
- JSON Schema for the per-paper output contract; wire the validator.
- **Exit:** fixtures load and validate; schema rejects a deliberately malformed entry.

### Phase 1 — Deterministic sequencer & recommended action (no LLM)
- **Relevance threshold:** a component is considered *cleared* when its `component_similarity ≥ 0.60`. This single numeric value governs both multi-component-match reporting and tie-break stage (1). It is a constant in the codebase, not a tunable.
- Implement `max(component_similarity)` ranking with the two-stage tie-break: (1) more components at or above the 0.60 threshold, (2) more recent date.
- **Recommended action mapping (deterministic, derived from `max(component_similarity)`):**
  - `Read now` — strongest component similarity ≥ 0.80.
  - `Save` — strongest component similarity ≥ 0.60 and < 0.80.
  - `Skip` — strongest component similarity < 0.60.
  - This mapping is a pure function of frozen scores, reproducible and testable exactly like the ranking. The LLM plays no part in it.
- **Exit:** all 10 papers ranked 1–10, order is stable and reproducible, each position justifiable by the rule; recommended action assigned to every paper by the mapping above; "components cleared above threshold" is deterministic. Unit tests lock both the order and the recommended-action assignment.

### Phase 2 — LLM rationale generation
- Batch-call the model for: per-component match explanation, relevance rationale, per-position rationale.
- The LLM produces *only* these three rationale types — rank and recommended action are already fixed by Phase 1 and are passed into the prompt as given, not chosen by the model.
- Enforce the tangential-near-miss honesty requirement in the prompt (PAP-07 must be flagged as loose).
- **Exit:** every paper has all three rationale types; tangential flag verified on PAP-07.

### Phase 3 — Two-panel UI
- Left feed panel, right detail panel, independent scroll, collapsible sections.
- Editorial visual treatment (dark, serif titles) — built here, not deferred.
- **Exit:** position 1 selected on load, all sections collapsed to label, full layout per spec.

### Phase 4 — Degraded-state hardening
- Implement the failure contract: rationale-unavailable state, malformed-JSON capture, no blank panels, no dropped papers.
- **Exit:** simulated LLM failures render the retryable state correctly at the right rank.

---

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM overstates a tangential match (PAP-07) | Explicit prompt instruction + a verification check in Phase 2 exit |
| Scores drift / ranking becomes non-reproducible | Ranking is a pure function over frozen fixtures; locked by unit tests |
| Recommended action becomes inconsistent / non-reproducible | Deterministic threshold-based mapping in Phase 1; locked by unit tests, never an LLM output |
| Threshold left implicit, tie-break untestable | Threshold fixed at 0.60 as a code constant in Phase 1; unit tests cover multi-component and tie-break cases |
| Visual treatment demoted to "stretch" under time pressure | Requirements forbid this; Phase 3 treats it as core exit criteria |
| Malformed model JSON crashes a panel | Degraded-state contract in Phase 4; caught, logged, surfaced as retryable |
| Scope creep into production pipeline | Explicit out-of-scope list; no live API calls permitted |

---

## 5. Definition of Done

- All 10 papers ranked into a single feed, position 1–10, each defensible by the scoring contract.
- Relevance threshold fixed at 0.60; "components cleared above threshold" is deterministic and unit-tested.
- Recommended action (`Read now / Save / Skip`) assigned to every paper by the deterministic threshold mapping, reproducible and unit-tested.
- Every paper renders: component match(es) + per-component similarity, relevance rationale, recommended action, missing-information note, per-position rationale.
- Tangential near-miss (PAP-07) is explicitly flagged as loose in its rationale.
- Two-panel editorial UI matches the output-surface spec, including default state and visual treatment.
- Degraded-state contract holds under simulated LLM failure.
- No production-pipeline code, no live OpenAlex/arXiv/OpenAI calls.

---

## 6. Explicit Non-Goals

- No validation against real researchers, papers, or third parties.
- No citation-graph, venue-quality, or duplicate-detection signals (out of rubric scope).
- No recency-based ranking (recency is a gate only).
- No live embedding or similarity computation (fixtures are canonical).
- No LLM-driven ranking or recommended-action selection (both are deterministic functions of frozen scores).
- No multi-user, no persistence beyond the session, no auth.