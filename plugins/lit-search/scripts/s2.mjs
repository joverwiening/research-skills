#!/usr/bin/env node
/**
 * s2 — Semantic Scholar search, lookup, citation graph and recommendations.
 *
 * SEMANTIC_SCHOLAR_API_KEY (optional; from the environment or ./.env) travels only in the x-api-key
 * header and is never printed. Without it requests run anonymously and 429 often. S2 allows a key
 * 1 request/s across all processes using it, so every HTTP attempt (retries included) passes a
 * cross-process throttle in ~/.cache/lit-search/s2-rate/ (S2_RATE_DIR overrides). Even keyed, about
 * 1 in 3 search calls at 4 s spacing get 429, so 429/5xx back off 2, 4, 8, 16 s.
 *
 * Usage:
 *   node s2.mjs search "<query>" [--n 25] [--from YEAR] [--to YEAR]
 *   node s2.mjs paper <id>
 *   node s2.mjs refs <id> [--n 50]
 *   node s2.mjs cites <id> [--n 25]
 *   node s2.mjs recs <id> [--n 20]
 *   any command: [--full-abstract]
 * <id>: S2 paperId, DOI, arXiv id, CorpusId:N, PMID:N, PMCID:...
 *
 * Optional: LIT_SEARCH_EMAIL goes into the User-Agent.
 * Prints one JSON object. Exit 0 ok, 1 not found, 2 error / bad args.
 */
import { readFileSync, existsSync, mkdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function loadEnvKeys(names) {
  const f = join(process.cwd(), '.env');
  if (!existsSync(f)) return;
  const want = new Set(names.filter((n) => !process.env[n]));
  if (!want.size) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && want.has(m[1])) process.env[m[1]] = m[2];
  }
}
loadEnvKeys(['SEMANTIC_SCHOLAR_API_KEY', 'LIT_SEARCH_EMAIL']);

const KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || '';
const EMAIL = process.env.LIT_SEARCH_EMAIL || '';
const API = 'https://api.semanticscholar.org';
const TIMEOUT_MS = 30000;
const BACKOFF_S = [2, 4, 8, 16];
const MIN_SPACING_MS = 1100;
const LOCK_STALE_MS = 15000;
const RATE_DIR = process.env.S2_RATE_DIR || join(homedir(), '.cache', 'lit-search', 's2-rate');
const LOCK = join(RATE_DIR, 'lock');
const LAST = join(RATE_DIR, 'last');
const FIELDS = 'paperId,externalIds,title,year,venue,citationCount,authors,abstract';
const USAGE = `usage:
  node s2.mjs search "<query>" [--n 25] [--from YEAR] [--to YEAR]
  node s2.mjs paper <id>
  node s2.mjs refs <id> [--n 50]
  node s2.mjs cites <id> [--n 25]
  node s2.mjs recs <id> [--n 20]
  any command: [--full-abstract]
  <id>: S2 paperId, DOI, arXiv id, CorpusId:N, PMID:N, PMCID:...
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (KEY ? String(s).split(KEY).join('<api_key>') : String(s));

function emit(obj, code) {
  process.stdout.write(redact(JSON.stringify(obj, null, 2)) + '\n');
  process.exit(code);
}
function fail(status, message) {
  emit({ error: 'request_failed', status, message: redact(message) }, 2);
}
function notFound(id) {
  emit({ error: 'not_found', id }, 1);
}
function usage(code) {
  process.stderr.write(USAGE);
  process.exit(code);
}

// --- cross-process throttle --------------------------------------------------

async function acquireLock() {
  mkdirSync(RATE_DIR, { recursive: true });
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) rmdirSync(LOCK);
    } catch {
      // another process released or cleared it between our calls
    }
    await sleep(50 + Math.random() * 50);
  }
}

async function throttle() {
  await acquireLock();
  try {
    let last = 0;
    try {
      last = Number(readFileSync(LAST, 'utf8').trim()) || 0;
    } catch {
      // first call ever
    }
    const wait = last + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    writeFileSync(LAST, String(Date.now()));
  } finally {
    try {
      rmdirSync(LOCK);
    } catch {
      // cleared as stale by another process
    }
  }
}

/** GET with timeout, throttle and 429/5xx backoff. Returns {status, body} or fails. */
async function httpGet(url, headers) {
  for (let i = 0; ; i++) {
    await throttle();
    let r;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      fail(0, `${new URL(url).host}: ${e.message || e}`);
    }
    const body = await r.text();
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable) return { status: r.status, body };
    if (i >= BACKOFF_S.length) {
      if (r.status === 429) fail(429, `rate-limited after ${BACKOFF_S.length} retries: ${body.slice(0, 300)}`);
      return { status: r.status, body };
    }
    const after = Number(r.headers.get('retry-after'));
    const s = Math.min(Number.isFinite(after) && after > 0 ? after : BACKOFF_S[i], 60);
    process.stderr.write(`s2: HTTP ${r.status}, retry ${i + 1}/${BACKOFF_S.length} in ${s}s\n`);
    await sleep(s * 1000);
  }
}

/** S2 call. 404 -> null; any other non-2xx -> fail(). */
async function s2(path, params = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const headers = { 'User-Agent': EMAIL ? `s2.mjs (mailto:${EMAIL})` : 's2.mjs' };
  if (KEY) headers['x-api-key'] = KEY;
  const r = await httpGet(u.toString(), headers);
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) fail(r.status, r.body.slice(0, 500));
  try {
    return JSON.parse(r.body);
  } catch {
    fail(r.status, `non-JSON response: ${r.body.slice(0, 200)}`);
  }
}

// --- identifiers -------------------------------------------------------------

export function parseId(raw) {
  const s = String(raw).trim();
  let m;
  if (/^[0-9a-f]{40}$/i.test(s)) return s;
  if (/^CorpusId:\d+$/i.test(s) || /^PMID:\d+$/i.test(s) || /^PMCID:\S+$/i.test(s)) return s;
  const a = s.replace(/^arxiv:/i, '');
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(a)) return 'ARXIV:' + a.replace(/v\d+$/, '');
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(a)) return 'ARXIV:' + a.replace(/v\d+$/, '');
  const d = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  if ((m = d.match(/^10\.48550\/arxiv\.(.+)$/i))) return 'ARXIV:' + m[1].replace(/v\d+$/, '');
  if (/^10\.\d{4,9}\/\S+$/.test(d)) return 'DOI:' + d.toLowerCase();
  return null;
}

const idPath = (id) => encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':');

// --- output shaping ----------------------------------------------------------

function shape(p, full) {
  const names = (p.authors || []).map((a) => a?.name).filter(Boolean);
  const authors = names.slice(0, 3);
  if (names.length > 3) authors.push('et al.');
  let abstract = p.abstract ?? null;
  if (abstract && !full && abstract.length > 700) abstract = abstract.slice(0, 700) + '…';
  return {
    id: p.paperId ?? null,
    doi: p.externalIds?.DOI ? String(p.externalIds.DOI).toLowerCase() : null,
    arxiv: p.externalIds?.ArXiv ?? null,
    title: p.title ?? null,
    year: p.year ?? null,
    venue: p.venue || null,
    cited_by: p.citationCount ?? null,
    authors,
    abstract,
  };
}

const byCited = (a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0);

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    if (a === '--full-abstract') flags.fullAbstract = true;
    else if (['--n', '--from', '--to'].includes(a)) {
      if (i + 1 >= argv.length) usage(2);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) usage(2);
    else pos.push(a);
  }
  return { pos, flags };
}

function intFlag(v, def, max) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) usage(2);
  return max ? Math.min(n, max) : n;
}

function yearFlag(v) {
  if (v === undefined) return undefined;
  if (!/^\d{4}$/.test(v)) usage(2);
  return Number(v);
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [command, arg] = pos;
  if (!command || !arg || pos.length > 2) usage(2);
  if (!KEY) process.stderr.write('s2: no SEMANTIC_SCHOLAR_API_KEY in env or ./.env — running anonymously (expect 429)\n');
  const full = !!flags.fullAbstract;
  const base = { command, query_or_id: arg };
  const done = (extra, papers) => emit({ ...base, ...extra, results: papers.map((p) => shape(p, full)) }, 0);

  if (command === 'search') {
    const n = intFlag(flags.n, 25, 100);
    const from = yearFlag(flags.from);
    const to = yearFlag(flags.to);
    let year;
    if (from || to) year = `${from ?? ''}-${to ?? ''}`;
    const res = await s2('/graph/v1/paper/search', { query: arg, limit: n, year, fields: FIELDS });
    return done({ total: res?.total ?? null }, res?.data || []);
  }

  if (flags.from || flags.to) usage(2);
  const id = parseId(arg);
  if (!id) notFound(arg);

  if (command === 'paper') {
    if (flags.n) usage(2);
    const p = await s2(`/graph/v1/paper/${idPath(id)}`, { fields: FIELDS });
    if (!p) notFound(arg);
    return done({ resolved: p.paperId ?? null }, [p]);
  }

  if (command === 'refs' || command === 'cites') {
    const refs = command === 'refs';
    const n = refs ? intFlag(flags.n, 50, 1000) : intFlag(flags.n, 25, 1000);
    const res = await s2(`/graph/v1/paper/${idPath(id)}/${refs ? 'references' : 'citations'}`, {
      limit: n, fields: FIELDS,
    });
    if (!res) notFound(arg);
    const papers = (res.data || []).map((e) => (refs ? e.citedPaper : e.citingPaper)).filter(Boolean);
    papers.sort(byCited);
    // Publishers can elide reference lists (Nature papers do): data comes back null
    // with a disclaimer, which would otherwise read as "cites nothing".
    const extra = {};
    if (res.data == null) {
      const why = res.citingPaperInfo?.openAccessPdf?.disclaimer?.match(/elided by the publisher: [^.]*/)?.[0];
      extra.note = `S2 returned no list${why ? ` (${why})` : ''}; try: node openalex.mjs ${command} ${arg}`;
    }
    return done(extra, papers);
  }

  if (command === 'recs') {
    const n = intFlag(flags.n, 20, 500);
    const p = await s2(`/graph/v1/paper/${idPath(id)}`, { fields: 'paperId' });
    if (!p?.paperId) notFound(arg);
    // The default pool ("recent") is often empty for older papers; "all-cs" usually is not. Try all-cs first.
    for (const pool of ['all-cs', 'recent']) {
      const res = await s2(`/recommendations/v1/papers/forpaper/${p.paperId}`, { from: pool, limit: n, fields: FIELDS });
      if (!res) notFound(arg);
      const recs = res.recommendedPapers || [];
      if (recs.length || pool === 'recent') return done({ resolved: p.paperId, pool }, recs);
    }
  }

  usage(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
