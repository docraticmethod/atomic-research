# REQUIREMENTS.md

# Atomic Research — Paper Relevance Feed

## Context

An academic researcher scanning recent literature, who needs a fast answer to one question: "why is this paper relevant to me, right now?" The dashboard takes a fixed set of candidate papers and ranks them into a single relevance feed for one researcher, and for each paper states **which of the researcher's Research Components it matches and why**. It runs on the researcher's own laptop as a hackathon prototype. It is **not** validated against any third party, processes no real researcher identity or non-public data, and makes no claim of citation-graph accuracy. All data is synthetic; embedding similarity is mocked.

## Inputs

A single synthetic researcher profile plus a fixed set of synthetic candidate papers, both embedded as fixtures in the Test data section below.

The researcher profile is represented as a set of **Research Components** — distinct thematic threads, each with an identifier and a short description. (In production these are extracted from publication history and embedded via OpenAI `text-embedding-3-small`, with a weekly-refreshed centroid across the 50 most recent papers; in this POC the embeddings are not computed — see Implementation.)

Each candidate paper carries structured fields (title, authors, venue, publication date, abstract) and, **mocked for this POC**, a per-component cosine-similarity score against each Research Component. In production these papers are sourced from OpenAlex (50 most recent per subfield, past 6 months) with an arXiv-category fallback for daily preprint scanning; here they are frozen fixtures.

**Temporal scope:** currentDate is 2026-06-06. The relevant window is the **6 months ending on currentDate** (2025-12-06 → 2026-06-06). Recency is a **gate, not a ranking signal**: every paper in the window is eligible; a paper's age within the window does not change its rank.

**Completeness expectations:** Real feeds are uneven — some papers match no component well, some match several, abstracts vary in informativeness. The fixtures must reflect this: at least one paper that is a near-miss (matched by the pre-filter but only tangentially relevant on inspection), and at least one that matches multiple components.

## Domain framework (relevance rubric)

The system reasons over the factor categories below. The categories are non-overlapping. **This POC is deliberately scoped to two signals** — embedding similarity and recency — so the negative and modulating tiers are intentionally thin rather than padded with factors the team chose not to build.

### Positive factors (signal of relevance)

- **Component similarity:** cosine similarity between the paper and a specific Research Component embedding. This is the **primary and sole ranking signal**. A paper's relevance is always expressed *relative to a named component* — never as a single context-free score.
- **Multi-component match:** a paper that clears the similarity threshold against more than one component is relevant across multiple of the researcher's threads (reported, but ranked on its strongest single-component score — see Sequencer).

### Negative factors (reduce relevance)

- **Tangential match:** a paper the mechanical pre-filter admitted on keyword/embedding overlap but whose actual content is only glancingly related to the matched component. The LLM rationale must flag this rather than overstate the fit. *(No other negative factors are in scope for this POC — no venue-quality, citation, or duplicate-detection signals.)*

### Modulating factors (cost/timing)

- **Recency gate:** publication date inside the 6-month window. Acts only as an eligibility gate; does not modulate rank order. *(No other modulating factors — preprint-vs-peer-reviewed, access, length — are in scope for this POC.)*

## Test data

**Fixture-scope philosophy:** Real-world variability. A synthetic feed should mirror the unevenness of an actual OpenAlex/arXiv pull — strong matches, multi-component matches, and tangential near-misses — because the value of the tool is in *explaining* relevance per component, and that explanation is only tested when the matches are uneven.

**Coverage requirements:**

- **Must-rank-high:** very high similarity to a single component; unambiguous strong match.
- **Multi-component match:** clears threshold on two-plus components; demo of cross-thread relevance.
- **Ambiguous / mid-tier:** moderate similarity to one component; genuine but not commanding.
- **Tangential near-miss:** admitted by the pre-filter but only loosely related; the rationale must say so.
- **Must-rank-low:** lowest qualifying similarity; barely clears the threshold.
- **A mix of mid-tier cases** requiring the feed to separate close scores sensibly.

**Size cap:** 10 papers total. One synthetic researcher profile with 3 Research Components.

**Source and privacy:** Synthetic. No real paper, author, or researcher identity. Similarity scores are hand-authored, not computed.

### Embedded fixtures

```json
{
  "researcher_profile": {
    "id": "RES-01",
    "label": "Synthetic researcher — ML systems & graph learning",
    "research_components": [
      {
        "id": "RC-1",
        "label": "Graph neural networks",
        "description": "Message-passing architectures, expressivity, scalable training on large graphs."
      },
      {
        "id": "RC-2",
        "label": "Efficient ML systems",
        "description": "Quantization, sparsity, and serving efficiency for large models."
      },
      {
        "id": "RC-3",
        "label": "Out-of-distribution generalization",
        "description": "Robustness, distribution shift, and evaluation under domain change."
      }
    ]
  },
  "candidate_papers": [
    {
      "id": "PAP-01",
      "coverage_role": "must-rank-high",
      "title": "Provable Expressivity Limits of Subgraph-Aware Message Passing",
      "authors": ["A. Nardo", "L. Beaumont"],
      "venue": "Synthetic ML Conference",
      "publication_date": "2026-05-28",
      "abstract": "We characterize the representational ceiling of subgraph-aware GNNs and give a construction that provably exceeds the 1-WL bound while remaining tractable to train.",
      "component_similarity": { "RC-1": 0.93, "RC-2": 0.21, "RC-3": 0.14 }
    },
    {
      "id": "PAP-02",
      "coverage_role": "multi-component",
      "title": "Sparse Message Passing: Quantized GNN Inference at Scale",
      "authors": ["K. Oyelaran", "M. Reyes"],
      "venue": "Synthetic Systems Workshop",
      "publication_date": "2026-04-11",
      "abstract": "A serving stack that fuses graph sparsity with 4-bit quantization, cutting GNN inference latency without measurable accuracy loss on large citation graphs.",
      "component_similarity": { "RC-1": 0.81, "RC-2": 0.79, "RC-3": 0.18 }
    },
    {
      "id": "PAP-03",
      "coverage_role": "must-rank-high",
      "title": "Quantization-Aware Training Beyond 4 Bits for Billion-Parameter Models",
      "authors": ["S. Haddad"],
      "venue": "Synthetic ML Conference",
      "publication_date": "2026-05-02",
      "abstract": "We push quantization-aware training to sub-4-bit regimes for very large transformers, with a calibration scheme that preserves downstream task accuracy.",
      "component_similarity": { "RC-1": 0.16, "RC-2": 0.90, "RC-3": 0.22 }
    },
    {
      "id": "PAP-04",
      "coverage_role": "mid-tier",
      "title": "Distribution Shift in Graph-Structured Data: A Benchmark",
      "authors": ["P. Iversen", "R. Mwangi"],
      "venue": "Synthetic Datasets Track",
      "publication_date": "2026-03-19",
      "abstract": "A benchmark suite for evaluating GNN robustness under controlled distribution shift across node, edge, and graph-level tasks.",
      "component_similarity": { "RC-1": 0.58, "RC-2": 0.12, "RC-3": 0.74 }
    },
    {
      "id": "PAP-05",
      "coverage_role": "must-rank-high",
      "title": "When Do Robust Features Survive Domain Change?",
      "authors": ["T. Volkov", "E. Santos"],
      "venue": "Synthetic ML Conference",
      "publication_date": "2026-05-14",
      "abstract": "We isolate the conditions under which features learned in-distribution remain predictive out-of-distribution, with a causal account of feature stability.",
      "component_similarity": { "RC-1": 0.19, "RC-2": 0.15, "RC-3": 0.91 }
    },
    {
      "id": "PAP-06",
      "coverage_role": "mid-tier",
      "title": "Memory-Efficient Training of Deep GNNs via Activation Checkpointing",
      "authors": ["N. Aziz"],
      "venue": "Synthetic Systems Workshop",
      "publication_date": "2026-02-27",
      "abstract": "Activation checkpointing strategies tailored to deep message-passing networks, trading compute for a large reduction in peak memory.",
      "component_similarity": { "RC-1": 0.64, "RC-2": 0.61, "RC-3": 0.17 }
    },
    {
      "id": "PAP-07",
      "coverage_role": "tangential-near-miss",
      "title": "Social Graph Analysis of Online Misinformation Spread",
      "authors": ["D. Park", "C. Lindqvist"],
      "venue": "Synthetic Computational Social Science Track",
      "publication_date": "2026-04-30",
      "abstract": "An empirical study of how misinformation propagates through online social graphs, using network centrality measures to identify amplification hubs.",
      "component_similarity": { "RC-1": 0.55, "RC-2": 0.08, "RC-3": 0.20 }
    },
    {
      "id": "PAP-08",
      "coverage_role": "mid-tier",
      "title": "Calibration Under Covariate Shift for Deployed Classifiers",
      "authors": ["F. Bianchi"],
      "venue": "Synthetic ML Conference",
      "publication_date": "2026-03-08",
      "abstract": "Post-hoc calibration methods that remain reliable when the deployment distribution drifts from training, evaluated across vision and tabular domains.",
      "component_similarity": { "RC-1": 0.11, "RC-2": 0.24, "RC-3": 0.69 }
    },
    {
      "id": "PAP-09",
      "coverage_role": "mid-tier",
      "title": "Structured Sparsity Patterns for Faster Transformer Serving",
      "authors": ["G. Adeyemi", "H. Watanabe"],
      "venue": "Synthetic Systems Workshop",
      "publication_date": "2026-05-21",
      "abstract": "We identify hardware-friendly structured sparsity patterns that accelerate transformer inference on commodity accelerators.",
      "component_similarity": { "RC-1": 0.13, "RC-2": 0.72, "RC-3": 0.19 }
    },
    {
      "id": "PAP-10",
      "coverage_role": "must-rank-low",
      "title": "A Survey of Visualization Techniques for High-Dimensional Embeddings",
      "authors": ["J. Okonkwo"],
      "venue": "Synthetic Visualization Track",
      "publication_date": "2026-01-23",
      "abstract": "A broad survey of dimensionality-reduction and visualization methods for inspecting learned embedding spaces.",
      "component_similarity": { "RC-1": 0.31, "RC-2": 0.33, "RC-3": 0.29 }
    }
  ]
}
```

## Outputs

For each paper:

- **Component match:** which Research Component(s) it matches and the similarity to each — relevance is **always named against a specific component**, never a bare global score.
- **Relevance rationale:** a brief LLM-generated explanation of *why* this paper is relevant to the named component, in the researcher's terms — the literal answer to "why is this relevant to me, right now?" For tangential near-misses, the rationale must say the match is loose rather than overstate it.
- **Recommended action:** `Read now / Save / Skip`.
- **Missing-information note** (rendered for every paper): what is not present that would sharpen the relevance call (e.g. full text beyond abstract, author overlap with the researcher's network) — even when nothing is missing, the section renders as "nothing material missing."

## Sequencer

All 10 papers are ordered into a single relevance feed, position 1 to 10, position 1 most relevant. **Ordering is by the paper's strongest single-component similarity score, descending** — this is the only ranking signal. Recency is a gate (all papers are in-window and eligible); it does not affect order. The three governing principles still hold but collapse onto the one signal here: value = strongest component similarity; urgency = satisfied uniformly by the recency gate; conservatism = a tangential near-miss is ranked by its score but flagged in the rationale so a high keyword-driven score cannot masquerade as a strong fit.

**Scoring contract (required, not advisory).** Rank by `max(component_similarity)` descending. Tie-break, in order: (1) higher number of components cleared above the relevance threshold (multi-thread relevance wins), then (2) more recent publication_date. Every position must be defensible by this rule — "the model preferred it" is not acceptable.

**Per-entry rationale:** N entries produce N rationales — one per position, each naming the matched component and why this paper sits above the one below it. There is no single global ordering explanation.

## Output surface

**Layout:**
- Two-panel structure.
- Left panel: the ranked feed, top-to-bottom in sequencer order, each entry selectable, showing rank, paper title, and recommended action.
- Right panel: detail view of the selected paper — all per-paper output sections.
- Both panels scroll independently.
- Collapsed sections retain enough height to show their section label.

**Information hierarchy:**
- Primary (always visible in the left panel): rank, title, top matched component label, recommended action.
- Secondary (in the right detail panel): per-component similarity, relevance rationale, missing-information note, per-position rationale.

**Default state:** position 1 selected on load; all detail sections collapsed (label only).

**Visual treatment:** High-contrast editorial — dark background, bright legible type, with paper titles in a readable serif to signal an academic-reading context rather than a dashboard. This visual treatment is a required deliverable, decided at requirements time and executed without iteration. Downstream layers must not demote it to "stretch."

## Implementation

**LLM commitment:** This application is LLM-driven. The component-match explanations, relevance rationales, and per-position rationales are produced by LLM calls. This is a requirements-level commitment, not a strategy-level option. (The similarity scores themselves are fixture-mocked, not LLM-produced and not computed — see below.)

**Mocked pipeline (POC scope):** Embedding generation and cosine similarity are **not** executed in this POC. The `component_similarity` values are hand-authored in the fixtures. The production pipeline — OpenAlex/arXiv ingestion, `text-embedding-3-small`, weekly centroid refresh — is out of scope for the hackathon build and must not be implemented or stubbed with live API calls.

**Target application model:** `claude-sonnet-4-6`. Pinned-snapshot identifier (dateless format, not an evergreen pointer — bump deliberately on the next Sonnet generation). For the full 10-paper set, prefer the Message Batches API: rationales are not latency-sensitive and batching roughly halves token cost.

**Model-ID scope note:** This identifier governs the *application's* API calls at runtime. It does **not** govern the Claude Code session that builds the application — Claude Code manages its own model selection. The field is binding on the built artifact, advisory on the build environment.

**Degraded-state contract (required).** When an LLM call fails, times out, or returns malformed or partial output, no surface renders a blank panel and no paper is silently dropped from the feed. A paper whose rationale could not be produced renders in the feed at its score-determined rank with an explicit "rationale unavailable — retry" state. Malformed JSON from a model call is caught, logged, and surfaced as a retryable error on that paper's detail panel.

**Other dependencies:** JSON schema validator for the per-paper output contract; the fixtures above are the canonical input — no external fetch, no OpenAlex/arXiv/OpenAI calls in this build.