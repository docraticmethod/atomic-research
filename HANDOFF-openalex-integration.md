# Handoff — OpenAlex Integration & "Find Your Profile" Onboarding

**Codebase:** `feed-service` (Atomic Research — https://atomicresearch.ca)
**Scope of this doc:** Exactly how the service talks to the OpenAlex API — how data is *accessed*, *pulled*, *transformed*, and *stored* — with the "search for your profile" onboarding flow traced end-to-end.
**Audience:** An engineer who has built something similar and wants a precise, reproducible reference for our approach.
**Date:** 2026-06-07

> Companion docs in this folder: `openalex-api.md` (reference of endpoints/params) and `openalex-setup.md` (zero-to-production checklist). This handoff is the *narrative* that ties those together with the actual code paths and the onboarding UX.

---

## 1. The 30-second mental model

OpenAlex is the **only** source of author identity, publication history, and (for the OpenAlex pipeline) candidate papers. We never store an OpenAlex API key as a hard requirement — the integration works against the free public API, and an optional key just raises rate limits.

There are **two distinct moments** where we hit OpenAlex:

| Moment | Trigger | What we pull | Where |
|--------|---------|-------------|-------|
| **Onboarding** | A new user runs "Find your research profile" | Author search → author profile → recent works (for centroid) | `manage-researcher-profile` Edge Function |
| **Ongoing scans** | Scheduled cron / first-scan trigger | Recent papers by subfield + the researcher's own citation corpus | `runScanForResearcher.ts`, `fetchOpenAlexPapers.ts` |

Everything OpenAlex-facing lives in **Supabase Edge Functions** (Deno runtime, TypeScript). The frontend never calls OpenAlex directly — it always goes through our Edge Functions, which proxy the calls. This keeps the (optional) API key server-side and lets us normalize data before it reaches the client.

```
Browser (React/Vite)
   │  POST /functions/v1/manage-researcher-profile  { action: "..." }
   ▼
Supabase Edge Function (Deno)  ──fetch──▶  https://api.openalex.org
   │
   ▼
Postgres (researcher_profiles, papers, feed_items, ...)
```

---

## 2. OpenAlex access conventions (applied everywhere)

These are the invariants every OpenAlex call in this codebase follows. If you are replicating our approach, replicate these first.

### 2.1 Base URL & entities used
- Base: `https://api.openalex.org`
- Entities: **`/works`** (papers), **`/authors`** (people), **`/subfields`** (taxonomy).

### 2.2 The "polite pool" — `mailto` on every request
OpenAlex has an anonymous tier (~10 req/s) and a "polite pool" (~100 req/s) you opt into simply by adding `mailto=<email>` to the query string. We pass `mailto=feed@projectcentroid.io` on every works/subfields call.

- Constant lives in `supabase/functions/_shared/fetchOpenAlexPapers.ts`:
  ```ts
  const USER_AGENT = "ProjectCentroid/1.0 (feed@projectcentroid.io)"
  const MAILTO = "feed@projectcentroid.io"
  ```
- We also send a `User-Agent` header identifying the app (OpenAlex asks clients to self-identify).

### 2.3 Optional API key — `OPENALEX_API_KEY`
- Read via `Deno.env.get("OPENALEX_API_KEY")`.
- When present, appended as `&api_key=${apiKey}`. When absent, the call still works.
- **Important asymmetry in the current code:** the *author* and *subfield* calls in `manage-researcher-profile/index.ts` append the key conditionally, but the core `fetchOpenAlexPapers.ts` and the corpus fetch in `runScanForResearcher.ts` rely on `mailto` only (no key). This is fine on the polite pool but is the first thing to unify if you start hitting limits at scale. (See §9.)

### 2.4 `select` to shrink payloads
Every call uses `select=` to request only the fields we use. This matters a lot for bulk fetches (corpus, centroid) where the full work object is 30+ fields.

### 2.5 ID normalization — strip the URL prefix
OpenAlex returns IDs as **full URLs** (`https://openalex.org/W2741809807`). We store **short IDs** (`W2741809807`) everywhere. The helper:
```ts
function shortId(url: string): string {
  return url.replace(/^https?:\/\/openalex\.org\//, "")
}
```
Applied to: work IDs, author IDs, topic IDs, subfield IDs, and every entry of `referenced_works`. DOIs get the analogous `https://doi.org/` strip. arXiv IDs get the `https://arxiv.org/abs/` strip via `normalizeArxivId()`.

Prefixes: `W`=work, `A`=author, `I`=institution, `S`=source/subfield, `T`=topic.

### 2.6 Abstracts come as an inverted index
OpenAlex never returns plain-text abstracts. It returns `abstract_inverted_index`: a `{ word: [positions...] }` map. We rebuild text by placing each word at its position(s) and joining. See `reconstructAbstract()` in `fetchOpenAlexPapers.ts`. (Note: the centroid path takes a cheaper shortcut — it just joins `Object.keys(...)`, i.e. bag-of-words, since order doesn't matter for an embedding. See §6.)

### 2.7 Error handling: degrade, never throw
Every OpenAlex call is wrapped so a failure returns `[]` / `null` / skips the item rather than aborting a batch. Network errors and non-2xx responses are logged and swallowed. This is deliberate — one bad subfield fetch must not kill an entire researcher's scan.

### 2.8 Polite sequential delay
When looping over many subfields, we `await` a **1-second delay** between calls (`fetchDelayMs`, default 1000; set to 0 in tests). Calls are **sequential**, not parallel, during a scan.

---

## 3. The "Find your research profile" onboarding — end to end

This is the flow the user asked about. It is orchestrated by **`OnboardingGate`** and rendered by **`OnboardingView`**, both in `frontend/src/pages/`.

### 3.1 Gate state machine

`frontend/src/pages/OnboardingGate.tsx` is a wrapper around the whole app. On mount (once the user is authenticated) it calls the `get_profile` action and routes to one of these states:

```
loading → signin → signup → pending_approval → onboarding → description → scanning → ready
```

- `get_profile` returns an `access_status` (`null | pending | approved`). The app is access-gated: a Visitor must submit an Access Request and be approved by an admin before onboarding.
- If `approved` **and** a profile already exists → `ready` (straight to the feed).
- If `approved` and **no** profile yet → `onboarding` (the OpenAlex search screen).

So onboarding only ever runs for an approved user with no profile row.

### 3.2 Screen 1 — "Find your research profile" (the OpenAlex author search)

Rendered by `OnboardingView` → inner `OpenAlexSearch` component. UX:

1. **Header:** "Find your research profile" / "Link your OpenAlex profile so we can personalise your feed from your publication history."
2. **A debounced search box** ("Search by name", placeholder "e.g. Jane Smith").
   - Debounce: `DEBOUNCE_MS = 350`. Queries shorter than 2 chars are ignored.
   - Each keystroke (after debounce) fires:
     ```ts
     invokeManageResearcherProfile({ action: 'autocomplete_authors', query })
     ```
3. **Results list** — each result shows name, current affiliation, `{paperCount} papers · {citationCount} citations`. These three stats are what let a user disambiguate themselves from a namesake.
4. **Confirmation step** — clicking a result swaps to an "Is this you?" card. "That's me →" fires:
   ```ts
   invokeManageResearcherProfile({ action: 'link_openalex', author_id: selected.authorId })
   ```
5. **Escape hatches** (important for the Follower path):
   - A top-level "Skip — I haven't published" button.
   - A progressive "I can't find my profile" → (retry hint) → "I still can't find my profile" sequence. Either of the skip paths calls `onComplete({ openalex_id: null, ... })`, which advances the gate to the `description` step **without** an OpenAlex link. This is how a user becomes a **Follower** (no publication history) instead of a **Publisher**.

### 3.3 Screen 2 — "Tell us about your research" (`DescriptionStep`)

After linking (or skipping), the gate shows `DescriptionStep`. The free-text description does two things:
- Saved via `save_description` (and embedded — see below).
- **In the background** (user never sees a picker) it fires `generate_subfield_suggestions`, which uses an LLM over the full OpenAlex subfield taxonomy to infer 3–8 subfields, then `save_subfields` persists them. This is the mechanism that gives a Follower fetch targets despite having no publication record.

### 3.4 Screen 3 — "Finding papers for you…" (`scanning`)

On continue, the gate sets state to `scanning` and fires `trigger_scan`, which runs a full scan synchronously (see §5). If it fails it's non-fatal — the feed just fills on the next scheduled scan. Then → `ready`.

### 3.5 The client transport

All actions go through one thin wrapper, `frontend/src/lib/manageResearcherProfile.ts`:

```ts
fetch(`${VITE_SUPABASE_URL}/functions/v1/manage-researcher-profile`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),  // { action, ...payload }
})
```
- The user's Supabase JWT is attached as `Authorization`. The Edge Function uses it to build a **user-scoped** Supabase client (RLS enforced) and, separately, a **service-role** admin client for the few operations that must bypass RLS (conflict checks, anonymous-user takeover).
- Errors are normalized: the function returns `{ success: false, error, code }`; the wrapper throws a typed `ManageResearcherProfileError` carrying `code` (e.g. `PROFILE_ALREADY_LINKED`) so the UI can show the right message.

---

## 4. The two onboarding OpenAlex calls, in detail

Both live in `supabase/functions/manage-researcher-profile/index.ts`.

### 4.1 `autocomplete_authors` → `GET /authors`

```
GET /authors?search={query}
            &per_page=10
            &select=id,display_name,works_count,cited_by_count,last_known_institutions
            [&api_key={key}]
```

Code (`autocompleteAuthors`):
```ts
const apiKey = Deno.env.get("OPENALEX_API_KEY")
let url = `https://api.openalex.org/authors?search=${encodeURIComponent(query)}&per_page=10`
        + `&select=id,display_name,works_count,cited_by_count,last_known_institutions`
if (apiKey) url += `&api_key=${apiKey}`
const res = await fetch(url)
```
Response is mapped to the `AuthorResult[]` the UI expects:
```ts
{
  authorId:        shortId(author.id),
  name:            author.display_name,
  currentAffiliation: author.last_known_institutions?.[0]?.display_name ?? null,
  paperCount:      author.works_count,
  citationCount:   author.cited_by_count,
}
```
- `search=` is OpenAlex's relevance-ranked full-text search across author names — good enough for "type your name" autocomplete.
- Non-2xx → `{ success:false, error:"OPENALEX_ERROR" }` with HTTP 502; the UI silently shows no results.

### 4.2 `link_openalex` → `GET /authors/{id}` + conflict handling + centroid

```
GET /authors/{authorId}?select=id,display_name,works_count,cited_by_count,summary_stats,topics
                       [&api_key={key}]
```

`linkOpenalex` does five things:

1. **Fetch the full author profile** (above). Pulls `summary_stats.h_index`, `cited_by_count`, `works_count`, and `topics` (the author's research topics with scores).
2. **Map topics** to our stored shape via `mapTopics()` (short IDs, `score ?? count ?? 0`).
3. **Conflict check (service-role/admin client):** is this `openalex_id` already on another user's `researcher_profiles` row?
   - If the existing owner is a **real** user → return `PROFILE_ALREADY_LINKED` (HTTP 400). The UI shows "This profile is already linked to another account."
   - If the existing owner is an **anonymous** user (`is_anonymous`) → **take over** that row (reassign `user_id`). This supports an anon→real upgrade path.
   - If no conflict → **upsert** a `researcher_profiles` row keyed on `user_id`.
4. **Persist profile fields** via `buildProfileFields()`: `openalex_id, name, full_name, topics, h_index, citation_count, paper_count, openalex_fetched_at`.
5. **Fire-and-forget centroid computation** (`computeAndSaveCentroid`, not awaited) — see §6. The response returns immediately with the profile and `inferred_categories` (arXiv category codes guessed from the author's topics via the regex `TOPIC_CATEGORY_MAP`).

A Publisher (linked) vs Follower (skipped) is determined purely by whether `openalex_id` is non-null on the resulting profile.

---

## 5. Ongoing data pull — the OpenAlex Scan Job

This is how papers keep flowing after onboarding. Entry point: `runScanForResearcher(researcherId, deps)` in `supabase/functions/_shared/runScanForResearcher.ts`. It's called both by `trigger_scan` (synchronous, during onboarding) and by the scheduled scan Edge Function.

The scan does dependency-injected I/O (`ScanDeps`) so it's unit-testable; `makeProdDeps(supabase)` wires the real implementations.

**Steps:**

1. **Load profile + preferences + state** in parallel: the researcher profile, their `research_subfield_preferences`, the set of already-actioned paper IDs (never re-touched), the pending feed items (to rescore), and the **citation corpus** (§5.2).

2. **Compute the lookback window:** `SCAN_LOOKBACK_DAYS = 180`. `since = now - 180 days`. (The domain glossary describes this as "past 6 months.")

3. **Fetch candidate papers per subfield (sequential, 1s apart).** For each subfield preference, call `fetchOpenAlexPapers(subfieldId, since)` (§5.1).

4. **Flatten & dedup** across subfields by `openalex_id` then `arxiv_id` (in-memory `Set`s).

5. **Upsert each paper** into the `papers` table (`onConflict: "openalex_id"`) — this is the global, shared paper pool.

6. **Score** each paper against the researcher (`scorePaperRelevance`), using the citation corpus for bibliographic coupling.

7. **Write feed items:** pending item exists → rescore; actioned (saved/dismissed) → skip; otherwise → insert a new `feed_items` row with `status:"pending"`, `surfaced_at`, etc.

> Note: this `runScanForResearcher` is the **legacy numeric-score** path (`relevance_score` + template `relevance_reason`). The current architecture is migrating toward the **Embedding Pre-filter → Relevance Council (Advocate/Skeptic/Judge)** pipeline described in `CONTEXT.md` (`council-job`, `feed-scan-job`, `embeddingPreFilter.ts`). The **OpenAlex fetch mechanics below are identical in both** — only the scoring/feed-creation downstream differs.

### 5.1 Subfield paper fetch — `fetchOpenAlexPapers(subfieldId, since)`

The single most important function for "pulling papers." `supabase/functions/_shared/fetchOpenAlexPapers.ts`:

```
GET /works?filter=primary_topic.subfield.id:{subfieldId},from_publication_date:{YYYY-MM-DD}
         &sort=publication_date:desc
         &per_page=50
         &mailto=feed@projectcentroid.io
```
- `filter` chains two clauses with a comma (AND): the subfield and the date floor.
- `subfieldId` is in `subfields/NNNN` form (e.g. `subfields/2207`).
- Returns up to 50 most-recent works, each mapped through `mapWorkToPaper()` (§5.3). On any error → `[]`.

### 5.2 Citation corpus fetch — `getCorpusPapers(openalexId)`

For Publishers, we pull their own 50 most recent works to extract the works they cite (for bibliographic coupling scoring). In `makeProdDeps`:
```
GET /works?filter=authorships.author.id:{openalexId}
         &sort=publication_date:desc
         &per-page=50
         &select=id,referenced_works
         &mailto=feed@projectcentroid.io
```
- Minimal `select` — only `id` and `referenced_works`.
- Returns `[]` immediately for Followers (`openalexId == null`).
- The "Citation Corpus" is **never stored** — recomputed each scan run.

### 5.3 Work → Paper mapping (`mapWorkToPaper`)

Every OpenAlex work is normalized into our canonical `Paper` type. Key transforms:
- Abstract reconstructed from the inverted index (or `null`).
- `topics`, `referenced_works`, `openalex_id`, `doi`, `arxiv_id` all URL-stripped.
- `year` parsed from `publication_date`.
- `authors` mapped to `{ name, openalex_id }`.
- `pdf_url` / `landing_page_url` lifted from `primary_location`.
- `is_open_access` from `open_access.is_oa`.
- `id`, `created_at`, `updated_at` left as `""` placeholders — Postgres assigns them on upsert (the placeholders are stripped before the DB write in `paperStore.upsert`).

### 5.4 Deduplication identity

A paper's identity across sources is resolved by `resolvePaperIdentity.ts` (used by the arXiv path) and by inline `Set`s in the scan (OpenAlex path). The cascade is: **arxiv_id → doi → openalex_id → new record**. This is what lets the same paper arriving from OpenAlex and from arXiv collapse into one `papers` row.

---

## 6. Centroid computation (`computeAndSaveCentroid`)

Fired (not awaited) at the end of `link_openalex`, and re-run weekly by `centroid-refresh-job`. Pulls the researcher's recent works to build an embedding that represents their research "center of gravity":

```
GET /works?filter=author.id:{openalex_id}
         &per-page=50
         &sort=publication_date:desc
         &select=id,title,abstract_inverted_index
         &mailto=feed@projectcentroid.io
```
- For each work, embed `selectTextForEmbedding(title, abstract)`; here the abstract is cheaply approximated as `Object.keys(abstract_inverted_index).join(" ")` (bag-of-words — order is irrelevant to the embedding).
- Mean-pool the embeddings → `centroid_embedding` on `researcher_profiles`.
- Entirely non-fatal: if OpenAI (the embedding provider) is down, the profile is simply saved without a centroid.

(`note:` newer architecture replaces the raw centroid + description-embedding blend with a single "Unified Context Embedding" synthesized from the narrative profile — see `CONTEXT.md`. The OpenAlex works fetch that *feeds* it is unchanged.)

---

## 7. Subfield discovery for Followers (`generate_subfield_suggestions`)

How a user with no publication history still gets fetch targets. In `manage-researcher-profile/index.ts`:

1. Fetch the entire subfield taxonomy: `GET /subfields?per-page=200&mailto=...` (~250 subfields, each with `id | display_name | field.display_name`).
2. Build a prompt listing all subfields and ask `gpt-4o-mini` (temperature 0, JSON mode) to return 3–8 matching subfield IDs for the researcher's description.
3. Filter the taxonomy down to the returned IDs, normalize, and return as `{ subfield_id, subfield_name, field_id, field_name }[]`.
4. The frontend immediately `save_subfields` them. These become the `research_subfield_preferences` rows the scan iterates over.

For Publishers, subfields instead come from the OpenAlex subfield tags on their own publications (extracted/refreshed weekly).

---

## 8. The complete OpenAlex call inventory

Every place this codebase touches OpenAlex, with file and purpose:

| # | Endpoint | Params | File / function | Purpose |
|---|----------|--------|-----------------|---------|
| 1 | `/authors` | `search`, `per_page=10`, `select`, opt. `api_key` | `manage-researcher-profile` → `autocompleteAuthors` | Onboarding name autocomplete |
| 2 | `/authors/{id}` | `select=...,summary_stats,topics`, opt. `api_key` | `manage-researcher-profile` → `linkOpenalex` | Fetch full author profile on link |
| 3 | `/works` | `filter=author.id:{id}`, `per-page=50`, `select=id,title,abstract_inverted_index`, `mailto` | `manage-researcher-profile` → `computeAndSaveCentroid` | Recent works → centroid embedding |
| 4 | `/works` | `filter=primary_topic.subfield.id:{sf},from_publication_date:{d}`, `sort`, `per_page=50`, `mailto` | `_shared/fetchOpenAlexPapers.ts` | Candidate papers per subfield (the core pull) |
| 5 | `/works` | `filter=authorships.author.id:{id}`, `per-page=50`, `select=id,referenced_works`, `mailto` | `_shared/runScanForResearcher.ts` → `getCorpusPapers` | Citation corpus for bibliographic coupling |
| 6 | `/works` | `filter=authorships.author.id:{id}`, `per-page=50`, `select=id,referenced_works`, `mailto` | `manage-researcher-profile` → `diagnose` | Debug/diagnostic endpoint |
| 7 | `/subfields` | `per-page=200`, `mailto` | `manage-researcher-profile` → `generateSubfieldSuggestions` | Full taxonomy for LLM subfield inference |

---

## 9. Notes, gotchas & things to unify if you're cloning this

1. **`per_page` vs `per-page`.** OpenAlex accepts both spellings. This codebase is inconsistent — `fetchOpenAlexPapers` uses `per_page`, the author/corpus calls use `per-page`. Both work; standardize if you care.
2. **API key isn't applied uniformly.** Calls #4 and #5 (the highest-volume ones, run in scan loops) rely on `mailto` only and **do not** append `OPENALEX_API_KEY`. If you provision a key for rate limits, add it to `fetchOpenAlexPapers.ts` and `getCorpusPapers` too — otherwise the bulk paths stay on the polite pool while only onboarding benefits.
3. **No pagination.** Everything caps at the first page (`per_page` 50 or 200). We deliberately want only the most recent N. If you need deep history, switch to `cursor=*` paging.
4. **Centroid abstract shortcut.** `computeAndSaveCentroid` uses bag-of-words from the inverted index keys, not the reconstructed-order abstract. Fine for embeddings; do **not** copy that shortcut for display.
5. **Sequential 1s delay** is the rate-limit safety valve, not the API key. With many subfields a scan is intentionally slow-and-polite. Tests inject `fetchDelayMs: 0`.
6. **Everything degrades to empty.** No OpenAlex call throws upward. A scan with total OpenAlex failure simply produces zero new feed items and logs errors.
7. **Edge Functions run without JWT verification at the platform level** (`verify_jwt = false` project-wide convention) — auth is enforced *inside* the function via `userClient.auth.getUser()` + RLS, with a service-role client for the few cross-user operations.
8. **The frontend never calls OpenAlex.** All calls are proxied through `manage-researcher-profile`. Keep it that way — it's what keeps the key server-side and the data normalized.

---

## 10. File map (where to look)

```
frontend/src/
  pages/OnboardingGate.tsx        ── onboarding state machine (loading→…→ready)
  pages/OnboardingView.tsx        ── "Find your research profile" + OpenAlexSearch (author autocomplete UI)
  pages/DescriptionStep.tsx       ── free-text description → background subfield inference
  lib/manageResearcherProfile.ts  ── thin client: POST to the Edge Function, typed errors

supabase/functions/
  manage-researcher-profile/index.ts   ── ALL onboarding OpenAlex calls + action router
                                            (autocomplete_authors, link_openalex, get_openalex_papers,
                                             generate_subfield_suggestions, diagnose, + profile/seed/admin actions)
  _shared/fetchOpenAlexPapers.ts        ── core /works-by-subfield fetch + work→Paper mapping + inverted-index reconstruct
  _shared/runScanForResearcher.ts       ── scan orchestration; getCorpusPapers (/works-by-author); 1s polite delay
  _shared/resolvePaperIdentity.ts       ── cross-source dedup cascade (arxiv_id → doi → new)
  _shared/embeddingUtils.ts             ── computeResearcherCentroid, selectTextForEmbedding
  centroid-refresh-job/index.ts         ── weekly re-pull of works → recompute centroid/profile

docs/
  openalex-api.md     ── endpoint/param reference
  openalex-setup.md   ── zero-to-production checklist
  HANDOFF-openalex-integration.md  ── (this file)
```

---

## 11. Minimal reproduction recipe

To stand up the same OpenAlex access pattern in a fresh project:

1. **Polite pool:** put `mailto=<your-monitored-email>` on every request; set a `User-Agent`. No account needed.
2. **One base fetcher** with conditional `&api_key=` from env, `Accept: application/json`, and try/catch returning `null`.
3. **Author search** (`/authors?search=&select=id,display_name,works_count,cited_by_count,last_known_institutions`) for the "is this you?" picker; show paper/citation counts to disambiguate.
4. **Author profile** (`/authors/{id}?select=...,summary_stats,topics`) on confirm; store short IDs.
5. **Works by subfield** (`/works?filter=primary_topic.subfield.id:{sf},from_publication_date:{d}&sort=publication_date:desc&per_page=50`) as the recurring pull; reconstruct abstracts from the inverted index; dedup by arxiv_id/doi/openalex_id.
6. **Works by author** (`select=id,referenced_works`) if you do citation-based scoring.
7. **Sequential 1s delay** in any multi-call loop; `select` everything down to the fields you use.
8. **Proxy through a backend function** so the key stays server-side and you normalize before the client sees it.
