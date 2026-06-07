import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateResearchers,
  validatePapers,
  validateResearchComponents,
  validateSubfieldPreferences,
  validateFeedItemSeeds,
} from '../src/schemas.js';

describe('Phase 0 — fixtures load and validate', () => {
  test('researchers.json validates — exactly 3 researchers', async () => {
    const raw = await readFile('data/researchers.json', 'utf-8');
    const data = JSON.parse(raw);
    assert.strictEqual(data.length, 3, 'expected exactly 3 researchers');
    const valid = validateResearchers(data);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateResearchers.errors)}`);
  });

  test('researchers.json — each researcher has description, research_interests, topics', async () => {
    const raw = await readFile('data/researchers.json', 'utf-8');
    const researchers = JSON.parse(raw);
    for (const r of researchers) {
      assert.ok(r.description && r.description.length > 0, `${r.researcher_id} missing description`);
      assert.ok(Array.isArray(r.research_interests) && r.research_interests.length > 0, `${r.researcher_id} missing research_interests`);
      assert.ok(Array.isArray(r.topics) && r.topics.length > 0, `${r.researcher_id} missing topics`);
    }
  });

  test('papers.json validates — exactly 30 papers', async () => {
    const raw = await readFile('data/papers.json', 'utf-8');
    const data = JSON.parse(raw);
    assert.strictEqual(data.length, 30, 'expected exactly 30 papers');
    const valid = validatePapers(data);
    assert.ok(valid, `validation errors: ${JSON.stringify(validatePapers.errors)}`);
  });

  test('papers.json — all publication_dates in recency window 2025-12-06 → 2026-06-06', async () => {
    const raw = await readFile('data/papers.json', 'utf-8');
    const papers = JSON.parse(raw);
    const WINDOW_START = new Date('2025-12-06');
    const WINDOW_END = new Date('2026-06-06');
    for (const p of papers) {
      const d = new Date(p.publication_date);
      assert.ok(d >= WINDOW_START && d <= WINDOW_END,
        `${p.paper_id} date ${p.publication_date} outside window`);
    }
  });

  test('papers.json — all paper_ids are globally unique', async () => {
    const raw = await readFile('data/papers.json', 'utf-8');
    const papers = JSON.parse(raw);
    const ids = papers.map((p: { paper_id: string }) => p.paper_id);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length, 'duplicate paper_ids found');
  });

  test('papers.json — synthetic IDs do not look like real OpenAlex IDs', async () => {
    const raw = await readFile('data/papers.json', 'utf-8');
    const papers = JSON.parse(raw);
    for (const p of papers) {
      assert.ok(
        p.openalex_id.includes('synthetic'),
        `${p.paper_id} openalex_id "${p.openalex_id}" should be obviously synthetic`,
      );
    }
  });

  test('research_components.json validates', async () => {
    const raw = await readFile('data/research_components.json', 'utf-8');
    const data = JSON.parse(raw);
    const valid = validateResearchComponents(data);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateResearchComponents.errors)}`);
  });

  test('research_components.json — each component has source_paper_ids', async () => {
    const raw = await readFile('data/research_components.json', 'utf-8');
    const components = JSON.parse(raw);
    for (const c of components) {
      assert.ok(
        Array.isArray(c.source_paper_ids) && c.source_paper_ids.length > 0,
        `component ${c.component_id} has empty source_paper_ids`,
      );
    }
  });

  test('research_subfield_preferences.json validates', async () => {
    const raw = await readFile('data/research_subfield_preferences.json', 'utf-8');
    const data = JSON.parse(raw);
    const valid = validateSubfieldPreferences(data);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateSubfieldPreferences.errors)}`);
  });

  test('feed_items.json validates — exactly 30 items', async () => {
    const raw = await readFile('data/feed_items.json', 'utf-8');
    const data = JSON.parse(raw);
    assert.strictEqual(data.length, 30, 'expected exactly 30 feed_items');
    const valid = validateFeedItemSeeds(data);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateFeedItemSeeds.errors)}`);
  });

  test('feed_items.json — each item has all 5 council fields', async () => {
    const raw = await readFile('data/feed_items.json', 'utf-8');
    const items = JSON.parse(raw);
    for (const fi of items) {
      assert.ok(typeof fi.relevance_decision === 'boolean', `${fi.id} missing relevance_decision`);
      assert.ok(typeof fi.relevance_score === 'number', `${fi.id} missing relevance_score`);
      assert.ok(typeof fi.council_confidence === 'number', `${fi.id} missing council_confidence`);
      assert.ok(fi.relevance_reason, `${fi.id} missing relevance_reason`);
      assert.ok(fi.council_deliberation, `${fi.id} missing council_deliberation`);
    }
  });

  test('malformed researcher is rejected — missing description', () => {
    const malformed = {
      researcher_id: 'RES-999',
      name: 'Bad',
      full_name: 'Bad Researcher',
      research_interests: ['x'],
      topics: [{ id: 'T1', display_name: 'Topic', score: 0.5 }],
    };
    const valid = validateResearchers([malformed as never]);
    assert.strictEqual(valid, false, 'malformed researcher should fail validation');
  });

  test('malformed paper is rejected — missing abstract', () => {
    const malformed = {
      paper_id: 'PAP-BAD',
      openalex_id: 'W999synthetic',
      arxiv_id: '2601.999synthetic',
      title: 'Bad Paper',
      authors: [{ name: 'A', openalex_id: 'A999synthetic' }],
      publication_date: '2026-01-01',
      year: 2026,
      arxiv_categories: ['cs.LG'],
      topics: [{ id: 'T1', display_name: 'T', score: 0.5 }],
      citation_count: 0,
      is_open_access: true,
    };
    const valid = validatePapers([malformed as never]);
    assert.strictEqual(valid, false, 'malformed paper should fail validation');
  });
});
