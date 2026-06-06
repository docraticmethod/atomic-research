import Ajv from 'ajv';

export type ComponentInput = {
  component: string;
  component_similarity: number;
  evidence: string;
};

export type CandidatePaper = {
  paper_id: string;
  title: string;
  date: string;
  abstract: string;
  components: ComponentInput[];
};

export type ResearchComponent = {
  component: string;
  description: string;
};

export type ResearcherProfile = {
  researcher_id: string;
  name: string;
  research_components: ResearchComponent[];
};

export type ComponentOutput = {
  component: string;
  component_similarity: number;
  cleared: boolean;
  match_explanation: string;
};

export type RecommendedAction = 'Read now' | 'Save' | 'Skip';
export type RationaleStatus = 'ok' | 'unavailable' | 'malformed';
export type SummaryStatus = 'ok' | 'unavailable' | 'malformed';

export type OutputPaper = {
  paper_id: string;
  rank: number;
  title: string;
  date: string;
  max_component_similarity: number;
  recommended_action: RecommendedAction;
  components: ComponentOutput[];
  components_cleared_count: number;
  relevance_rationale: string;
  position_rationale: string;
  tangential_flag: boolean;
  missing_information: string;
  rationale_status: RationaleStatus;
};

export type FeedSummary = {
  text: string;
  summary_status: SummaryStatus;
};

export type OutputArtifact = {
  papers: OutputPaper[];
  feed_summary: FeedSummary;
};

const ajv = new Ajv();

ajv.addSchema({
  $id: 'ComponentInput',
  type: 'object',
  required: ['component', 'component_similarity', 'evidence'],
  additionalProperties: false,
  properties: {
    component: { type: 'string' },
    component_similarity: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string' },
  },
});

ajv.addSchema({
  $id: 'ResearchComponent',
  type: 'object',
  required: ['component', 'description'],
  additionalProperties: false,
  properties: {
    component: { type: 'string' },
    description: { type: 'string' },
  },
});

ajv.addSchema({
  $id: 'CandidatePaper',
  type: 'object',
  required: ['paper_id', 'title', 'date', 'abstract', 'components'],
  additionalProperties: false,
  properties: {
    paper_id: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string' },
    abstract: { type: 'string' },
    components: {
      type: 'array',
      minItems: 1,
      items: { $ref: 'ComponentInput' },
    },
  },
});

ajv.addSchema({
  $id: 'ResearcherProfile',
  type: 'object',
  required: ['researcher_id', 'name', 'research_components'],
  additionalProperties: false,
  properties: {
    researcher_id: { type: 'string' },
    name: { type: 'string' },
    research_components: {
      type: 'array',
      minItems: 1,
      items: { $ref: 'ResearchComponent' },
    },
  },
});

ajv.addSchema({
  $id: 'ComponentOutput',
  type: 'object',
  required: ['component', 'component_similarity', 'cleared', 'match_explanation'],
  properties: {
    component: { type: 'string' },
    component_similarity: { type: 'number' },
    cleared: { type: 'boolean' },
    match_explanation: { type: 'string' },
  },
});

ajv.addSchema({
  $id: 'OutputPaper',
  type: 'object',
  required: [
    'paper_id', 'rank', 'title', 'date',
    'max_component_similarity', 'recommended_action',
    'components', 'components_cleared_count',
    'relevance_rationale', 'position_rationale',
    'tangential_flag', 'missing_information', 'rationale_status',
  ],
  properties: {
    paper_id: { type: 'string' },
    rank: { type: 'integer', minimum: 1, maximum: 10 },
    title: { type: 'string' },
    date: { type: 'string' },
    max_component_similarity: { type: 'number' },
    recommended_action: { type: 'string', enum: ['Read now', 'Save', 'Skip'] },
    components: { type: 'array', items: { $ref: 'ComponentOutput' } },
    components_cleared_count: { type: 'integer', minimum: 0 },
    relevance_rationale: { type: 'string' },
    position_rationale: { type: 'string' },
    tangential_flag: { type: 'boolean' },
    missing_information: { type: 'string' },
    rationale_status: { type: 'string', enum: ['ok', 'unavailable', 'malformed'] },
  },
});

ajv.addSchema({
  $id: 'FeedSummary',
  type: 'object',
  required: ['text', 'summary_status'],
  properties: {
    text: { type: 'string' },
    summary_status: { type: 'string', enum: ['ok', 'unavailable', 'malformed'] },
  },
});

ajv.addSchema({
  $id: 'OutputArtifact',
  type: 'object',
  required: ['papers', 'feed_summary'],
  additionalProperties: false,
  properties: {
    papers: {
      type: 'array',
      minItems: 10,
      maxItems: 10,
      items: { $ref: 'OutputPaper' },
    },
    feed_summary: { $ref: 'FeedSummary' },
  },
});

export const validateCandidatePaper = ajv.compile<CandidatePaper>({ $ref: 'CandidatePaper' });
export const validateCandidatePapers = ajv.compile<CandidatePaper[]>({
  type: 'array',
  minItems: 10,
  maxItems: 10,
  items: { $ref: 'CandidatePaper' },
});
export const validateResearcherProfile = ajv.compile<ResearcherProfile>({ $ref: 'ResearcherProfile' });
export const validateOutputPaper = ajv.compile<OutputPaper>({ $ref: 'OutputPaper' });
export const validateOutputPapers = ajv.compile<OutputPaper[]>({
  type: 'array',
  minItems: 10,
  maxItems: 10,
  items: { $ref: 'OutputPaper' },
});
export const validateOutputArtifact = ajv.compile<OutputArtifact>({ $ref: 'OutputArtifact' });
