/**
 * Model-call layer for readswarm: three backends.
 *   cli    one `claude -p` per call through the claude CLI on PATH, with the user's own login; machine-wide slot cap.
 *   api    Messages API, key ANTHROPIC_API_KEY (environment or ./.env).
 *   batch  Message Batches API, same key, half price, async.
 * api and batch spend goes to a ledger (~/.cache/lit-search/swarm-api-spend.jsonl); a monthly cap refuses calls
 * before they are sent.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';

export const STATE_DIR = join(homedir(), '.cache', 'lit-search');

export function readEnvFile(f) {
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// --- cli ----------------------------------------------------------------------------------

// Several readswarm runs can share a machine, so the CLI calls share a machine-wide cap: a slot is a
// directory under SLOT_DIR, taken by an atomic mkdir. One call uses ~1.5 s CPU per ~40 s.
const SLOT_DIR = process.env.READSWARM_SLOT_DIR || join(tmpdir(), 'readswarm-slots');
const MAX_SLOTS = Number(process.env.READSWARM_MAX_CALLS) || 8;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export async function acquireSlot(dir = SLOT_DIR, max = MAX_SLOTS, pollMs = 500) {
  mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let k = 0; k < max; k++) {
      const d = join(dir, `slot-${k}`);
      try {
        mkdirSync(d);
        writeFileSync(join(d, 'pid'), String(process.pid));
        return () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // reclaim slots of dead owners; a slot with no pid file yet is only stale after a minute
        let pid = 0;
        try { pid = Number(readFileSync(join(d, 'pid'), 'utf8')); } catch { /* not written yet */ }
        let old = false;
        try { old = Date.now() - statSync(d).mtimeMs > 60000; } catch { /* just released */ }
        if ((pid && !pidAlive(pid)) || (!pid && old)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* raced */ } }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function runChild(cmd, argv, { env, cwd, input, ms }) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { env, cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const t = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, ms);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); res({ code, out, err, killed, ms: Date.now() - t0 }); });
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e), killed, ms: Date.now() - t0 }); });
    if (input != null) {
      p.stdin.on('error', () => { /* child died early; reported via close */ });
      p.stdin.end(input);
    }
  });
}

export const CLI = 'claude';

export function cliEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // with ANTHROPIC_API_KEY in its env the CLI bills the API instead of the login; --backend api is for that
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// --- prices, ledger, cap ------------------------------------------------------------------

// USD per MTok, https://platform.claude.com/docs/en/about-claude/pricing. Haiku 5.5 is priced by
// prompt length (input + cache write + cache read tokens): over 100,000 tokens the higher row applies. Batch: half.
export const PRICES = {
  'claude-haiku-5-5': {
    low: { in: 0.10, cache_write: 0.125, cache_read: 0.01, out: 0.50 },
    high: { in: 0.50, cache_write: 0.625, cache_read: 0.05, out: 2.50 },
    tier_tokens: 100000,
  },
};

export function priceUsage(model, u, { batch = false } = {}) {
  const p = PRICES[model];
  if (!p) return null;
  const inTok = u.input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const r = inTok + cw + cr > p.tier_tokens ? p.high : p.low;
  const usd = (inTok * r.in + cw * r.cache_write + cr * r.cache_read + (u.output_tokens || 0) * r.out) / 1e6;
  return batch ? usd / 2 : usd;
}

// Conservative: 2 chars per token (paper text runs ~2.4) and the full max_tokens of output.
export function estimateUsd(model, promptChars, maxTokens, { batch = false } = {}) {
  return priceUsage(model, { input_tokens: Math.ceil(promptChars / 2), output_tokens: maxTokens }, { batch });
}

export function monthToDate(ledger, now = new Date()) {
  if (!existsSync(ledger)) return 0;
  const month = now.toISOString().slice(0, 7);
  let s = 0;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (String(r.ts).slice(0, 7) === month) s += Number(r.usd) || 0;
    } catch { /* skip a torn line */ }
  }
  return s;
}

export function appendLedger(ledger, rec) {
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify(rec) + '\n');
}

// In-process reservations keep concurrent calls of one run from overshooting the cap together.
export function createBudget({ ledger, cap, now = () => new Date() }) {
  let reserved = 0;
  return {
    cap,
    monthToDate: () => monthToDate(ledger, now()),
    tryReserve(est) {
      if (monthToDate(ledger, now()) + reserved + est > cap) return false;
      reserved += est;
      return true;
    },
    settle(est, rec) {
      reserved = Math.max(0, reserved - est);
      if (rec) appendLedger(ledger, { ts: now().toISOString(), ...rec });
    },
  };
}

// --- api ----------------------------------------------------------------------------------

export const API_BASE_DEFAULT = 'https://api.anthropic.com';
// https://platform.claude.com/docs/en/api/messages (headers x-api-key, anthropic-version 2023-06-01, content-type)
const API_VERSION = '2023-06-01';
const headers = (key) => ({ 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' });

// https://platform.claude.com/docs/en/api/errors: "Claude Haiku 5.5 accepts thinking: {"type": "disabled"}" (at the
// default effort; xhigh/max would 400). Other models get no thinking param: several 400 on "disabled".
const THINKING_OFF_OK = new Set(['claude-haiku-5-5']);

export function messageParams(model, system, prompt, maxTokens) {
  return {
    model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }],
    ...(THINKING_OFF_OK.has(model) ? { thinking: { type: 'disabled' } } : {}),
  };
}

export const textOf = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// https://platform.claude.com/docs/en/api/errors: 429 rate_limit_error carries retry-after; a 429 without it is the
// org spend cap and keeps failing (no retry). 500 api_error, 504 timeout_error, 529 overloaded_error: retry with backoff.
const RETRY_STATUS = new Set([500, 502, 503, 504, 529]);

async function httpJson(url, { method = 'GET', key, body, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: headers(key), body: body == null ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* jsonl or html */ }
    return { status: r.status, retryAfter: r.headers.get('retry-after'), text, json };
  } finally { clearTimeout(t); }
}

// Retries transient failures; returns { status, json, text } of the last response or { error } when the network failed.
async function withRetries(fn, { retries = 4, backoffMs = 2000 } = {}) {
  let last = null;
  for (let k = 0; k <= retries; k++) {
    try {
      last = await fn();
    } catch (e) {
      last = { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
    }
    const overloaded = last.json?.error?.type === 'overloaded_error';
    const retryable = last.error || RETRY_STATUS.has(last.status) || overloaded || (last.status === 429 && last.retryAfter != null);
    if (!retryable || k === retries) break;
    const ra = Number(last.retryAfter);
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120000) : backoffMs * 2 ** k);
  }
  return last;
}

const errText = (r) => (r.error ? `api: ${r.error}`
  : `api ${r.status}: ${r.json?.error?.type || ''} ${String(r.json?.error?.message || r.text || '').slice(0, 200)}`.replace(/\s+/g, ' ').trim());

// Result: { ok, text, usage, model, stop_reason, error, spendCap }.
export async function apiMessage({ base = API_BASE_DEFAULT, key, model, system, prompt, maxTokens, timeoutMs = 300000, retries, backoffMs }) {
  const r = await withRetries(() => httpJson(`${base}/v1/messages`, { method: 'POST', key, body: messageParams(model, system, prompt, maxTokens), timeoutMs }), { retries, backoffMs });
  if (r.status === 200 && r.json) {
    return { ok: true, text: textOf(r.json), usage: r.json.usage || {}, model: r.json.model || model, stop_reason: r.json.stop_reason ?? null, error: null, spendCap: false };
  }
  return { ok: false, text: '', usage: null, model, error: errText(r), spendCap: r.status === 429 && r.retryAfter == null };
}

// --- batch --------------------------------------------------------------------------------

// https://platform.claude.com/docs/en/build-with-claude/batch-processing: POST /v1/messages/batches
// {requests: [{custom_id, params}]} → {id, processing_status: "in_progress"}; GET /v1/messages/batches/{id} until
// processing_status "ended"; then GET results_url → .jsonl, one {custom_id, result: {type: succeeded|errored|canceled|
// expired, message | error}} per line, in any order.
// requests: [{ custom_id, model, system, prompt, maxTokens }]. Result: { ok, error, spendCap, id, results: Map }.
export async function batchRun({ base = API_BASE_DEFAULT, key, requests, pollMs = 60000, maxWaitMs = 25 * 3600 * 1000, timeoutMs = 300000, retries, backoffMs, onStatus = () => {} }) {
  const body = { requests: requests.map((q) => ({ custom_id: q.custom_id, params: messageParams(q.model, q.system, q.prompt, q.maxTokens) })) };
  const c = await withRetries(() => httpJson(`${base}/v1/messages/batches`, { method: 'POST', key, body, timeoutMs }), { retries, backoffMs });
  if (c.status !== 200 || !c.json?.id) return { ok: false, error: errText(c), spendCap: c.status === 429 && c.retryAfter == null, results: new Map() };
  const id = c.json.id;
  let b = c.json;
  const t0 = Date.now();
  while (b.processing_status !== 'ended') {
    if (Date.now() - t0 > maxWaitMs) return { ok: false, id, error: `batch ${id} not ended after ${Math.round(maxWaitMs / 1000)} s`, spendCap: false, results: new Map() };
    await sleep(pollMs);
    const g = await withRetries(() => httpJson(`${base}/v1/messages/batches/${id}`, { key, timeoutMs }), { retries, backoffMs });
    if (g.status !== 200 || !g.json) return { ok: false, id, error: errText(g), spendCap: false, results: new Map() };
    b = g.json;
    onStatus(b);
  }
  // the key goes only to the API host
  if (!b.results_url || new URL(b.results_url, base).origin !== new URL(base).origin) {
    return { ok: false, id, error: `batch ${id}: no usable results_url`, spendCap: false, results: new Map() };
  }
  const rr = await withRetries(() => httpJson(new URL(b.results_url, base).href, { key, timeoutMs }), { retries, backoffMs });
  if (rr.status !== 200) return { ok: false, id, error: errText(rr), spendCap: false, results: new Map() };
  const results = new Map();
  for (const line of rr.text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const res = o.result || {};
    if (res.type === 'succeeded') {
      results.set(o.custom_id, { ok: true, text: textOf(res.message), usage: res.message?.usage || {}, model: res.message?.model, error: null });
    } else {
      const e = res.error?.error || res.error || {};
      results.set(o.custom_id, { ok: false, text: '', usage: null, error: `batch ${res.type || 'unknown'}${e.type ? `: ${e.type} ${String(e.message || '').slice(0, 160)}` : ''}`.trim() });
    }
  }
  return { ok: true, id, error: null, spendCap: false, results };
}
