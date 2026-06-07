import Ajv from 'ajv';

// ── Fixture input types ────────────────────────────────────────────────────

export type ResearcherTopic = {
  id: string;
  display_name: string;
  score: number;
};

export type Researcher = {
  researcher_id: string;
  name: string;
  full_name: string;
  description: string;
  research_interests: string[];
  topics: ResearcherTopic[];
  works_count: number;
  cited_by_count: number;
  h_index: number;
};

export type PublicationAuthor = {
  name: string;
  openalex_id: string;
};

export type PublicationTopic = {
  id: string;
  display_name: string;
  score: number;
};

export type Publication = {
  publication_id: string;
  researcher_id: string;
  openalex_id: string;
  title: string;
  abstract: string | null;
  authors: PublicationAuthor[];
  year: number;
  venue: string;
  arxiv_categories: string[];
  topics: PublicationTopic[];
  citation_count: number;
};

export type PaperAuthor = {
  name: string;
  openalex_id: string;
};

export type PaperTopic = {
  id: string;
  display_name: string;
  score: number;
};

export type Paper = {
  paper_id: string;
  openalex_id: string;
  arxiv_id: string;
  doi: string;
  title: string;
  abstract: string | null;
  authors: PaperAuthor[];
  publication_date: string;
  year: number;
  arxiv_categories: string[];
  topics: PaperTopic[];
  referenced_works: string[];
  citation_count: number;
  is_open_access: boolean;
};

export type CouncilVoice = {
  role: string;
  argument: string;
  leaning: string;
};

// ── Grounded profile types (Stage-1 output) ────────────────────────────────

export type GroundingStatus = 'ok' | 'unavailable';

export type GroundedComponent = {
  name: string;
  description: string;
  source_paper_ids: string[];
  explanation: string;
  aptness_flags: string[];
};

export type GroundedSubfield = {
  name: string;
  description: string;
  source_paper_ids: string[];
  explanation: string;
  aptness_flags: string[];
};

export type GroundedProfile = {
  researcher_id: string;
  grounding_status: GroundingStatus;
  research_components: GroundedComponent[];
  research_subfield_preferences: GroundedSubfield[];
};

// ── Output types ────────────────────────────────────────────────────────────

export type DecisionStatus = 'ok' | 'unavailable' | 'malformed';
export type SummaryStatus = 'ok' | 'unavailable' | 'malformed';

export type MatchedComponent = {
  component: string;
  source_paper_ids: string[];
  match_explanation: string;
};

export type CouncilDeliberation = {
  voices: CouncilVoice[];
  substantive_vs_superficial: string;
  subfield_weighing: string;
  resolution: string;
};

export type FeedItem = {
  feed_item_id: string;
  researcher_id: string;
  paper_id: string;
  position: number;
  title: string;
  publication_date: string;
  relevance_decision: boolean;
  relevance_score: number;
  council_confidence: number;
  relevance_reason: string;
  matched_components: MatchedComponent[];
  matched_subfields: string[];
  council_deliberation: CouncilDeliberation;
  decision_status: DecisionStatus;
};

export type FeedSummary = {
  text: string;
  summary_status: SummaryStatus;
};

export type ResearcherFeed = {
  researcher_id: string;
  researcher_name: string;
  grounding_status: GroundingStatus;
  grounded_profile: GroundedProfile | null;
  feed: FeedItem[];
  feed_summary: FeedSummary;
};

export type OutputArtifact = ResearcherFeed[];

// ── Ajv instance ────────────────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true });

// ── Fixture schemas ─────────────────────────────────────────────────────────

const researcherTopicSchema = {
  type: 'object',
  required: ['id', 'display_name', 'score'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
};

ajv.addSchema({
  $id: 'Researcher',
  type: 'object',
  required: ['researcher_id', 'name', 'full_name', 'description', 'research_interests', 'topics', 'works_count', 'cited_by_count', 'h_index'],
  additionalProperties: false,
  properties: {
    researcher_id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    full_name: { type: 'string' },
    description: { type: 'string', minLength: 1 },
    research_interests: { type: 'array', minItems: 1, items: { type: 'string' } },
    topics: { type: 'array', items: researcherTopicSchema },
    works_count: { type: 'integer', minimum: 0 },
    cited_by_count: { type: 'integer', minimum: 0 },
    h_index: { type: 'integer', minimum: 0 },
  },
});

// v3.2: one confirmed author per run (single human link decision).
ajv.addSchema({
  $id: 'ResearchersArray',
  type: 'array',
  minItems: 1,
  maxItems: 1,
  items: { $ref: 'Researcher' },
});

const publicationAuthorSchema = {
  type: 'object',
  required: ['name', 'openalex_id'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    openalex_id: { type: 'string' },
  },
};

const publicationTopicSchema = {
  type: 'object',
  required: ['id', 'display_name', 'score'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
};

// v3.2: validates TRANSFORMED network records (bare ids, reconstructed-or-null
// abstract). Bounds relaxed off the synthetic fixture scale to live own-works.
ajv.addSchema({
  $id: 'Publication',
  type: 'object',
  required: ['publication_id', 'researcher_id', 'openalex_id', 'title', 'abstract', 'authors', 'year', 'venue', 'arxiv_categories', 'topics', 'citation_count'],
  additionalProperties: false,
  properties: {
    publication_id: { type: 'string', minLength: 1 },
    researcher_id: { type: 'string' },
    openalex_id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    abstract: { type: ['string', 'null'] },
    authors: { type: 'array', minItems: 1, items: publicationAuthorSchema },
    year: { type: 'integer', minimum: 0 },
    venue: { type: 'string' },
    arxiv_categories: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: publicationTopicSchema },
    citation_count: { type: 'integer', minimum: 0 },
  },
});

ajv.addSchema({
  $id: 'PublicationsArray',
  type: 'array',
  minItems: 0,
  items: { $ref: 'Publication' },
});

const paperAuthorSchema = {
  type: 'object',
  required: ['name', 'openalex_id'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    openalex_id: { type: 'string' },
  },
};

const paperTopicSchema = {
  type: 'object',
  required: ['id', 'display_name', 'score'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
};

// v3.2: validates TRANSFORMED candidate works. Every id is bare (incl. each
// referenced_works entry); abstract is reconstructed-or-null; arxiv_id/doi may
// be ''. Count bounds relaxed to the live subfield pull.
ajv.addSchema({
  $id: 'Paper',
  type: 'object',
  required: ['paper_id', 'openalex_id', 'arxiv_id', 'doi', 'title', 'abstract', 'authors', 'publication_date', 'year', 'arxiv_categories', 'topics', 'referenced_works', 'citation_count', 'is_open_access'],
  additionalProperties: false,
  properties: {
    paper_id: { type: 'string', minLength: 1 },
    openalex_id: { type: 'string' },
    arxiv_id: { type: 'string' },
    doi: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    abstract: { type: ['string', 'null'] },
    authors: { type: 'array', minItems: 1, items: paperAuthorSchema },
    publication_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    year: { type: 'integer', minimum: 0 },
    arxiv_categories: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: paperTopicSchema },
    referenced_works: { type: 'array', items: { type: 'string' } },
    citation_count: { type: 'integer', minimum: 0 },
    is_open_access: { type: 'boolean' },
  },
});

ajv.addSchema({
  $id: 'PapersArray',
  type: 'array',
  minItems: 0,
  items: { $ref: 'Paper' },
});

const councilVoiceSchema = {
  type: 'object',
  required: ['role', 'argument', 'leaning'],
  properties: {
    role: { type: 'string' },
    argument: { type: 'string' },
    leaning: { type: 'string' },
  },
};

// ── Grounded profile schemas ────────────────────────────────────────────────

const groundedComponentSchema = {
  type: 'object',
  required: ['name', 'description', 'source_paper_ids', 'explanation', 'aptness_flags'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    source_paper_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    explanation: { type: 'string', minLength: 1 },
    aptness_flags: { type: 'array', items: { type: 'string' } },
  },
};

const groundedSubfieldSchema = {
  type: 'object',
  required: ['name', 'description', 'source_paper_ids', 'explanation', 'aptness_flags'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    source_paper_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    explanation: { type: 'string', minLength: 1 },
    aptness_flags: { type: 'array', items: { type: 'string' } },
  },
};

ajv.addSchema({
  $id: 'GroundedProfile',
  type: 'object',
  required: ['researcher_id', 'grounding_status', 'research_components', 'research_subfield_preferences'],
  additionalProperties: false,
  properties: {
    researcher_id: { type: 'string' },
    grounding_status: { type: 'string', enum: ['ok', 'unavailable'] },
    research_components: { type: 'array', minItems: 1, items: groundedComponentSchema },
    research_subfield_preferences: { type: 'array', minItems: 1, items: groundedSubfieldSchema },
  },
});

// ── Output schemas ──────────────────────────────────────────────────────────

const matchedComponentSchema = {
  type: 'object',
  required: ['component', 'source_paper_ids', 'match_explanation'],
  properties: {
    component: { type: 'string' },
    source_paper_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    match_explanation: { type: 'string', minLength: 1 },
  },
};

const councilDeliberationSchema = {
  type: 'object',
  required: ['voices', 'substantive_vs_superficial', 'subfield_weighing', 'resolution'],
  properties: {
    voices: { type: 'array', items: councilVoiceSchema },
    substantive_vs_superficial: { type: 'string' },
    subfield_weighing: { type: 'string' },
    resolution: { type: 'string' },
  },
};

ajv.addSchema({
  $id: 'FeedItem',
  type: 'object',
  required: [
    'feed_item_id', 'researcher_id', 'paper_id', 'position', 'title', 'publication_date',
    'relevance_decision', 'relevance_score', 'council_confidence', 'relevance_reason',
    'matched_components', 'matched_subfields', 'council_deliberation', 'decision_status',
  ],
  properties: {
    feed_item_id: { type: 'string' },
    researcher_id: { type: 'string' },
    paper_id: { type: 'string' },
    position: { type: 'integer', minimum: 1 },
    title: { type: 'string' },
    publication_date: { type: 'string' },
    relevance_decision: { type: 'boolean' },
    relevance_score: { type: 'number', minimum: 0, maximum: 1 },
    council_confidence: { type: 'integer', minimum: 0, maximum: 100 },
    relevance_reason: { type: 'string' },
    matched_components: { type: 'array', items: matchedComponentSchema },
    matched_subfields: { type: 'array', items: { type: 'string' } },
    council_deliberation: councilDeliberationSchema,
    decision_status: { type: 'string', enum: ['ok', 'unavailable', 'malformed'] },
  },
});

ajv.addSchema({
  $id: 'FeedSummary',
  type: 'object',
  required: ['text', 'summary_status'],
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    summary_status: { type: 'string', enum: ['ok', 'unavailable', 'malformed'] },
  },
});

ajv.addSchema({
  $id: 'ResearcherFeed',
  type: 'object',
  required: ['researcher_id', 'researcher_name', 'grounding_status', 'grounded_profile', 'feed', 'feed_summary'],
  additionalProperties: false,
  properties: {
    researcher_id: { type: 'string' },
    researcher_name: { type: 'string' },
    grounding_status: { type: 'string', enum: ['ok', 'unavailable'] },
    grounded_profile: {
      oneOf: [
        { $ref: 'GroundedProfile' },
        { type: 'null' },
      ],
    },
    feed: {
      type: 'array',
      items: { $ref: 'FeedItem' },
    },
    feed_summary: { $ref: 'FeedSummary' },
  },
});

// v3.2: one confirmed author per run.
ajv.addSchema({
  $id: 'OutputArtifact',
  type: 'array',
  minItems: 1,
  maxItems: 1,
  items: { $ref: 'ResearcherFeed' },
});

// ── Compiled validators ─────────────────────────────────────────────────────

export const validateResearchers = ajv.compile<Researcher[]>({ $ref: 'ResearchersArray' });
export const validatePublications = ajv.compile<Publication[]>({ $ref: 'PublicationsArray' });
export const validatePapers = ajv.compile<Paper[]>({ $ref: 'PapersArray' });
export const validateGroundedProfile = ajv.compile<GroundedProfile>({ $ref: 'GroundedProfile' });
export const validateFeedItem = ajv.compile<FeedItem>({ $ref: 'FeedItem' });
export const validateFeedSummary = ajv.compile<FeedSummary>({ $ref: 'FeedSummary' });
export const validateResearcherFeed = ajv.compile<ResearcherFeed>({ $ref: 'ResearcherFeed' });
export const validateOutputArtifact = ajv.compile<OutputArtifact>({ $ref: 'OutputArtifact' });
