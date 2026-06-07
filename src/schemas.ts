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
  abstract: string;
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
  title: string;
  abstract: string;
  authors: PaperAuthor[];
  publication_date: string;
  year: number;
  arxiv_categories: string[];
  topics: PaperTopic[];
  citation_count: number;
  is_open_access: boolean;
};

export type CouncilVoice = {
  role: string;
  argument: string;
  leaning: string;
};

export type CouncilDeliberationSeed = {
  voices: CouncilVoice[];
  substantive_vs_superficial: string;
  resolution: string;
};

export type FeedItemSeed = {
  id: string;
  researcher_id: string;
  paper_id: string;
  relevance_score: number;
  relevance_decision: boolean;
  council_confidence: number;
  relevance_reason: string;
  council_deliberation: CouncilDeliberationSeed;
  council_version: string;
  status: string;
  surfaced_at: string;
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
  required: ['researcher_id', 'name', 'full_name', 'description', 'research_interests', 'topics'],
  additionalProperties: false,
  properties: {
    researcher_id: { type: 'string' },
    name: { type: 'string' },
    full_name: { type: 'string' },
    description: { type: 'string', minLength: 1 },
    research_interests: { type: 'array', minItems: 1, items: { type: 'string' } },
    topics: { type: 'array', minItems: 1, items: researcherTopicSchema },
  },
});

ajv.addSchema({
  $id: 'ResearchersArray',
  type: 'array',
  minItems: 3,
  maxItems: 3,
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

ajv.addSchema({
  $id: 'Publication',
  type: 'object',
  required: ['publication_id', 'researcher_id', 'openalex_id', 'title', 'abstract', 'authors', 'year', 'venue', 'arxiv_categories', 'topics', 'citation_count'],
  additionalProperties: false,
  properties: {
    publication_id: { type: 'string' },
    researcher_id: { type: 'string' },
    openalex_id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    abstract: { type: 'string', minLength: 10 },
    authors: { type: 'array', minItems: 1, items: publicationAuthorSchema },
    year: { type: 'integer', minimum: 2018 },
    venue: { type: 'string' },
    arxiv_categories: { type: 'array', minItems: 1, items: { type: 'string' } },
    topics: { type: 'array', minItems: 1, items: publicationTopicSchema },
    citation_count: { type: 'integer', minimum: 0 },
  },
});

ajv.addSchema({
  $id: 'PublicationsArray',
  type: 'array',
  minItems: 45,
  maxItems: 60,
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

ajv.addSchema({
  $id: 'Paper',
  type: 'object',
  required: ['paper_id', 'openalex_id', 'arxiv_id', 'title', 'abstract', 'authors', 'publication_date', 'year', 'arxiv_categories', 'topics', 'citation_count', 'is_open_access'],
  additionalProperties: false,
  properties: {
    paper_id: { type: 'string' },
    openalex_id: { type: 'string' },
    arxiv_id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    abstract: { type: 'string', minLength: 10 },
    authors: { type: 'array', minItems: 1, items: paperAuthorSchema },
    publication_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    year: { type: 'integer' },
    arxiv_categories: { type: 'array', minItems: 1, items: { type: 'string' } },
    topics: { type: 'array', minItems: 1, items: paperTopicSchema },
    citation_count: { type: 'integer', minimum: 0 },
    is_open_access: { type: 'boolean' },
  },
});

ajv.addSchema({
  $id: 'PapersArray',
  type: 'array',
  minItems: 30,
  maxItems: 30,
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

const councilDeliberationSeedSchema = {
  type: 'object',
  required: ['voices', 'substantive_vs_superficial', 'resolution'],
  properties: {
    voices: { type: 'array', minItems: 1, items: councilVoiceSchema },
    substantive_vs_superficial: { type: 'string' },
    resolution: { type: 'string' },
  },
};

ajv.addSchema({
  $id: 'FeedItemSeed',
  type: 'object',
  required: ['id', 'researcher_id', 'paper_id', 'relevance_score', 'relevance_decision', 'council_confidence', 'relevance_reason', 'council_deliberation', 'council_version', 'status', 'surfaced_at'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    researcher_id: { type: 'string' },
    paper_id: { type: 'string' },
    relevance_score: { type: 'number', minimum: 0, maximum: 1 },
    relevance_decision: { type: 'boolean' },
    council_confidence: { type: 'integer', minimum: 0, maximum: 100 },
    relevance_reason: { type: 'string' },
    council_deliberation: councilDeliberationSeedSchema,
    council_version: { type: 'string' },
    status: { type: 'string' },
    surfaced_at: { type: 'string' },
  },
});

ajv.addSchema({
  $id: 'FeedItemsArray',
  type: 'array',
  minItems: 30,
  maxItems: 30,
  items: { $ref: 'FeedItemSeed' },
});

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

ajv.addSchema({
  $id: 'OutputArtifact',
  type: 'array',
  minItems: 3,
  maxItems: 3,
  items: { $ref: 'ResearcherFeed' },
});

// ── Compiled validators ─────────────────────────────────────────────────────

export const validateResearchers = ajv.compile<Researcher[]>({ $ref: 'ResearchersArray' });
export const validatePublications = ajv.compile<Publication[]>({ $ref: 'PublicationsArray' });
export const validatePapers = ajv.compile<Paper[]>({ $ref: 'PapersArray' });
export const validateFeedItemSeeds = ajv.compile<FeedItemSeed[]>({ $ref: 'FeedItemsArray' });
export const validateGroundedProfile = ajv.compile<GroundedProfile>({ $ref: 'GroundedProfile' });
export const validateFeedItem = ajv.compile<FeedItem>({ $ref: 'FeedItem' });
export const validateFeedSummary = ajv.compile<FeedSummary>({ $ref: 'FeedSummary' });
export const validateResearcherFeed = ajv.compile<ResearcherFeed>({ $ref: 'ResearcherFeed' });
export const validateOutputArtifact = ajv.compile<OutputArtifact>({ $ref: 'OutputArtifact' });
