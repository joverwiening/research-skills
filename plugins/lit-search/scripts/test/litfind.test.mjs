/**
 * Offline tests for the pure half of litfind.mjs. The grader fallback chain can be exercised live
 * against a dead Jev endpoint (LITFIND_JEV_URL) or CLI (LITFIND_CLAUDE_CLI).
 * Run: node --test scripts/test/
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseArgs, knownIdsFrom, fromOA, jevBody, stemTokens, normTitle, cleanDoi, abstractOf, withRoutes, parseAlphaxiv, alphaxivSearch } from '../litfind.mjs';

describe('parseArgs', () => {
  it('collects repeated flags and single values', () => {
    const a = parseArgs(['--q', 'Q', '--kw', 'a b', '--kw', 'c', '--para', 'p', '--k', '10', '--no-arxiv', '--drop', 'W1']);
    assert.equal(a.q, 'Q');
    assert.deepEqual(a.kw, ['a b', 'c']);
    assert.deepEqual(a.para, ['p']);
    assert.equal(a.k, '10');
    assert.equal(a['no-arxiv'], true);
    assert.deepEqual(a.drop, ['W1']);
  });
  it('takes --no-alphaxiv as a boolean', () => {
    assert.equal(parseArgs(['--q', 'Q', '--no-alphaxiv'])['no-alphaxiv'], true);
    assert.equal(parseArgs(['--q', 'Q'])['no-alphaxiv'], undefined);
  });
  it('rejects unknown flags, bare words and a missing value', () => {
    assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag/);
    assert.throws(() => parseArgs(['word']), /unexpected argument/);
    assert.throws(() => parseArgs(['--q']), /needs a value/);
  });
});

describe('knownIdsFrom', () => {
  it('pulls DOIs, arXiv ids (bare and as DOI) and OpenAlex ids out of a literature file', () => {
    const ids = knownIdsFrom('- Gütig 2006, doi:10.1038/nn1643. see also arXiv 1706.03762v5 and 10.48550/arXiv.2106.09685, W2112796928');
    assert.equal(ids.has('d:10.1038/nn1643'), true);
    assert.equal(ids.has('a:1706.03762'), true);
    assert.equal(ids.has('a:2106.09685'), true);
    assert.equal(ids.has('W:W2112796928'), true);
  });
  it('does not read a version or a decimal as an arXiv id', () => {
    const ids = knownIdsFrom('accuracy 0.8812 and 12.34567 units');
    assert.deepEqual([...ids].filter((x) => x.startsWith('a:')), []);
  });
});

describe('fromOA', () => {
  it('shapes an OpenAlex work, finds the arXiv id in a location, rebuilds the abstract', () => {
    const r = fromOA({
      id: 'https://openalex.org/W123', doi: 'https://doi.org/10.1000/ABC.', title: 'A <i>neuron</i> that learns',
      publication_year: 2006, cited_by_count: 5, type: 'article',
      primary_location: { source: { display_name: 'Nat Neurosci' } },
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2101.00001v2' }],
      authorships: [{ author: { display_name: 'A B' } }, { author: { display_name: 'C D' } }, { author: { display_name: 'E F' } }, { author: { display_name: 'G H' } }],
      abstract_inverted_index: { learns: [1], it: [0] }, referenced_works: ['https://openalex.org/W9'],
    });
    assert.equal(r.oa, 'W123');
    assert.equal(r.doi, '10.1000/abc');
    assert.equal(r.arxiv, '2101.00001');
    assert.equal(r.title, 'A neuron that learns');
    assert.deepEqual(r.authors, ['A B', 'C D', 'E F', 'et al.']);
    assert.equal(r.abstract, 'it learns');
    assert.deepEqual(r.refs, ['W9']);
  });
});

describe('jevBody', () => {
  const it0 = { title: 'T', abstract: null };
  it('uses the evaluated with-context wording and passes project_context', () => {
    const b = jevBody(it0, 'Q', 'C');
    assert.equal(b.state.project_context, 'C');
    assert.equal(b.state.paper_abstract, '(no abstract)');
    assert.equal(b.questions.addresses.type, 'noul');
    assert.match(b.questions.addresses.instructions, /given their project/);
    assert.deepEqual(Object.keys(b.questions), ['addresses']);
  });
  it('falls back to the no-context wording without --ctx', () => {
    const b = jevBody(it0, 'Q', '');
    assert.equal(b.state.project_context, undefined);
    assert.match(b.questions.addresses.instructions, /working on exactly that question/);
  });
  it('caps the abstract at 1500 chars', () => {
    assert.equal(jevBody({ title: 'T', abstract: 'x'.repeat(4000) }, 'Q', 'C').state.paper_abstract.length, 1500);
  });
});

describe('text helpers', () => {
  it('stems plurals and -ing, drops stopwords and short tokens', () => {
    assert.deepEqual(stemTokens('The learning of spiking neurons'), ['learn', 'spik', 'neuron']);
  });
  it('normalizes titles and DOIs', () => {
    assert.equal(normTitle('The Tempotron: a Neuron!'), 'thetempotronaneuron');
    assert.equal(cleanDoi('https://doi.org/10.1/X);'), '10.1/x');
    assert.equal(abstractOf(null), null);
  });
});

describe('withRoutes', () => {
  it('adds 0.05 per route past the first, capped at +0.2', () => {
    assert.equal(withRoutes(0.5, 1), 0.5);
    assert.ok(Math.abs(withRoutes(0.5, 3) - 0.6) < 1e-9);
    assert.ok(Math.abs(withRoutes(0.5, 14) - 0.7) < 1e-9);
  });
});

// Built from a real discover_papers reply, plus a slug id and a versioned id.
const AX_TEXT = '1. [ID=2608.18222] **Think Shallow, Solve Deep: Controlling Recurrent Dynamics for Reliable Test-Time Depth** (https://www.alphaxiv.org/abs/2608.18222). Published 2026-08-18 by FRC RAS, ITMO, lab260, BitmanagerAI, MTUCI, KAU, CNRS, IMJ-PRG · 9 votes · 110 views: Recurrent-depth reasoners aim to solve harder problems by iterating their update longer at test time, but additional iterations can improve, preserve, or degrade an answer. We show that a measurable p...\n'
  + '2. [ID=2609.recurrent-looped-transformer] **Recurrent Looped Transformer** (https://www.alphaxiv.org/abs/2609.recurrent-looped-transformer). Published 2026-09-01 · 0 votes · 3 views: A slug entry.\n'
  + '3. [ID=2502.05171v2] **Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth  Approach** (https://www.alphaxiv.org/abs/2502.05171). Published 2025-02-07 by ELLIS Institute Tübingen, Max Planck Institute for Intelligent Systems, Tübingen AI Center, University of Maryland, College Park, Lawrence Livermore National Laboratory · 1107 votes · 71052 views: We study a novel language model architecture that is capable of scaling\ntest-time computation by implicitly reasoning in latent space. Our model works\nby iterating a recurrent block, thereby unrolling...\n';

describe('parseAlphaxiv', () => {
  it('keeps real arXiv ids, strips the version, drops slugs, keeps multi-line previews', () => {
    const r = parseAlphaxiv(AX_TEXT);
    assert.deepEqual(r.map((x) => x.arxiv), ['2608.18222', '2502.05171']);
    assert.equal(r[0].title, 'Think Shallow, Solve Deep: Controlling Recurrent Dynamics for Reliable Test-Time Depth');
    assert.equal(r[1].title, 'Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth Approach');
    assert.match(r[0].preview, /^Recurrent-depth reasoners aim/);
    assert.match(r[1].preview, /scaling test-time computation .* unrolling\.\.\.$/);
  });
  it('returns [] for text without entries', () => {
    assert.deepEqual(parseAlphaxiv('No papers found.'), []);
  });
});

describe('alphaxivSearch failures', () => {
  let server;
  afterEach(async () => {
    delete process.env.LITFIND_ALPHAXIV_URL;
    mock.restoreAll();
    if (server) await new Promise((r) => server.close(r));
    server = null;
  });
  const serve = async (handler) => {
    server = createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.LITFIND_ALPHAXIV_URL = `http://127.0.0.1:${server.address().port}/`;
  };
  const stderr = () => {
    const lines = [];
    mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
    return lines;
  };

  it('no key: returns [] silently, no request', async () => {
    let hits = 0;
    await serve((req, res) => { hits++; res.end(); });
    const lines = stderr();
    assert.deepEqual(await alphaxivSearch('Q', ['k'], ''), []);
    assert.equal(hits, 0);
    assert.deepEqual(lines, []);
  });
  it('HTTP 500: returns [] with one warning', async () => {
    await serve((req, res) => { res.statusCode = 500; res.end('boom'); });
    const lines = stderr();
    assert.deepEqual(await alphaxivSearch('Q', ['k'], 'test-key-0000000000'), []);
    assert.match(lines.join(''), /alphaXiv search failed: initialize HTTP 500/);
  });
  it('MCP error reply: returns [] with a warning', async () => {
    await serve((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'mcp says no' } }));
    });
    const lines = stderr();
    assert.deepEqual(await alphaxivSearch('Q', [], 'test-key-0000000000'), []);
    assert.match(lines.join(''), /alphaXiv search failed: initialize: mcp says no/);
  });
  it('nothing listening: returns [] with a warning', async () => {
    process.env.LITFIND_ALPHAXIV_URL = 'http://127.0.0.1:9/';
    const lines = stderr();
    assert.deepEqual(await alphaxivSearch('Q', ['k'], 'test-key-0000000000'), []);
    assert.match(lines.join(''), /alphaXiv search failed/);
  });
});
