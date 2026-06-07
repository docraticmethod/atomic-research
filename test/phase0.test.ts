import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapWorkToPaper, mapWorkToPublication, emitResearcher,
  dedupeCascade, reconstructAbstract, collectCandidateSubfields,
  applyCandidateWindow,
} from '../src/fetch-boundary.js';
import { searchAuthors, type RawWork, type RawAuthor } from '../src/openalex-client.js';
import { validateResearchers, validatePublications, validatePapers } from '../src/schemas.js';
import { recencyWindow } from '../src/window.js';
import { createLogger } from '../src/logger.js';

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} } as ReturnType<typeof createLogger>;
}

function rawWork(overrides: Partial<RawWork> = {}): RawWork {
  return {
    id: 'https://openalex.org/W2741809807',
    title: 'A Study of Things',
    publication_date: '2026-03-01',
    doi: 'https://doi.org/10.1234/abcd',
    primary_topic: {
      subfield: { id: 'https://openalex.org/subfields/1702', display_name: 'Artificial Intelligence' },
      field: { id: 'https://openalex.org/fields/17', display_name: 'Computer Science' },
    },
    topics: [],
    abstract_inverted_index: { Deep: [0], learning: [1], works: [2] },
    referenced_works: ['https://openalex.org/W111', 'https://openalex.org/W222'],
    authorships: [{ author: { id: 'https://openalex.org/A5108093963', display_name: 'Jane Smith' } }],
    open_access: { is_oa: true },
    cited_by_count: 5,
    ...overrides,
  };
}

describe('Phase F — fetch boundary transforms', () => {
  test('transform 1: ID normalization → every emitted id is bare (incl referenced_works)', async () => {
    const p = await mapWorkToPaper(rawWork());
    assert.strictEqual(p.paper_id, 'W2741809807');
    assert.strictEqual(p.openalex_id, 'W2741809807');
    assert.strictEqual(p.doi, '10.1234/abcd');
    assert.deepStrictEqual(p.referenced_works, ['W111', 'W222']);
    for (const id of [p.paper_id, p.doi, ...p.referenced_works, ...p.authors.map(a => a.openalex_id)]) {
      assert.ok(!id.includes('openalex.org') && !id.includes('doi.org'), `id not bare: ${id}`);
    }
  });

  test('transform 1: arXiv id normalized from a landing-page url', async () => {
    const p = await mapWorkToPaper(rawWork({
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2401.12345v2', pdf_url: null }],
    }));
    assert.strictEqual(p.arxiv_id, '2401.12345');
  });

  test('transform 2: abstract reconstruction preserves word order', () => {
    assert.strictEqual(reconstructAbstract({ Deep: [0], learning: [1], works: [2] }), 'Deep learning works');
  });

  test('transform 2: absent abstract → null (not a crash)', async () => {
    assert.strictEqual(reconstructAbstract(null), null);
    assert.strictEqual(reconstructAbstract(undefined), null);
    const p = await mapWorkToPaper(rawWork({ abstract_inverted_index: null }));
    assert.strictEqual(p.abstract, null);
  });

  test('transform 3: dedup cascade collapses a planted duplicate (doi precedence)', async () => {
    const a = await mapWorkToPaper(rawWork({ id: 'https://openalex.org/W1' }));
    const b = await mapWorkToPaper(rawWork({ id: 'https://openalex.org/W2' })); // same doi
    const out = await dedupeCascade([a, b]);
    assert.strictEqual(out.length, 1, 'duplicate by doi should collapse');
  });

  test('window: drops out-of-window + the author’s own works', async () => {
    const win = recencyWindow(new Date('2026-06-07'));
    const inWin = await mapWorkToPaper(rawWork({ id: 'https://openalex.org/W_in', publication_date: '2026-05-01', doi: null }));
    const future = await mapWorkToPaper(rawWork({ id: 'https://openalex.org/W_future', publication_date: '2030-01-01', doi: null }));
    const own = await mapWorkToPaper(rawWork({ id: 'https://openalex.org/W_own', publication_date: '2026-05-01', doi: null }));
    const kept = await applyCandidateWindow([inWin, future, own], win, new Set(['W_own']));
    assert.deepStrictEqual(kept.map(p => p.paper_id), ['W_in']);
  });
});

const rawAuthor: RawAuthor = {
  id: 'https://openalex.org/A5108093963',
  display_name: 'Jane Smith',
  works_count: 42,
  cited_by_count: 1000,
  summary_stats: { h_index: 20 },
  topics: [
    { id: 'https://openalex.org/T10320', display_name: 'Neural Networks', subfield: { id: 'https://openalex.org/subfields/1702', display_name: 'Artificial Intelligence' } },
    { id: 'https://openalex.org/T9999', display_name: 'Robotics', subfield: { id: 'https://openalex.org/subfields/2207', display_name: 'Control and Systems Engineering' } },
  ],
};

describe('Phase F — shape emission validates as v3.1 shapes', () => {
  test('emitResearcher → valid Researcher (with works/citation/h-index)', async () => {
    const r = await emitResearcher(rawAuthor, 'I study neural networks.', ['neural networks', 'robotics']);
    assert.strictEqual(r.researcher_id, 'A5108093963');
    assert.strictEqual(r.h_index, 20);
    assert.ok(validateResearchers([r]), JSON.stringify(validateResearchers.errors));
  });

  test('mapWorkToPublication → valid Publication; mapWorkToPaper → valid Paper', async () => {
    const pub = await mapWorkToPublication(rawWork(), 'A5108093963');
    assert.ok(validatePublications([pub]), JSON.stringify(validatePublications.errors));
    const pap = await mapWorkToPaper(rawWork());
    assert.ok(validatePapers([pap]), JSON.stringify(validatePapers.errors));
  });

  test('thin-coverage fallback: candidate subfields include author-profile topic subfields', async () => {
    const candidates = await collectCandidateSubfields([], rawAuthor);
    const ids = candidates.map(c => c.id);
    assert.ok(ids.includes('subfields/1702'));
    assert.ok(ids.includes('subfields/2207'));
  });
});

describe('Phase F — client degrade-to-empty (never throws upward)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('a thrown network error degrades searchAuthors to []', async () => {
    globalThis.fetch = (() => { throw new Error('network down'); }) as unknown as typeof fetch;
    const out = await searchAuthors('anyone', silentLogger());
    assert.deepStrictEqual(out, []);
  });

  test('a non-2xx response degrades to []', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const out = await searchAuthors('anyone', silentLogger());
    assert.deepStrictEqual(out, []);
  });
});
