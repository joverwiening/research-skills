/**
 * Offline tests for swarm-call.mjs and the backend parts of readswarm.mjs: a local mock HTTP server stands
 * in for the API, a shell script for the claude CLI. No live API or model calls.
 * Run: node --test test/swarm-call.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { priceUsage, estimateUsd, monthToDate, createBudget, apiMessage, batchRun, messageParams } from '../swarm-call.mjs';
import { callCharCap, resolveBackend } from '../readswarm.mjs';

const KEY = 'sk-test-swarm-0123456789';
const rowsText = (verdict = 'background') => JSON.stringify([{ pid: 'P1', verdict, claim: 'c', quotes: [] }]);
let server;
let base;
let handler = () => {};
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const r = handler(req, body ? JSON.parse(body) : null) || { status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'x' } } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.raw ?? JSON.stringify(r.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const msg = (text, usage = { input_tokens: 1000, output_tokens: 200 }) => ({ status: 200, json: { type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } });

describe('prices and ledger', () => {
  it('Haiku 5.5 tiers at 100k prompt tokens, batch half', () => {
    assert.equal(priceUsage('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 0 }), 0.5);
    assert.ok(Math.abs(priceUsage('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1e6 }) - 0.51) < 1e-9);
    assert.ok(Math.abs(priceUsage('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1e6 }, { batch: true }) - 0.255) < 1e-9);
    assert.ok(Math.abs(priceUsage('claude-haiku-5-5', { input_tokens: 100001, output_tokens: 0 }) - 0.0500005) < 1e-9);
    assert.equal(priceUsage('claude-unknown', { input_tokens: 1 }), null);
    assert.ok(estimateUsd('claude-haiku-5-5', 200000, 16000) > 0);
  });
  it('month-to-date counts this month only; cap refuses', () => {
    const d = mkdtempSync(join(tmpdir(), 'sc-led-'));
    const led = join(d, 'spend.jsonl');
    const now = new Date('2026-10-08T12:00:00Z');
    writeFileSync(led, [{ ts: '2026-09-30T23:00:00Z', usd: 100 }, { ts: '2026-10-01T01:00:00Z', usd: 149.99 }].map((x) => JSON.stringify(x)).join('\n') + '\n');
    assert.ok(Math.abs(monthToDate(led, now) - 149.99) < 1e-9);
    const b = createBudget({ ledger: led, cap: 150, now: () => now });
    assert.equal(b.tryReserve(0.005), true);
    assert.equal(b.tryReserve(0.006), false);
    b.settle(0.005, { run: 'r', backend: 'api', usd: 0.004 });
    const last = JSON.parse(readFileSync(led, 'utf8').trim().split('\n').at(-1));
    assert.equal(last.backend, 'api');
    assert.equal(last.ts, now.toISOString());
  });
});

describe('api backend (mock server)', () => {
  it('headers, body, thinking only for Haiku 5.5', async () => {
    seen.length = 0;
    handler = () => msg(rowsText());
    const r = await apiMessage({ base, key: KEY, model: 'claude-haiku-5-5', system: 'S', prompt: 'P', maxTokens: 100 });
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(r.text)[0].pid, 'P1');
    assert.equal(r.usage.output_tokens, 200);
    const q = seen[0];
    assert.equal(q.url, '/v1/messages');
    assert.equal(q.headers['x-api-key'], KEY);
    assert.equal(q.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(q.body.thinking, { type: 'disabled' });
    assert.deepEqual(q.body.messages, [{ role: 'user', content: 'P' }]);
    assert.equal(messageParams('claude-sonnet-5-5', 'S', 'P', 10).thinking, undefined);
  });
  it('529 and 429 with retry-after are retried', async () => {
    seen.length = 0;
    let n = 0;
    handler = () => (++n === 1 ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'o' } } }
      : n === 2 ? { status: 429, headers: { 'retry-after': '0' }, json: { type: 'error', error: { type: 'rate_limit_error', message: 'r' } } } : msg(rowsText()));
    const r = await apiMessage({ base, key: KEY, model: 'claude-haiku-5-5', system: 'S', prompt: 'P', maxTokens: 100, backoffMs: 5 });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 3);
  });
  it('429 without retry-after is the spend cap: no retry', async () => {
    seen.length = 0;
    handler = () => ({ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'spend cap' } } });
    const r = await apiMessage({ base, key: KEY, model: 'claude-haiku-5-5', system: 'S', prompt: 'P', maxTokens: 100, backoffMs: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.spendCap, true);
    assert.equal(seen.length, 1);
  });
});

describe('batch backend (mock server)', () => {
  it('create, poll, results by custom_id', async () => {
    seen.length = 0;
    let polls = 0;
    handler = (req, body) => {
      if (req.method === 'POST' && req.url === '/v1/messages/batches') {
        assert.equal(body.requests.length, 2);
        assert.equal(body.requests[0].params.model, 'claude-haiku-5-5');
        return { status: 200, json: { id: 'msgbatch_1', type: 'message_batch', processing_status: 'in_progress', results_url: null } };
      }
      if (req.url === '/v1/messages/batches/msgbatch_1') {
        return { status: 200, json: { id: 'msgbatch_1', processing_status: ++polls < 2 ? 'in_progress' : 'ended', results_url: `${base}/v1/messages/batches/msgbatch_1/results` } };
      }
      if (req.url === '/v1/messages/batches/msgbatch_1/results') {
        return { status: 200, raw: [
          { custom_id: 'call-2', result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } } },
          { custom_id: 'call-1', result: { type: 'succeeded', message: msg(rowsText()).json } },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n' };
      }
      return null;
    };
    const reqs = ['call-1', 'call-2'].map((c) => ({ custom_id: c, model: 'claude-haiku-5-5', system: 'S', prompt: 'P', maxTokens: 100 }));
    const r = await batchRun({ base, key: KEY, requests: reqs, pollMs: 5, backoffMs: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.results.get('call-1').ok, true);
    assert.equal(r.results.get('call-1').usage.input_tokens, 1000);
    assert.match(r.results.get('call-2').error, /errored: invalid_request_error/);
    assert.ok(seen.every((q) => q.headers['x-api-key'] === KEY && q.headers['anthropic-version'] === '2023-06-01'));
  });
});

describe('readswarm backend choice, char cap, fallback', () => {
  it('char cap per backend', () => {
    assert.equal(callCharCap('cli'), 350000);
    assert.equal(callCharCap('api'), 200000);
    assert.equal(callCharCap('batch'), 200000);
  });
  it('resolveBackend', () => {
    assert.deepEqual(resolveBackend('api', { key: null, monthToDate: 0, cap: 150 }), { backend: 'cli', reason: 'ANTHROPIC_API_KEY not set' });
    assert.deepEqual(resolveBackend('api', { key: KEY, monthToDate: 0, cap: 150 }), { backend: 'api', reason: null });
    assert.equal(resolveBackend('api', { key: KEY, monthToDate: 150, cap: 150 }).backend, 'cli');
    assert.match(resolveBackend('api', { key: KEY, monthToDate: 150, cap: 150 }).reason, /monthly cap/);
    assert.equal(resolveBackend('batch', { key: KEY, monthToDate: 0, cap: 150 }).backend, 'batch');
    assert.equal(resolveBackend('batch', { key: null, monthToDate: 0, cap: 150 }).backend, 'cli');
    assert.equal(resolveBackend('cli', { key: KEY, monthToDate: 0, cap: 150 }).backend, 'cli');
  });
  it('api run falls back to cli mid-run when the cap is hit; run.json, digest, ledger', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rs-fb-'));
    const papers = { top: [1, 2, 3].map((k) => ({ rank: k, title: `T${k}`, doi: `10.1/t${k}`, abstract: `Abstract number ${k} about learning in networks.` })) };
    writeFileSync(join(d, 'in.json'), JSON.stringify(papers));
    // only full text is read: a fake getpaper hands back a text file for every id
    writeFileSync(join(d, 'paper.txt'), 'Full text about learning in networks.');
    writeFileSync(join(d, 'getpaper.mjs'), `console.log(JSON.stringify({ status: 'ok', text_path: ${JSON.stringify(join(d, 'paper.txt'))} }));\n`);
    writeFileSync(join(d, 'cli.json'), JSON.stringify({ result: rowsText('no'), usage: { input_tokens: 5, output_tokens: 5 }, modelUsage: { 'claude-haiku-5-5': {} } }));
    writeFileSync(join(d, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat ${join(d, 'cli.json')}\n`);
    chmodSync(join(d, 'claude'), 0o755);
    // one api call costs ~0.01 (20000 output tokens); the estimate is ~0.008; cap 0.012 lets exactly one through
    writeFileSync(join(d, '.env'), `ANTHROPIC_API_KEY=${KEY}\nREADSWARM_MONTHLY_CAP_USD=0.012\n`);
    handler = () => msg(rowsText(), { input_tokens: 1000, output_tokens: 20000 });
    const led = join(d, 'spend.jsonl');
    const env = { ...process.env, PATH: `${d}${delimiter}${process.env.PATH}`, SWARM_API_BASE: base, SWARM_SPEND_LEDGER: led, READSWARM_SLOT_DIR: join(d, 'slots'),
      READSWARM_GETPAPER_SCRIPT: join(d, 'getpaper.mjs') };
    delete env.ANTHROPIC_API_KEY;
    delete env.READSWARM_MONTHLY_CAP_USD;
    await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '..', 'readswarm.mjs'), '--q', 'Q', '--in', join(d, 'in.json'), '--out', join(d, 'o'),
      '--per-call', '1', '--concurrency', '1', '--backend', 'api'], { cwd: d, env });
    const run = JSON.parse(readFileSync(join(d, 'o', 'run.json'), 'utf8'));
    assert.equal(run.backend.start, 'api');
    assert.deepEqual(run.calls.map((c) => c.backend), ['api', 'cli', 'cli']);
    assert.equal(run.backend.fallback.from_call, 2);
    assert.match(run.backend.fallback.reason, /monthly cap/);
    assert.ok(run.totals.api_spend_usd > 0.009);
    const lines = readFileSync(led, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].backend, 'api');
    assert.equal(lines[0].output_tokens, 20000);
    assert.match(readFileSync(join(d, 'o', 'digest.md'), 'utf8'), /backend: api; fell back to cli from call 2/);
    assert.doesNotMatch(readFileSync(join(d, 'o', 'run.json'), 'utf8'), new RegExp(KEY));
    const res = readFileSync(join(d, 'o', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(res.map((r) => r.verdict), ['background', 'no', 'no']);
  });
});
