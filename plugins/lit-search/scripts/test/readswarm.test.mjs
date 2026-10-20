/**
 * Offline tests for the pure half of readswarm.mjs: no network, no model calls.
 * Run: node --test test/readswarm.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireSlot, checkQuote, normalizeForMatch, stripReferences, truncateText, makeBatches, parseModelOutput, isUsageLimit,
  loadPapers, parseArgs, parseChoices, listTextFiles, loadItems, buildItemPrompt,
} from '../readswarm.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PAPER = 'Introduction. We study learning in deep networks trained with feedback alignment. '
  + 'Our main result is that the network first aligns its forward weights with the fixed random feedback weights '
  + 'and only afterwards memorises the training data, which explains why the method fails on convolutional '
  + 'architectures where the alignment phase cannot complete within the available degrees of freedom. '
  + 'We confirm this with experiments on several standard benchmarks and discuss the consequences.';

const words = (s) => s.split(/\s+/).filter(Boolean);
const Q30 = words(PAPER).slice(14, 44).join(' ');

describe('checkQuote', () => {
  it('exact substring', () => {
    assert.equal(checkQuote('the network first aligns its forward weights with the fixed random feedback weights', PAPER), 'exact');
  });
  it('whitespace, hyphenation, ligature, case and curly-quote variants are exact', () => {
    const text = 'The net­work ﬁrst aligns its for-\nward   weights with the “fixed” random feedback weights—always.';
    assert.equal(checkQuote('the network first aligns its forward weights with the "fixed" random feedback weights-always', text), 'exact');
    assert.equal(checkQuote('THE NETWORK  first\naligns its forward weights', text), 'exact');
  });
  it('one word changed in a 30-word quote is fuzzy', () => {
    assert.equal(words(Q30).length, 30);
    const w = words(Q30);
    w[1] = 'CHANGED';
    assert.equal(checkQuote(w.join(' '), PAPER), 'fuzzy');
  });
  it('a mid-quote change in a 30-word quote loses 3 of 28 3-grams and is still fuzzy', () => {
    const w = words(Q30);
    w[15] = 'CHANGED';
    assert.equal(checkQuote(w.join(' '), PAPER), 'fuzzy');
  });
  it('two mid-quote changes far apart are not_found', () => {
    const w = words(Q30);
    w[8] = 'CHANGED';
    w[20] = 'ALTERED';
    assert.equal(checkQuote(w.join(' '), PAPER), 'not_found');
  });
  it('fuzzy needs the 3-grams within one window of 2x the quote length', () => {
    const w = words(Q30);
    const a = w.slice(0, 18).join(' ');
    const b = w.slice(12).join(' ');
    assert.equal(checkQuote(Q30, `${a} gap ${b}`), 'fuzzy');
    assert.equal(checkQuote(Q30, `${a} ${'filler '.repeat(200)}${b}`), 'not_found');
  });
  it('paraphrase is not_found', () => {
    assert.equal(checkQuote('networks trained this way first match the forward and backward weights and then fit the data', PAPER), 'not_found');
  });
  it('small-caps references heading is stripped', () => {
    const body = 'x '.repeat(500);
    assert.ok(!stripReferences(`${body}\nR EFERENCES\n[1] A. Author.`).includes('Author'));
  });
  it('under 4 words is too_short', () => {
    assert.equal(checkQuote('feedback alignment fails', PAPER), 'too_short');
  });
  it('normalizeForMatch collapses and lowercases', () => {
    assert.equal(normalizeForMatch('  A\tB\n\nC  '), 'a b c');
  });
});

describe('stripReferences', () => {
  const body = 'x'.repeat(5000);
  it('strips a late references heading', () => {
    const t = `${body}\nConclusion text.\nReferences\n[1] A. Author. Title. 2020.\n[2] B. Author. 2021.`;
    const s = stripReferences(t);
    assert.ok(s.endsWith('Conclusion text.'));
    assert.ok(!/References/.test(s));
  });
  it('keeps an early references heading', () => {
    const t = `Intro\nReferences\nsee below\n${body}`;
    assert.equal(stripReferences(t), t);
  });
  it('uses the last matching heading', () => {
    const t = `${body}\nBibliography\nmid ${'y'.repeat(500)}\n  LITERATURE CITED  \n[1] ref`;
    assert.ok(stripReferences(t).endsWith('y'.repeat(500)));
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    assert.deepEqual(truncateText('abc', 10), { text: 'abc', truncated: false });
  });
  it('keeps 70 % head + 30 % tail with a marker', () => {
    const t = 'a'.repeat(700) + 'm'.repeat(1000) + 'z'.repeat(300);
    const r = truncateText(t, 1000);
    assert.equal(r.truncated, true);
    const [head, marker, tail] = r.text.split('\n');
    assert.equal(head, 'a'.repeat(700));
    assert.equal(marker, '[... 1000 chars omitted ...]');
    assert.equal(tail, 'z'.repeat(300));
    assert.ok(r.text.length <= 1000 + marker.length + 2);
  });
});

describe('makeBatches', () => {
  it('splits by count', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: i, chars: 10 }));
    assert.deepEqual(makeBatches(items, 5).map((b) => b.length), [5, 5, 2]);
  });
  it('splits by char cap', () => {
    const items = [100, 200, 150, 50, 400].map((c, i) => ({ id: i, chars: c }));
    assert.deepEqual(makeBatches(items, 5, 350).map((b) => b.map((x) => x.id)), [[0, 1], [2, 3], [4]]);
  });
  it('a single paper over the cap still gets its own call', () => {
    assert.deepEqual(makeBatches([{ chars: 10 }, { chars: 999 }], 5, 100).map((b) => b.length), [1, 1]);
  });
});

describe('parseModelOutput', () => {
  const arr = [{ pid: 'P1', verdict: 'no', claim: 'c', quotes: [] }];
  it('bare array', () => assert.deepEqual(parseModelOutput(JSON.stringify(arr)), arr));
  it('fenced', () => assert.deepEqual(parseModelOutput('```json\n' + JSON.stringify(arr) + '\n```'), arr));
  it('leading prose', () => assert.deepEqual(parseModelOutput('Here is the result [as asked]:\n' + JSON.stringify(arr)), arr));
  it('garbage is null', () => {
    assert.equal(parseModelOutput('I cannot help with that.'), null);
    assert.equal(parseModelOutput('[1, 2'), null);
    assert.equal(parseModelOutput(''), null);
  });
});

describe('isUsageLimit', () => {
  it('synthetic model', () => {
    assert.equal(isUsageLimit({ result: "You've hit your limit · resets 5pm", modelUsage: { '<synthetic>': {} } }), true);
  });
  it('is_error', () => assert.equal(isUsageLimit({ is_error: true, result: 'x' }), true));
  it('limit text without JSON', () => {
    assert.equal(isUsageLimit({ result: 'Claude AI usage limit reached|1760000000', modelUsage: { 'claude-haiku-5-5': {} } }), true);
  });
  it('normal result is not a limit, even if a quote mentions rate limits', () => {
    const r = JSON.stringify([{ pid: 'P1', verdict: 'partly', claim: 'about rate limit coding', quotes: [] }]);
    assert.equal(isUsageLimit({ result: r, is_error: false, modelUsage: { 'claude-haiku-5-5': {} } }), false);
  });
});

describe('loadPapers / parseArgs', () => {
  it('litfind json: top then rest, capped', () => {
    const j = { top: [{ rank: 1, title: 'A', doi: '10.1/a' }, { rank: 2, title: 'B' }], rest: [{ rank: 3, title: 'C', arxiv: '2101.00001' }] };
    const p = loadPapers(JSON.stringify(j), 3);
    assert.deepEqual(p.map((x) => x.title), ['A', 'B', 'C']);
    assert.equal(loadPapers(JSON.stringify(j), 2).length, 2);
  });
  it('id list', () => {
    const p = loadPapers('10.1088/1751-8121/ac411b\n2101.00001\nW3171259667\n\n', 60);
    assert.equal(p[0].doi, '10.1088/1751-8121/ac411b');
    assert.equal(p[1].arxiv, '2101.00001');
    assert.equal(p[2].openalex, 'W3171259667');
  });
  it('parseArgs', () => {
    assert.deepEqual(parseArgs(['--q', 'Q', '--top', '8', '--dry-run']), { q: 'Q', top: '8', 'dry-run': true });
    assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag/);
    assert.throws(() => parseArgs(['--q']), /missing value/);
  });
});

describe('acquireSlot', () => {
  it('caps concurrent holders across callers and reclaims dead owners', async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    const { tmpdir: td } = await import('node:os');
    const { join: j } = await import('node:path');
    const dir = mkdtempSync(j(td(), 'rs-slots-'));
    const a = await acquireSlot(dir, 2, 20);
    const b = await acquireSlot(dir, 2, 20);
    let got = false;
    const c = acquireSlot(dir, 2, 20).then((rel) => { got = true; return rel; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(got, false);
    a();
    const rc = await c;
    assert.equal(got, true);
    b(); rc();
    mk(j(dir, 'slot-0'));
    wf(j(dir, 'slot-0', 'pid'), '999999999');
    mk(j(dir, 'slot-1'));
    wf(j(dir, 'slot-1', 'pid'), '999999998');
    const d = await acquireSlot(dir, 2, 20);
    d();
  });
});

describe('jev fields, choices, items loading', () => {
  it('loadPapers carries jev_p and jev_rel', () => {
    const j = { top: [{ title: 'A', jev_p: 0.91, jev_rel: 'high' }, { title: 'B' }] };
    const p = loadPapers(JSON.stringify(j), 5);
    assert.equal(p[0].jev_p, 0.91);
    assert.equal(p[0].jev_rel, 'high');
    assert.equal(p[1].jev_p, null);
    assert.ok(!('jev_rel' in p[1]));
    assert.equal(loadPapers('10.1/a\n', 5)[0].jev_p, null);
  });
  it('parseChoices: default, jev.mjs syntax, errors', () => {
    assert.deepEqual(parseChoices(undefined).map((c) => c.id), ['yes', 'partly', 'no']);
    assert.deepEqual(parseChoices(['a: first one', 'b-2 : second']), [{ id: 'a', meaning: 'first one' }, { id: 'b-2', meaning: 'second' }]);
    assert.throws(() => parseChoices(['no colon here']), /id: meaning/);
    assert.throws(() => parseChoices(['a: x', 'a: y']), /distinct/);
  });
  it('parseArgs: --choice repeats', () => {
    assert.deepEqual(parseArgs(['--items', 'd', '--choice', 'a: x', '--choice', 'b: y']),
      { items: 'd', choice: ['a: x', 'b: y'] });
  });
  it('listTextFiles: recursive, sorted, skips dot-dirs, node_modules, NUL files; capped', () => {
    const d = mkdtempSync(join(tmpdir(), 'rs-ls-'));
    for (const x of ['.git', 'node_modules', 'sub', 'sub/.cache']) mkdirSync(join(d, x));
    writeFileSync(join(d, 'b.txt'), 'b');
    writeFileSync(join(d, 'a.md'), 'a');
    writeFileSync(join(d, 'sub', 'c.py'), 'c');
    writeFileSync(join(d, '.git', 'x'), 'x');
    writeFileSync(join(d, 'node_modules', 'y.js'), 'y');
    writeFileSync(join(d, 'sub', '.cache', 'z'), 'z');
    writeFileSync(join(d, 'bin.dat'), Buffer.from([65, 0, 66]));
    assert.deepEqual(listTextFiles(d, 60), ['a.md', 'b.txt', 'sub/c.py']);
    assert.deepEqual(listTextFiles(d, 2), ['a.md', 'b.txt']);
  });
  it('loadItems: jsonl with text, path relative to the file, missing path', () => {
    const d = mkdtempSync(join(tmpdir(), 'rs-li-'));
    writeFileSync(join(d, 'y.txt'), 'from file');
    writeFileSync(join(d, 'items.jsonl'), [{ id: 'x', text: 'inline' }, { id: 'y', path: 'y.txt' }, { id: 'z', path: 'gone.txt' }].map((o) => JSON.stringify(o)).join('\n') + '\n\n');
    const it = loadItems(join(d, 'items.jsonl'), 60);
    assert.deepEqual(it.map((x) => [x.id, x.raw_text]), [['x', 'inline'], ['y', 'from file'], ['z', null]]);
    assert.equal(it[2].fetch_status, 'missing');
    assert.equal(loadItems(join(d, 'items.jsonl'), 1).length, 1);
    writeFileSync(join(d, 'bad.jsonl'), '{"id":1}\nnot json\n');
    assert.throws(() => loadItems(join(d, 'bad.jsonl'), 60), /line 2/);
  });
  it('buildItemPrompt: generic, choice ids as verdicts, quotes for any verdict', () => {
    const pr = buildItemPrompt('Q', '', [{ id: 'src/a.js', text: 'T' }], parseChoices(['hit: relevant', 'miss: not']));
    assert.match(pr, /You read documents/);
    assert.match(pr, /"verdict":"hit"\|"miss"/);
    assert.match(pr, /- "hit": relevant/);
    assert.match(pr, /0 to 3 per document, for any verdict/);
    assert.doesNotMatch(pr, /empty quotes list/);
    assert.match(pr, /=== P1 \| src\/a\.js ===\nT/);
  });
});

// End-to-end with a fake claude CLI on PATH and a fake getpaper: no network, no model calls.
function rig() {
  const d = mkdtempSync(join(tmpdir(), 'rs-e2e-'));
  const claudeLog = join(d, 'claude.log');
  // verdict from VERDICT=<v> in the paper text, one quote from QUOTE<...>
  writeFileSync(join(d, 'claude'), `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\\n');
const parts = prompt.split(/^=== (P\\d+) \\|.*$/m);
const rows = [];
for (let k = 1; k < parts.length; k += 2) {
  const v = (parts[k + 1].match(/VERDICT=(\\w+)/) || [])[1] || 'no';
  const q = (parts[k + 1].match(/QUOTE<([^>]+)>/) || [])[1];
  rows.push({ pid: parts[k], verdict: v, claim: 'claim ' + v, quotes: q ? [q] : [] });
}
process.stdout.write(JSON.stringify({ result: JSON.stringify(rows), usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-haiku-5-5': {} } }));
`);
  chmodSync(join(d, 'claude'), 0o755);
  const fulltexts = {};
  const setFulltext = (id, text) => {
    fulltexts[id] = join(d, `ft-${Object.keys(fulltexts).length}.txt`);
    writeFileSync(fulltexts[id], text);
    writeFileSync(join(d, 'fake-getpaper.mjs'), `const m = ${JSON.stringify(fulltexts)};
const p = m[process.argv[2]];
console.log(JSON.stringify(p ? { status: 'ok', text_path: p } : { status: 'not_found' }));
`);
  };
  setFulltext('none', '');
  const run = (args) => promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '..', 'readswarm.mjs'), '--backend', 'cli', '--out', join(d, 'o'), ...args], {
    cwd: d,
    env: { ...process.env, PATH: `${d}${delimiter}${process.env.PATH}`, SWARM_SPEND_LEDGER: join(d, 'spend.jsonl'), READSWARM_SLOT_DIR: join(d, 'slots'),
      READSWARM_GETPAPER_SCRIPT: join(d, 'fake-getpaper.mjs') },
  });
  const out = (f) => readFileSync(join(d, 'o', f), 'utf8');
  const results = () => out('results.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const logs = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { d, run, out, results, setFulltext, claudeCalls: () => logs(claudeLog) };
}

describe('readswarm end to end (fake claude, getpaper)', () => {
  it('abstract never counts as read; jev_p carried; Jev vs Haiku; not read in full sorted by jev_p', async () => {
    const r = rig();
    r.setFulltext('10.1/a', 'Paper A full text. VERDICT=no');
    r.setFulltext('10.1/b', 'Paper B full text. VERDICT=answers QUOTE<the forward weights align with the feedback weights>');
    const j = { top: [
      { title: 'A', year: 2020, doi: '10.1/a', jev_p: 0.9, jev_rel: 'high' },
      { title: 'B', year: 2021, doi: '10.1/b', jev_p: 0.1 },
      { title: 'C', year: 2022, doi: '10.1/c', jev_p: 0.6, abstract: 'abstract C ABSMARK VERDICT=answers' },
      { title: 'D', year: 2023, doi: '10.1/d', jev_p: 0.95, abstract: 'abstract D ABSMARK' },
      { title: 'E', year: 2024 },
    ] };
    writeFileSync(join(r.d, 'in.json'), JSON.stringify(j));
    await r.run(['--q', 'Q', '--in', join(r.d, 'in.json')]);
    const calls = r.claudeCalls();
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].prompt, /ABSMARK/);
    assert.match(calls[0].prompt, /You read scientific papers|Research question/);
    const res = r.results();
    assert.deepEqual(res.map((x) => [x.title, x.verdict, x.not_read ?? null, x.jev_p]),
      [['A', 'no', null, 0.9], ['B', 'answers', null, 0.1], ['C', null, 'abstract only', 0.6], ['D', null, 'abstract only', 0.95], ['E', null, 'no text', null]]);
    assert.equal(res[0].jev_rel, 'high');
    assert.equal(res[1].quotes[0].check, 'exact');
    assert.equal(res[2].fetch_status, 'not_found');
    assert.equal(res[4].fetch_status, 'no-id');
    assert.ok(!('fetch_status' in res[0]));
    const run = JSON.parse(r.out('run.json'));
    assert.deepEqual(run.fulltext, { read: 2, abstract_only: 2, none: 1, share: 0.4 });
    const dg = r.out('digest.md');
    assert.match(dg, /^- full text: 2 of 5 read in full \(abstract only 2, no text 1\)$/m);
    assert.match(dg, /^- verdicts \(full text only\): answers 1, partly 0, background 0, no 1, failed 0$/m);
    assert.match(dg, /^- sources: fulltext 2, abstract 2, none 1$/m);
    const jv = dg.slice(dg.indexOf('## Jev vs Haiku'), dg.indexOf('## not read in full'));
    assert.match(jv, /A \(2020\) doi:10\.1\/a: verdict no, jev_p 0\.90/);
    assert.match(jv, /B \(2021\) doi:10\.1\/b: verdict answers, jev_p 0\.10/);
    const nr = dg.slice(dg.indexOf('## not read in full')).split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(nr, ['- D (2023) doi:10.1/d; jev_p 0.95; abstract only', '- C (2022) doi:10.1/c; jev_p 0.60; abstract only', '- E (2024) ; no text']);
  });
  it('no Jev vs Haiku section when nothing disagrees', async () => {
    const r = rig();
    r.setFulltext('10.1/a', 'VERDICT=partly');
    writeFileSync(join(r.d, 'in.json'), JSON.stringify({ top: [{ title: 'A', doi: '10.1/a', jev_p: 0.9 }] }));
    await r.run(['--q', 'Q', '--in', join(r.d, 'in.json')]);
    assert.doesNotMatch(r.out('digest.md'), /Jev vs Haiku|not read in full/);
  });
  it('--items directory with --choice', async () => {
    const r = rig();
    const docs = join(r.d, 'docs');
    for (const x of ['', 'sub', '.git', 'node_modules']) mkdirSync(join(docs, x), { recursive: true });
    writeFileSync(join(docs, 'a.txt'), 'Doc a says VERDICT=relevant QUOTE<the cache is flushed on every write>');
    writeFileSync(join(docs, 'sub', 'b.md'), 'Doc b VERDICT=irrelevant');
    writeFileSync(join(docs, 'e.txt'), '   \n');
    writeFileSync(join(docs, '.git', 'x'), 'git');
    writeFileSync(join(docs, 'node_modules', 'y.js'), 'dep');
    writeFileSync(join(docs, 'bin.dat'), Buffer.from([1, 0, 2]));
    await r.run(['--q', 'Q', '--items', docs, '--choice', 'relevant: about caching', '--choice', 'irrelevant: not about caching']);
    const calls = r.claudeCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argv[calls[0].argv.indexOf('--system-prompt') + 1], 'You read documents and answer only in the requested JSON.');
    assert.match(calls[0].prompt, /"verdict":"relevant"\|"irrelevant"/);
    const res = r.results();
    assert.deepEqual(res.map((x) => [x.id, x.verdict, x.not_read ?? null]),
      [['a.txt', 'relevant', null], ['e.txt', null, 'no text'], ['sub/b.md', 'irrelevant', null]]);
    assert.equal(res[0].quotes[0].check, 'exact');
    const dg = r.out('digest.md');
    assert.ok(dg.indexOf('## relevant') < dg.indexOf('## irrelevant'));
    assert.match(dg, /^### sub\/b\.md$/m);
    assert.match(dg, /^- read: 2 of 3 items \(no text 1\)$/m);
    assert.match(dg, /^- verdicts: relevant 1, irrelevant 1, failed 0$/m);
    assert.match(dg, /## not read in full\n\n- e\.txt; no text/);
    assert.doesNotMatch(dg, /Jev vs Haiku/);
  });
  it('--items jsonl with default choices; --in and --items exclusive, one required', async () => {
    const r = rig();
    writeFileSync(join(r.d, 'y.txt'), 'file text VERDICT=partly');
    writeFileSync(join(r.d, 'items.jsonl'), [{ id: 'x', text: 'inline VERDICT=yes' }, { id: 'y', path: 'y.txt' }, { id: 'z', path: 'gone.txt' }].map((o) => JSON.stringify(o)).join('\n'));
    await r.run(['--q', 'Q', '--items', join(r.d, 'items.jsonl')]);
    assert.match(r.claudeCalls()[0].prompt, /"verdict":"yes"\|"partly"\|"no"/);
    const res = r.results();
    assert.deepEqual(res.map((x) => [x.id, x.verdict, x.not_read ?? null, x.fetch_status ?? null]),
      [['x', 'yes', null, null], ['y', 'partly', null, null], ['z', null, 'no text', 'missing']]);
    const both = await r.run(['--q', 'Q', '--items', join(r.d, 'items.jsonl'), '--in', join(r.d, 'items.jsonl')]).then(() => null, (x) => x);
    assert.equal(both?.code, 2);
    assert.match(both.stderr, /mutually exclusive/);
    const none = await r.run(['--q', 'Q']).then(() => null, (x) => x);
    assert.equal(none?.code, 2);
    assert.match(none.stderr, /--in or --items is required/);
  });
});

describe('getpaper ids', () => {
  it('passes every id, best first, the rest as --also', async () => {
    const { fetchIdsOf, getpaperArgs } = await import('../readswarm.mjs');
    const ids = fetchIdsOf({ arxiv: '2401.00001', doi: '10.1/x', openalex: 'W1', raw_id: null });
    assert.deepEqual(ids, ['2401.00001', '10.1/x', 'W1']);
    assert.deepEqual(getpaperArgs(ids), ['2401.00001', '--also', '10.1/x', '--also', 'W1']);
    assert.deepEqual(getpaperArgs(fetchIdsOf({ doi: '10.1/x' })), ['10.1/x']);
  });
});
