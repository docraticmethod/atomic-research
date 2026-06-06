import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateCandidatePaper,
  validateCandidatePapers,
  validateResearcherProfile,
} from '../src/schemas.js';

describe('Phase 0 — fixtures load and validate', () => {
  test('researcher_profile.json validates', async () => {
    const raw = await readFile('data/researcher_profile.json', 'utf-8');
    const profile = JSON.parse(raw);
    const valid = validateResearcherProfile(profile);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateResearcherProfile.errors)}`);
  });

  test('candidate_papers.json validates — all 10 papers', async () => {
    const raw = await readFile('data/candidate_papers.json', 'utf-8');
    const papers = JSON.parse(raw);
    assert.strictEqual(papers.length, 10, 'expected exactly 10 candidate papers');
    const valid = validateCandidatePapers(papers);
    assert.ok(valid, `validation errors: ${JSON.stringify(validateCandidatePapers.errors)}`);
  });

  test('every paper has component_similarity in [0, 1]', async () => {
    const raw = await readFile('data/candidate_papers.json', 'utf-8');
    const papers = JSON.parse(raw);
    for (const paper of papers) {
      for (const c of paper.components) {
        assert.ok(
          c.component_similarity >= 0 && c.component_similarity <= 1,
          `${paper.paper_id} component "${c.component}" similarity ${c.component_similarity} out of [0,1]`,
        );
      }
    }
  });

  test('malformed paper is rejected — missing date and out-of-range similarity', () => {
    const malformed = {
      paper_id: 'PAP-99',
      title: 'Bad Paper',
      components: [
        { component: 'information retrieval', component_similarity: 1.5 },
      ],
    };
    const valid = validateCandidatePaper(malformed as never);
    assert.strictEqual(valid, false, 'malformed paper should fail validation');
    assert.ok(
      validateCandidatePaper.errors && validateCandidatePaper.errors.length > 0,
      'expected at least one validation error',
    );
  });
});
