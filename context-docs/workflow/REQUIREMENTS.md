# REQUIREMENTS.md

  ## V3.2 — Live OpenAlex Data

  ### Intent
  V3.2 replaces the four hand-written synthetic fixtures with live pulls from `api.openalex.org`. The orchestrator's `grounding →council →
  summary` pipeline is unchanged: it stops reading files and starts reading the network. All new behavior lives at the fetch boundary; nothing in
  the grounding, council, or eval logic changes.

  ### Fixture → source map

  | V3.1 fixture | V3.2 source | Endpoint |
  |---|---|---|
  | `researchers.json` | linked author profile | `GET /authors/{id}` |
  | `publications.json` | linked author's own recent works | `GET /works?filter=author.id:{id}` |
  | `papers.json` | recurring candidate pull by subfield | `GET /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}` |
  | `feed_items.json` | **dropped as input** — now *output* of the council scoring stage | — |

  ### Requirements

  #### R-3.2-1 — One-step onboarding via author link
  Onboarding collapses to a single action: the user searches their name (`GET /authors?search=`), the UI shows relevance-ranked matches with name,
  current affiliation, and `{works_count} papers · {cited_by_count} citations` for disambiguation, the user confirms "is this you?", and the system
  persists the linked OpenAlex author ID. That one confirmed identity sources everything downstream.

  *Rationale: a single confirmed identity is the only onboarding input the rest of the pipeline needs — minimizes friction and is the sole human 
  decision in the flow.*

  #### R-3.2-2 — `researchers` record from author profile
  On link, pull `GET /authors/{id}` (`select=id,display_name,works_count,cited_by_count,summary_stats,topics`) and build the researcher record from
  it: name, h-index (`summary_stats.h_index`), citation count, works count, and topics. Replaces the hand-written `researchers.json` row.

  #### R-3.2-3 — `publications` from the author's own works
  Pull the linked author's recent works (`GET /works?filter=author.id:{id}&sort=publication_date:desc&per_page=50`) to become the`publications`
  set. This is the **only** input to Stage 1 grounding. Replaces `publications.json`.

  #### R-3.2-4 — Subfields derived from publications only; no user-inputted text
  Per the **"no user-inputted data yet"** constraint: the system does **not** collect a free-text description and does **not** run
  LLM-over-description subfield inference. Research components and subfield preferences are derived **purely** from the publication record and its
  OpenAlex subfield tags (`primary_topic.subfield`). The Follower path (a user with no publications) is **out of scope for V3.2**— every linked
  user is treated as a Publisher.

  *Rationale: keeps V3.2 a pure data swap with zero new free-text or LLM-inference surface.*

  #### R-3.2-5 — `papers` from recurring subfield pull
  The subfields from R-3.2-4 drive the recurring candidate-paper pull: `GET
  /works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}&sort=publication_date:desc&per_page=50`, one call per subfield. This
  candidate pool feeds the council. Replaces `papers.json`.

  #### R-3.2-6 — Feed items are an output, not an input
  `feed_items.json` ceases to be an ingested fixture. Feed items become the **output of the council scoring stage**. Any requirement describing
  reading feed items from disk is removed.

  #### R-3.2-7 — Fetch-boundary transforms
  At the new fetch boundary (and nowhere else):
  - **ID normalization** — strip the `https://openalex.org/` prefix from every ID (works, authors, topics, subfields, and each entry of
  `referenced_works`); strip `https://doi.org/` from DOIs; normalize arXiv IDs.
  - **Abstract reconstruction** — rebuild plain text from `abstract_inverted_index` (word → positions); `null` when absent.
  - **Deduplication cascade** — collapse the same paper by `arxiv_id → doi → openalex_id → new record`.
  - **Polite pool** — send `mailto=<monitored-email>` on every request and a self-identifying `User-Agent`. An optional `OPENALEX_API_KEY` raises
  rate limits but is never required.
  - **Degrade-to-empty** — every OpenAlex call returns `[]` / `null` / skips the item on error and never throws upward. Total OpenAlex failure
  yields zero new feed items, not a crash.

  ### Invariant
  Nothing in the grounding, council (Advocate / Skeptic / Judge), or eval logic changes. V3.2 is exclusively the relocation of the data source from
  local JSON to the OpenAlex network boundary.

  ### Assumptions (flag if wrong)
  - The current harness reads exactly the four named fixtures and runs `grounding → council → summary`.
  - OpenAlex subfield tags are reliably present on the author's own works (R-3.2-4 depends on this); if coverage is thin, fall back to the
  author-profile `topics`.

  ### Scope cuts (not in V3.2; "with more time")
  - No Follower / free-text / LLM-subfield-inference path.
  - No pagination — first page only (most-recent N).
  - No centroid / embedding pre-filter changes — V3.2 swaps inputs only.
  - API key not unified across all calls (the polite pool is sufficient at prototype scale).