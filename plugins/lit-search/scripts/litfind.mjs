#!/usr/bin/env node
/**
 * litfind — literature search: retrieve candidates from several sources, grade each one against the
 * question, expand along the citation graph from the best ones, and print a ranked list.
 *
 * search   OpenAlex keyword search (one call per --kw, 100 hits), OpenAlex semantic search (--q and each
 *          --para, once unfiltered and once for the last two years, 50 hits each, 1 request/s limit; the
 *          year-filtered call often 504s and a keyword search stands in) and arXiv (first 3 --kw,
 *          last --recent-months) and alphaXiv discover_papers (one call: --q and the first 3 --kw, never --ctx; abstracts
 *          then from arXiv; skipped without ALPHAXIV_API_KEY). Missing abstracts are filled from Crossref where it has one.
 *          If OpenAlex returns almost nothing, Semantic Scholar search (s2.mjs) is added.
 * grade    every candidate:
 *            bm25   default without JEV_API_KEY: word overlap with question + context + keywords, fused with search rank.
 *            jev    default with JEV_API_KEY: Jev P(yes) "does this address the question, for this researcher",
 *                   --ctx as project_context. Ranks better than bm25, more so with 3-4 lines of --ctx.
 *                   ~15 papers/s, ~$0.03 per 1000 graded.
 *            haiku  only with --grader haiku: `claude -p --model haiku` (the claude CLI on PATH, your own login),
 *                   25 papers per call, 0-10. Ranked below bm25 in testing, uses subscription limits, takes 3-4 min.
 *          Jev calls have a 20 s timeout and 2 retries, and a breaker (12 failed calls before any success,
 *          8 papers in a row, or >25 % of 20+) moves the whole run to bm25.
 *          Scores from different graders are never mixed in one ranking; the output names the grader.
 * expand   references + 25 most-cited + 25 newest citers of the best-graded papers (P >= .5, at most 5 per
 *          hop, plus every --seed in hop 1), graded the same way. Hop 2 only if hop 1 put >= 2 new papers
 *          into the top --k. bm25 does one hop from its top 3 (raw search rank alone gives junk seeds).
 *
 * Keys, from the environment or ./.env: OPENALEX_API_KEY (required, free at openalex.org, settings → API key),
 * JEV_API_KEY, ALPHAXIV_API_KEY, SEMANTIC_SCHOLAR_API_KEY (optional). LIT_SEARCH_EMAIL (optional) is sent as
 * the OpenAlex / Crossref / arXiv mailto.
 *
 * Usage. A full run takes 1-3 min (with Claude Code's Bash tool, set timeout 300000).
 *   node litfind.mjs --q "<question>" --ctx "<3-4 lines: the project, why you are searching>" \
 *     --kw "<keywords>" [--kw ...] [--para "<paraphrase of q>"] [--seed <doi | arXiv id | W-id>] \
 *     [--exclude literature.md] [--from YEAR] [--to YEAR] [--k 30] [--tail 20] [--hops 2] \
 *     [--grader auto|jev|haiku|bm25] [--budget-s 240] [--out FILE] [--no-arxiv] [--no-alphaxiv] [--drop <id|title>]
 *     [--grade-frac 0.5]   share of each batch graded by Jev, best word-match first (the rest ranks below)
 * Full result (every candidate: score, grader, abstract, where it came from) goes to --out, default
 * ./litfind/<date>-<slug>.json. Stdout is the compact list. Exit 0 ok, 2 bad args, no OpenAlex key or nothing retrieved.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parseId, NO_KEY_MSG } from './openalex.mjs';

function readEnvFile() {
  const f = join(process.cwd(), '.env');
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ENVF = readEnvFile();
const setting = (k) => process.env[k] || ENVF[k] || '';
const OA_KEY = setting('OPENALEX_API_KEY');
// env wins even when empty, so JEV_API_KEY= on the command line forces bm25
const JEV_KEY = 'JEV_API_KEY' in process.env ? process.env.JEV_API_KEY : ENVF.JEV_API_KEY || '';
const AX_KEY = 'ALPHAXIV_API_KEY' in process.env ? process.env.ALPHAXIV_API_KEY : ENVF.ALPHAXIV_API_KEY || '';
const EMAIL = setting('LIT_SEARCH_EMAIL');
const UA = EMAIL ? `litfind (mailto:${EMAIL})` : 'litfind';
const SECRETS = [OA_KEY, JEV_KEY, AX_KEY].filter((s) => s && s.length > 8);
const redact = (s) => SECRETS.reduce((acc, k) => acc.split(k).join('<key>'), String(s));

// LITFIND_JEV_URL / LITFIND_CLAUDE_CLI exist so the fallbacks can be tested against a dead service.
const JEV_URL = process.env.LITFIND_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.13.0';
const JEV_CONC = 24; // 300 papers in ~19 s; 48 in flight is no faster
const JEV_TIMEOUT_MS = 20000; // single calls can hang 4-14 s on Jev's side
const HAIKU_BATCH = 25;
const HAIKU_CONC = 4;
const HAIKU_TIMEOUT_MS = 240000;
const OA_CAP_USD = 0.1;
const YEAR = new Date().getFullYear();
const OA_SELECT = [
  'id', 'doi', 'title', 'publication_year', 'cited_by_count', 'primary_location', 'locations',
  'authorships', 'abstract_inverted_index', 'referenced_works', 'type',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const elapsed = () => (Date.now() - T0) / 1000;
const warnings = [];
const warn = (m) => { const s = redact(m); if (!warnings.includes(s)) { warnings.push(s); process.stderr.write(`litfind: ${s}\n`); } };
function die(m) { process.stderr.write(`litfind: ${redact(m)}\n\n${USAGE}`); process.exit(2); }

const USAGE = `usage: node litfind.mjs --q "<question>" --ctx "<project lines>" --kw "<keywords>" [--kw ...]
  [--para "<paraphrase>"] [--seed <doi|arxiv|W-id>] [--exclude FILE] [--from YEAR] [--to YEAR]
  [--k 30] [--tail 20] [--hops 2] [--grader auto|jev|haiku|bm25] [--budget-s 240] [--out FILE] [--no-arxiv]
  [--no-alphaxiv] [--drop <id|title>] [--grade-frac 0.5]
a full run takes 1-3 min.
`;

// --- args --------------------------------------------------------------------

const MULTI = new Set(['kw', 'para', 'seed', 'exclude', 'drop']);
const SINGLE = new Set(['q', 'ctx', 'from', 'to', 'k', 'tail', 'hops', 'grader', 'budget-s', 'out', 'recent-months', 'grade-frac']);
const BOOL = new Set(['no-arxiv', 'no-alphaxiv']);

export function parseArgs(argv) {
  const a = { kw: [], para: [], seed: [], exclude: [], drop: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h' || t === '--help') { process.stdout.write(USAGE); process.exit(0); }
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const name = t.slice(2);
    if (BOOL.has(name)) { a[name] = true; continue; }
    if (!MULTI.has(name) && !SINGLE.has(name)) throw new Error(`unknown flag --${name}`);
    if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`);
    const v = argv[++i];
    if (MULTI.has(name)) a[name].push(v);
    else a[name] = v;
  }
  return a;
}

function intArg(v, def, lo, hi, name) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) die(`--${name} must be an integer in [${lo}, ${hi}]`);
  return n;
}

// --- text helpers --------------------------------------------------------------

export const normTitle = (t) => String(t || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const cleanTitle = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
export const cleanDoi = (d) => (d ? String(d).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[).,;:]+$/, '').toLowerCase() : null);
const shortId = (id) => (id ? String(id).replace(/^https?:\/\/openalex\.org\//i, '') : null);

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

export function abstractOf(inv) {
  if (!inv) return null;
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  const text = words.filter((w) => w !== undefined).join(' ').trim();
  return text || null;
}

function arxivOf(w) {
  const doi = (w.doi || '').toLowerCase();
  let m = doi.match(/10\.48550\/arxiv\.(.+)$/);
  if (m) return m[1].replace(/v\d+$/, '');
  for (const loc of [w.primary_location, ...(w.locations || [])]) {
    for (const u of [loc?.landing_page_url, loc?.pdf_url]) {
      if (!u) continue;
      m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i);
      if (m) return m[1].replace(/\.pdf$/i, '').replace(/v\d+$/, '');
    }
  }
  return null;
}

function authorsOf(names) {
  const a = names.filter(Boolean).slice(0, 3);
  if (names.length > 3) a.push('et al.');
  return a;
}

export function fromOA(w) {
  return {
    oa: shortId(w.id),
    doi: cleanDoi(w.doi),
    arxiv: arxivOf(w),
    title: cleanTitle(w.title),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    cited_by: w.cited_by_count ?? 0,
    authors: authorsOf((w.authorships || []).map((x) => x?.author?.display_name)),
    abstract: abstractOf(w.abstract_inverted_index),
    refs: (w.referenced_works || []).map(shortId).filter(Boolean),
    type: w.type || null,
  };
}

const STOP = new Set(('a an and are as at be by for from has have how in into is it its of on or that the their this to was '
  + 'were what when where which while who why with we our can do does using use based via between within under over '
  + 'about than then these those such not no they them also more most other some any each both only paper study '
  + 'research question project searching want need find papers work works').split(' '));

export function stemTokens(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ings|ing|edly|ed|es|s)$/, '') : w));
}

// --- HTTP ----------------------------------------------------------------------

async function fetchT(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
  try {
    return await fetch(url, { ...opts, signal });
  } finally {
    clearTimeout(t);
  }
}

async function runPool(jobs, n) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}

// --- OpenAlex --------------------------------------------------------------------

const oaStat = { calls: 0, usd: 0, remaining: null, errors: 0 };
let semanticNext = 0;

async function oaGet(params, { path = '/works', semantic = false, label = 'call', quiet = false } = {}) {
  if (oaStat.usd >= OA_CAP_USD) { warn(`OpenAlex per-run cap $${OA_CAP_USD} reached, further calls skipped`); return null; }
  if (oaStat.remaining !== null && oaStat.remaining < 0.003) { warn('OpenAlex daily budget exhausted, further calls skipped'); return null; }
  const u = new URL('https://api.openalex.org' + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  if (EMAIL) u.searchParams.set('mailto', EMAIL);
  const headers = { 'User-Agent': UA };
  if (OA_KEY) headers.Authorization = `Bearer ${OA_KEY}`;
  // LITFIND_OA_CACHE: replay identical OpenAlex calls from disk so repeated runs don't spend the $1/day budget.
  const cacheDir = process.env.LITFIND_OA_CACHE;
  const cacheFile = cacheDir ? join(cacheDir, createHash('sha1').update(u.toString()).digest('hex') + '.json') : null;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const keep = (j) => { if (cacheFile) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(j)); } return j; };
  let lastErr = '';
  for (let a = 0; a < 3; a++) {
    if (semantic) {
      const now = Date.now();
      const slot = Math.max(now, semanticNext);
      semanticNext = slot + 1100; // semantic search: 1 request/s, 429 otherwise
      if (slot > now) await sleep(slot - now);
    }
    let r;
    try {
      r = await fetchT(u, { headers }, semantic ? 20000 : 30000);
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'timeout' : String(e.message || e);
      if (a < 1) { await sleep(1500); continue; }
      break;
    }
    oaStat.calls++;
    const c = Number(r.headers.get('x-ratelimit-cost-usd'));
    if (Number.isFinite(c)) oaStat.usd += c;
    const rem = r.headers.get('x-ratelimit-remaining-usd');
    if (rem !== null && Number.isFinite(Number(rem))) oaStat.remaining = Number(rem);
    if (r.status === 404) return null;
    const body = await r.text().catch(() => '');
    if (r.ok) {
      try { return keep(JSON.parse(body)); } catch { lastErr = 'non-JSON response'; break; }
    }
    lastErr = `HTTP ${r.status} ${body.slice(0, 140).replace(/\s+/g, ' ')}`;
    if (r.status === 429 && !/budget|credit|daily/i.test(body)) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra : 2, 10) * 1000 + 250);
      continue;
    }
    // Filtered semantic queries over wide year ranges answer 504 after ~9 s; a retry does not help.
    if (r.status >= 500 && r.status !== 504 && a < 1) { await sleep(1500); continue; }
    break;
  }
  oaStat.errors++;
  if (!quiet) warn(`OpenAlex ${label} failed: ${lastErr}`);
  return null;
}

// --- arXiv -----------------------------------------------------------------------

let arxivNext = 0;
async function arxivWait() {
  const now = Date.now();
  const slot = Math.max(now, arxivNext);
  arxivNext = slot + 3100; // arXiv API terms: one request every 3 s
  if (slot > now) await sleep(slot - now);
}

function arxivEntries(body) {
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = (e.match(/<id>[^<]*arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1];
    const title = (e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
    if (!id || !title) continue;
    const summary = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1];
    const pub = (e.match(/<published>(\d{4})/) || [])[1];
    const names = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((x) => decodeXml(x[1]).trim());
    const doi = (e.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/) || [])[1];
    out.push({
      oa: null, doi: cleanDoi(doi), arxiv: id.replace(/v\d+$/, ''), title: cleanTitle(decodeXml(title)),
      year: pub ? Number(pub) : null, venue: 'arXiv', cited_by: 0, authors: authorsOf(names),
      abstract: summary ? decodeXml(summary).replace(/\s+/g, ' ').trim() : null, refs: [], type: 'preprint',
    });
  }
  return out;
}

async function arxivSearch(kw, months) {
  const terms = [...new Set(String(kw).toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 4);
  if (!terms.length) return [];
  const since = new Date(Date.now() - months * 30.44 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const q = `(${terms.map((t) => `all:${t}`).join(' AND ')}) AND submittedDate:[${since}0000 TO 209912312359]`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=relevance&max_results=50`;
  await arxivWait();
  let body;
  try {
    const r = await fetchT(url, { headers: { 'User-Agent': UA } }, 25000);
    if (!r.ok) { warn(`arXiv search failed: HTTP ${r.status}`); return []; }
    body = await r.text();
  } catch (e) {
    warn(`arXiv search failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return [];
  }
  return arxivEntries(body);
}

// --- alphaXiv ----------------------------------------------------------------------

/** discover_papers text → [{arxiv, title, preview}]; slug ids (e.g. 2609.recurrent-looped-transformer) are dropped. */
export function parseAlphaxiv(text) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(text || '').split(/^(?=\d+\.\s+\[ID=)/m)) {
    const m = chunk.match(/^\d+\.\s+\[ID=([^\]\s]+)\]\s*\*\*([\s\S]+?)\*\*/);
    if (!m) continue;
    const id = m[1].replace(/v\d+$/, '');
    if (!/^\d{4}\.\d{4,5}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const rest = chunk.slice(m[0].length);
    const pv = rest.match(/\bviews?:\s*([\s\S]*)$/) || rest.match(/:\s*([\s\S]*)$/);
    out.push({ arxiv: id, title: cleanTitle(m[2]), preview: pv ? pv[1].replace(/\s+/g, ' ').trim() || null : null });
  }
  return out;
}

const AX_TIMEOUT_MS = 60000;

/** One discover_papers call. Only the question and keywords leave the machine, never --ctx (third-party service). */
export async function alphaxivSearch(question, keywords, key = AX_KEY) {
  if (!key) return [];
  const url = process.env.LITFIND_ALPHAXIV_URL || 'https://api.alphaxiv.org/mcp/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AX_TIMEOUT_MS);
  let sid = null;
  let id = 0;
  const rpc = async (method, params, notify = false) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` };
    if (sid) headers['Mcp-Session-Id'] = sid;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    sid = r.headers.get('mcp-session-id') || sid;
    const t = await r.text();
    if (notify) return null;
    if (!r.ok) throw new Error(`${method} HTTP ${r.status} ${t.slice(0, 140).replace(/\s+/g, ' ')}`);
    let j;
    if ((r.headers.get('content-type') || '').includes('event-stream')) {
      const datas = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
      j = datas.find((d) => d.id === id) || datas.at(-1);
    } else j = JSON.parse(t);
    if (!j) throw new Error(`${method}: empty reply`);
    if (j.error) throw new Error(`${method}: ${String(j.error.message || JSON.stringify(j.error)).slice(0, 140)}`);
    return j.result;
  };
  let hits;
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'litfind', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    const kws = keywords.length ? keywords.slice(0, 3) : [question];
    const res = await rpc('tools/call', { name: 'discover_papers', arguments: { question, keywords: kws, difficulty: 6 } });
    const text = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res?.isError) throw new Error(`discover_papers: ${text.slice(0, 140)}`);
    hits = parseAlphaxiv(text);
    if (!hits.length && !/\[ID=/.test(text)) throw new Error(`unparsable reply: ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (e) {
    clearTimeout(timer);
    warn(`alphaXiv search failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return [];
  }
  if (!hits.length) { clearTimeout(timer); return []; }
  // Full abstract, year, authors and DOI from one arXiv call; alphaXiv's title + preview if that fails.
  let full = new Map();
  try {
    await arxivWait();
    const r = await fetchT(`https://export.arxiv.org/api/query?id_list=${hits.map((h) => h.arxiv).join(',')}&max_results=50`,
      { headers: { 'User-Agent': UA }, signal: ctrl.signal }, 25000);
    if (r.ok) full = new Map(arxivEntries(await r.text()).map((x) => [x.arxiv, x]));
  } catch { /* fallback below */ }
  clearTimeout(timer);
  return hits.map((h) => full.get(h.arxiv) || {
    oa: null, doi: null, arxiv: h.arxiv, title: h.title, year: null, venue: 'arXiv', cited_by: 0, authors: [],
    abstract: h.preview, refs: [], type: 'preprint',
  });
}

// --- candidate store ---------------------------------------------------------------

const C = [];
const index = new Map();
const SKIP_TYPES = new Set(['paratext', 'erratum', 'retraction', 'peer-review', 'grant', 'supplementary-materials']);
let yearFrom = null;
let yearTo = null;
const DROP = new Set(); // --drop: never a candidate, never a seed (W-id, DOI or exact title)

function keysOf(r) {
  const k = [];
  if (r.oa) k.push('W:' + r.oa);
  if (r.doi) k.push('d:' + r.doi);
  if (r.arxiv) k.push('a:' + r.arxiv);
  const t = normTitle(r.title);
  if (t.length >= 30) k.push('t:' + t);
  return k;
}

function merge(into, r) {
  for (const f of ['oa', 'doi', 'arxiv', 'venue', 'year', 'type']) if (into[f] == null && r[f] != null) into[f] = r[f];
  if (r.abstract && (!into.abstract || r.abstract.length > into.abstract.length)) into.abstract = r.abstract;
  if (r.refs?.length && !into.refs?.length) into.refs = r.refs;
  if ((r.cited_by ?? 0) > (into.cited_by ?? 0)) into.cited_by = r.cited_by;
  if (!into.authors?.length && r.authors?.length) into.authors = r.authors;
}

/** Returns {rec, isNew}, or null when the record is filtered out. */
function addCandidate(r, src, { bypassYear = false } = {}) {
  if (!r || !r.title) return null;
  if (r.type && SKIP_TYPES.has(r.type)) return null;
  if (DROP.size && (DROP.has('W:' + r.oa) || DROP.has('d:' + r.doi) || DROP.has('t:' + normTitle(r.title)))) return null;
  if (!bypassYear && r.year) {
    if (yearFrom && r.year < yearFrom) return null;
    if (yearTo && r.year > yearTo) return null;
  }
  let rec = null;
  for (const k of keysOf(r)) if ((rec = index.get(k))) break;
  let isNew = false;
  if (rec) {
    merge(rec, r);
    rec.src.push(src);
  } else {
    rec = { n: C.length, ...r, src: [src], stage: src.stage };
    C.push(rec);
    isNew = true;
  }
  for (const k of keysOf(rec)) if (!index.has(k)) index.set(k, rec);
  return { rec, isNew };
}

// --- Crossref abstract fill ----------------------------------------------------------

async function fillAbstracts(items) {
  const todo = items.filter((it) => !it.abstract && it.doi && !it.crossrefTried);
  if (!todo.length) return;
  let filled = 0;
  await runPool(todo.map((it) => async () => {
    it.crossrefTried = true;
    try {
      const r = await fetchT(`https://api.crossref.org/works/${encodeURIComponent(it.doi)}${EMAIL ? `?mailto=${encodeURIComponent(EMAIL)}` : ''}`, {}, 8000);
      if (!r.ok) return;
      const j = await r.json();
      const a = j?.message?.abstract;
      if (a && a.length > 100) {
        it.abstract = decodeXml(a.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/^abstract\s*/i, '').trim();
        it.abstractFrom = 'crossref';
        filled++;
      }
    } catch { /* best effort */ }
  }), 8);
  stats.crossrefFilled += filled;
}

// --- graders ---------------------------------------------------------------------------

// haiku is not in the automatic chain: it ranked below bm25 and costs subscription usage.
const CHAIN = { jev: 'bm25', haiku: 'bm25', bm25: null };
let MODE = 'jev';
let FALLBACK = false;
const stats = { crossrefFilled: 0 };

function switchMode(reason) {
  const from = MODE;
  MODE = CHAIN[MODE];
  FALLBACK = true;
  warn(`${from} unavailable (${reason}) — whole run re-ranked by ${MODE}`);
  if (from === 'jev') jev.reason = reason;
  if (from === 'haiku') haiku.reason = reason;
}

const jev = { down: false, reason: null, ok: 0, fail: 0, consec: 0, calls: 0, attemptFails: 0, tokens: 0, lat: [], lastErr: null, ctrl: new AbortController() };

let QUESTION = '';
let CONTEXT = '';
// --grade-frac: share of each batch (search, each hop) sent to Jev, best word-match first; the rest ranks below by word-match.
// 0.5 halves the Jev cost with no measurable loss in blind-judged top-30 relevance.
let GRADE_FRAC = 0.5;
let SKIPPED = 0;

const JEV_CTX_NONE = '`research_question` is what a researcher is searching the literature for. `paper_title` and `paper_abstract` describe one candidate paper. ';
const JEV_CTX = '`research_question` is what a researcher is searching the literature for. `project_context` describes their project and why they are searching; use it to judge what they need. `paper_title` and `paper_abstract` describe one candidate paper. ';

/** The prompt wording Jev was evaluated with. */
export function jevBody(it, question, context) {
  const ctx = context ? JEV_CTX : JEV_CTX_NONE;
  const ask = context
    ? 'Does this paper directly address the research question, so that this researcher, given their project, would want to read it?'
    : 'Does this paper directly address the research question, so that a researcher working on exactly that question would want to read it?';
  const state = { research_question: question, paper_title: it.title, paper_abstract: (it.abstract || '(no abstract)').slice(0, 1500) };
  if (context) state.project_context = context;
  return {
    model: JEV_MODEL,
    state,
    questions: {
      addresses: { type: 'noul', instructions: ctx + ask },
    },
  };
}

function jevTrip(reason) {
  if (jev.down) return;
  jev.down = true;
  jev.ctrl.abort();
  if (MODE === 'jev') switchMode(reason);
}

/** One paper, up to `attempts` calls. `count` = charge a final failure to the breaker (off for the sweep). */
async function jevOne(it, attempts, count = true) {
  for (let a = 0; a < attempts; a++) {
    if (jev.down) return null;
    const t0 = Date.now();
    try {
      jev.calls++;
      const r = await fetchT(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${JEV_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(jevBody(it, QUESTION, CONTEXT)),
        signal: jev.ctrl.signal,
      }, JEV_TIMEOUT_MS);
      if (r.status === 401 || r.status === 402 || r.status === 403) {
        jevTrip(`Jev HTTP ${r.status}: key rejected or out of credit`);
        return null;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const p = j?.answers?.addresses?.noul;
      if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('response without an answer');
      jev.ok++;
      jev.consec = 0;
      jev.tokens += j?.usage?.input_tokens ?? 0;
      jev.lat.push(Date.now() - t0);
      return { p };
    } catch (e) {
      if (jev.down) return null;
      jev.lastErr = e.name === 'AbortError' ? `no answer within ${JEV_TIMEOUT_MS / 1000} s` : String(e.message || e).slice(0, 120);
      // A dead or hanging service shows up in the first wave of calls; don't wait for three retries each.
      if (++jev.attemptFails >= 12 && jev.ok === 0) { jevTrip(`first ${jev.attemptFails} Jev calls all failed, last: ${jev.lastErr}`); return null; }
      if (a < attempts - 1) await sleep(a === 0 ? 1000 : 3000);
    }
  }
  if (!count) return null;
  jev.fail++;
  jev.consec++;
  const n = jev.ok + jev.fail;
  if (jev.consec >= 8) jevTrip(`8 Jev calls in a row failed, last: ${jev.lastErr}`);
  else if (n >= 20 && jev.fail / n > 0.25) jevTrip(`${jev.fail} of ${n} Jev calls failed, last: ${jev.lastErr}`);
  return null;
}

async function jevGrade(items, deadline) {
  if (!JEV_KEY) { jev.down = true; switchMode('no JEV_API_KEY set'); return; }
  computePrerank();
  // Best pre-rank first: if a slow Jev runs into the deadline, what stays ungraded is the tail.
  const all = items.filter((it) => it.jev === undefined).sort((a, b) => b.pre - a.pre);
  // alphaXiv hits (<= 15) are always graded: they often make the top 30, and word-match pre-rank could otherwise
  // cut them before Jev sees them.
  const cut = Math.ceil(GRADE_FRAC * all.length);
  const keep = (it, i) => i < cut || it.src.some((x) => x.s === 'alphaxiv');
  const todo = all.filter(keep);
  for (const it of all.filter((it, i) => !keep(it, i))) { it.jev = null; SKIPPED++; } // ranked after the graded papers, by pre-rank
  const failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: JEV_CONC }, async () => {
    while (next < todo.length && !jev.down && Date.now() < deadline) {
      const it = todo[next++];
      const res = await jevOne(it, 3);
      if (res) it.jev = res;
      else if (!jev.down) failed.push(it);
    }
  }));
  if (jev.down) return;
  // One slow sweep over the papers that failed three times.
  if (failed.length && Date.now() < deadline) {
    await runPool(failed.map((it) => async () => {
      if (jev.down || Date.now() > deadline) return;
      const res = await jevOne(it, 1, false);
      if (res) { it.jev = res; jev.fail--; }
    }), 4);
  }
  if (jev.down) return;
  const tried = jev.ok + jev.fail;
  // More than 5 % unanswered would leave a hole in the ranking; a different grader for them would mix scales.
  if (tried >= 20 && jev.fail / tried > 0.05) {
    jevTrip(`${jev.fail} of ${tried} papers got no Jev answer after retries`);
    return;
  }
  const lost = failed.filter((it) => it.jev === undefined);
  for (const it of lost) it.jev = null; // ranked after the graded papers, by pre-rank
  if (lost.length) warn(`${lost.length} papers got no Jev answer after retries (ranked after the graded ones)`);
  const late = todo.filter((it) => it.jev === undefined).length;
  if (late) warn(`time budget: ${late} papers not graded (ranked after the graded ones)`);
}

// haiku via the claude CLI on PATH, with the user's own login.
const haiku = { calls: 0, fails: 0, consec: 0, down: false, reason: null, costUsd: 0 };

function claudeCli() {
  return process.env.LITFIND_CLAUDE_CLI || 'claude';
}

function runCli(cli, argv, env, ms) {
  return new Promise((res) => {
    const p = spawn(cli, argv, { env, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); res({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e) }); });
  });
}

function haikuPrompt(batch) {
  const papers = batch.map((it, i) => `[p${String(i).padStart(2, '0')}] ${it.title} (${it.year ?? 'n.d.'})\n${(it.abstract || '(no abstract)').slice(0, 1100)}`).join('\n\n');
  return `Research question: ${QUESTION}\n\n`
    + (CONTEXT ? `Project context (who is searching and why): ${CONTEXT}\n\n` : '')
    + 'For each paper below, rate how well it addresses the research question for this researcher, 0-10: '
    + '10 = directly addresses it, a researcher on exactly this question would want to read it; '
    + '5 = same area or part of the question, useful background; 0 = not about the question. '
    + 'Judge from title and abstract only.\n\nReturn every id exactly once, one per line, as `id score`, nothing else.\n\n'
    + papers;
}

async function haikuGrade(items, n, deadline) {
  const cli = claudeCli();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  computePrerank();
  const todo = items.filter((it) => it.haiku === undefined).sort((a, b) => b.pre - a.pre).slice(0, n);
  const batches = [];
  for (let i = 0; i < todo.length; i += HAIKU_BATCH) batches.push(todo.slice(i, i + HAIKU_BATCH));
  const SYS = 'You screen candidate papers for a literature search. You output only score lines, nothing else.';
  await runPool(batches.map((batch) => async () => {
    for (let a = 0; a < 2; a++) {
      if (haiku.down || Date.now() > deadline) return;
      haiku.calls++;
      const r = await runCli(cli, ['-p', haikuPrompt(batch), '--model', 'haiku', '--output-format', 'json', '--tools', '',
        '--system-prompt', SYS, '--no-session-persistence', '--strict-mcp-config'], env, HAIKU_TIMEOUT_MS);
      let j = {};
      try { j = JSON.parse(r.out); } catch { /* handled below */ }
      const txt = String(j.result || '');
      haiku.costUsd += j.total_cost_usd || 0;
      const got = new Map();
      for (const m of txt.matchAll(/p(\d{2})\D{1,4}(\d+(?:\.\d+)?)/g)) {
        const i = Number(m[1]);
        const s = Number(m[2]);
        if (i < batch.length && s >= 0 && s <= 10 && !got.has(i)) got.set(i, s);
      }
      if (got.size >= batch.length - 1) {
        for (const [i, s] of got) batch[i].haiku = s / 10;
        haiku.consec = 0;
        return;
      }
      if (r.code === -1 && /ENOENT/.test(r.err)) {
        haiku.down = true;
        if (MODE === 'haiku') switchMode('claude CLI not found on PATH');
        return;
      }
      if (/limit|quota|credit|unauthori[sz]ed|401|invalid api key/i.test(txt + r.err) && got.size === 0) {
        haiku.down = true;
        if (MODE === 'haiku') switchMode(`haiku refused: ${(txt || r.err).slice(0, 120).replace(/\s+/g, ' ')}`);
        return;
      }
    }
    haiku.fails++;
    if (++haiku.consec >= 2 && !haiku.down) {
      haiku.down = true;
      if (MODE === 'haiku') switchMode('two haiku batches in a row gave no usable scores');
    }
  }), HAIKU_CONC);
}

// --- pre-rank: search-rank fusion + BM25 ---------------------------------------------------

function computePrerank() {
  const qt = [...new Set(stemTokens([QUESTION, CONTEXT, ...ARGS.kw, ...ARGS.para].join(' ')))];
  const docs = C.map((it) => stemTokens(`${it.title} ${it.title} ${it.abstract || ''}`));
  const N = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const bm = docs.map((d) => {
    const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of qt) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    return s;
  });
  const rrf = C.map((it) => it.src.reduce((s, x) => {
    if (x.s === 'seed') return s + 1 / 60;
    const r = x.rank || 50;
    return s + (x.s === 'ref' || x.s === 'cite' ? 1 / (100 + r) : 1 / (60 + r));
  }, 0));
  const mb = Math.max(...bm, 1e-9);
  const mr = Math.max(...rrf, 1e-9);
  C.forEach((it, i) => { it.bm25 = bm[i] / mb; it.pre = 0.5 * it.bm25 + 0.5 * rrf[i] / mr; });
}

function scoreOf(it) {
  if (MODE === 'jev') return typeof it.jev?.p === 'number' ? it.jev.p : null;
  if (MODE === 'haiku') return typeof it.haiku === 'number' ? it.haiku : null;
  return it.pre;
}

// Final order under Jev: +0.05 per extra route a paper was found by (each search query, each ref/citer link),
// capped +0.2; this helps review-style questions and costs nothing elsewhere. bm25 already fuses routes.
export function withRoutes(p, routes) {
  return p + Math.min(0.2, 0.05 * Math.max(0, routes - 1));
}

function finalScore(it) {
  const s = scoreOf(it);
  return s === null || MODE !== 'jev' ? s : withRoutes(s, it.src.length);
}

function ranked(list = C, score = scoreOf) {
  computePrerank();
  return [...list].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa === null && sb !== null) return 1;
    if (sb === null && sa !== null) return -1;
    if (sa !== null && sb !== null && sb !== sa) return sb - sa;
    return b.pre - a.pre;
  });
}

async function grade(items, n, deadline) {
  await fillAbstracts(items);
  let pool = items;
  let cap = n;
  for (;;) {
    const mode = MODE;
    if (mode === 'jev') await jevGrade(pool, deadline);
    else if (mode === 'haiku') await haikuGrade(pool, cap, deadline);
    if (MODE === mode || MODE === 'bm25') return;
    // The grader changed mid-run: regrade everything so one scale ranks the whole list.
    pool = C;
    cap = 200;
    await fillAbstracts(pool);
  }
}

// --- seeds and expansion -------------------------------------------------------------------

function seedThreshold() {
  return MODE === 'jev' ? 0.5 : MODE === 'haiku' ? 0.6 : Infinity;
}

async function resolveOA(it) {
  if (it.oa) return it.oa;
  if (it.doi) {
    const w = await oaGet({ select: 'id' }, { path: '/works/doi:' + encodeURIComponent(it.doi).replace(/%2F/gi, '/'), label: 'doi lookup' });
    if (w?.id) return shortId(w.id);
  }
  const q = it.title.replace(/[,|:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const res = await oaGet({ filter: `title.search:${q}`, per_page: 5, select: 'id,title' }, { label: 'title lookup' });
  const want = normTitle(it.title);
  const hit = (res?.results || []).find((w) => normTitle(w.title) === want);
  return hit ? shortId(hit.id) : null;
}

async function expand(seeds, stage) {
  const fresh = [];
  const push = (x) => { if (x?.isNew) fresh.push(x.rec); };
  await runPool(seeds.map((s) => async () => {
    s.expanded = stage;
    const oa = await resolveOA(s);
    if (!oa) { warn(`seed not in OpenAlex, not expanded: ${s.title.slice(0, 70)}`); return; }
    s.oa = oa;
    let refs = s.refs || [];
    if (!refs.length) {
      const w = await oaGet({ select: 'id,referenced_works' }, { path: `/works/${oa}`, label: 'refs lookup' });
      refs = (w?.referenced_works || []).map(shortId).filter(Boolean);
      s.refs = refs;
    }
    for (let i = 0; i < Math.min(refs.length, 200); i += 100) {
      const j = await oaGet({ filter: `openalex_id:${refs.slice(i, i + 100).join('|')}`, per_page: 100, select: OA_SELECT }, { label: 'refs' });
      (j?.results || []).forEach((w, r) => push(addCandidate(fromOA(w), { s: 'ref', of: s.n, rank: i + r + 1, stage })));
    }
    for (const [sort, tag] of [['cited_by_count:desc', 'top'], ['publication_date:desc', 'new']]) {
      const j = await oaGet({ filter: `cites:${oa}`, per_page: 25, sort, select: OA_SELECT }, { label: 'citers' });
      (j?.results || []).forEach((w, r) => push(addCandidate(fromOA(w), { s: 'cite', of: s.n, sort: tag, rank: r + 1, stage })));
    }
  }), 3);
  return fresh;
}

// --- known papers ----------------------------------------------------------------------------

export function knownIdsFrom(text) {
  const ids = new Set();
  for (const m of text.matchAll(/10\.\d{4,9}\/[^\s"'<>\])}]+/g)) {
    const d = cleanDoi(m[0]);
    const ax = d.match(/^10\.48550\/arxiv\.(.+)$/);
    if (ax) ids.add('a:' + ax[1].replace(/v\d+$/, ''));
    else ids.add('d:' + d);
  }
  for (const m of text.matchAll(/(?<![\d.\/])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g)) ids.add('a:' + m[1]);
  for (const m of text.matchAll(/\b(W\d{6,})\b/g)) ids.add('W:' + m[1]);
  return ids;
}

// --- S2 as a last-resort source when OpenAlex returns nothing ----------------------------------

async function s2Search(q) {
  const r = await runCli(process.execPath, [join(import.meta.dirname, 's2.mjs'), 'search', q, '--n', '50', '--full-abstract'], process.env, 90000);
  try {
    const j = JSON.parse(r.out);
    return (j.results || []).map((x) => ({
      oa: null, doi: cleanDoi(x.doi), arxiv: x.arxiv || null, title: cleanTitle(x.title), year: x.year ?? null,
      venue: x.venue ?? null, cited_by: x.cited_by ?? 0, authors: x.authors || [], abstract: x.abstract || null, refs: [], type: null,
    }));
  } catch {
    warn(`Semantic Scholar fallback search failed: ${(r.out || r.err).slice(0, 120)}`);
    return [];
  }
}

// --- main --------------------------------------------------------------------------------------

let ARGS;

function slugOf(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'search';
}

function idOf(it) {
  return it.doi || (it.arxiv ? `arXiv:${it.arxiv}` : it.oa || '');
}

function viaOf(it) {
  const s = new Set();
  for (const x of it.src) s.add(x.s === 'kw' || /^kw\d/.test(x.s) ? 'kw' : /^sem/.test(x.s) ? 'sem' : x.s);
  return [...s].join(',');
}

function fmtScore(it) {
  const s = finalScore(it);
  if (s === null) return ' -- ';
  return s.toFixed(2).replace(/^0/, '');
}

async function main() {
  try {
    ARGS = parseArgs(process.argv.slice(2));
  } catch (e) {
    die(e.message);
  }
  const A = ARGS;
  if (!A.q || !A.q.trim()) die('--q is required');
  if (!OA_KEY) { process.stderr.write(`litfind: ${NO_KEY_MSG}\n`); process.exit(2); }
  if (!A.kw.length) warn('no --kw given: keyword search runs on --q alone; 4-8 keyword versions find more');
  QUESTION = A.q.trim();
  CONTEXT = (A.ctx || '').trim().slice(0, 3000);
  const K = intArg(A.k, 30, 1, 200, 'k');
  if (A['grade-frac'] !== undefined) GRADE_FRAC = Number(A['grade-frac']);
  if (!(GRADE_FRAC > 0 && GRADE_FRAC <= 1)) die('--grade-frac must be in (0, 1]');
  const TAIL = intArg(A.tail, 20, 0, 200, 'tail');
  const HOPS = intArg(A.hops, 2, 0, 2, 'hops');
  const BUDGET = intArg(A['budget-s'], 240, 30, 580, 'budget-s');
  const MONTHS = intArg(A['recent-months'], 18, 1, 120, 'recent-months');
  yearFrom = A.from ? intArg(A.from, null, 1800, 2100, 'from') : null;
  yearTo = A.to ? intArg(A.to, null, 1800, 2100, 'to') : null;
  const grader = A.grader || 'auto';
  if (!['auto', 'jev', 'haiku', 'bm25'].includes(grader)) die('--grader must be auto, jev, haiku or bm25');
  MODE = grader === 'auto' ? (JEV_KEY ? 'jev' : 'bm25') : grader;
  if (!A.ctx && (MODE === 'jev' || MODE === 'haiku')) warn(`no --ctx given: ${MODE} ranks noticeably worse without 3-4 lines of project context`);
  const deadline = T0 + BUDGET * 1000;

  for (const d of A.drop) {
    const p = parseId(d);
    if (p?.kind === 'openalex') DROP.add('W:' + p.id);
    else if (p?.kind === 'doi') DROP.add('d:' + p.doi);
    else DROP.add('t:' + normTitle(d));
  }
  const known = new Set();
  for (const f of A.exclude) {
    if (!existsSync(f)) { warn(`--exclude file not found: ${f}`); continue; }
    for (const id of knownIdsFrom(readFileSync(f, 'utf8'))) known.add(id);
  }

  // User-supplied seeds.
  const userSeeds = [];
  for (const raw of A.seed) {
    const p = parseId(raw);
    if (!p) { warn(`--seed not understood: ${raw}`); continue; }
    let w = null;
    if (p.kind === 'openalex') w = await oaGet({ select: OA_SELECT }, { path: `/works/${p.id}`, label: 'seed' });
    else if (p.kind === 'doi') w = await oaGet({ select: OA_SELECT }, { path: '/works/doi:' + encodeURIComponent(p.doi).replace(/%2F/gi, '/'), label: 'seed' });
    else {
      const r = await fetchT(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(p.id)}`, {}, 20000).then((x) => x.text()).catch(() => '');
      const t = (r.match(/<entry>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
      if (t) {
        const title = cleanTitle(decodeXml(t));
        const q = title.replace(/[,|:]+/g, ' ').replace(/\s+/g, ' ').trim();
        const res = await oaGet({ filter: `title.search:${q}`, per_page: 5, select: OA_SELECT }, { label: 'seed' });
        w = (res?.results || []).find((x) => normTitle(x.title) === normTitle(title)) || null;
      }
    }
    if (!w) { warn(`--seed not found in OpenAlex: ${raw}`); continue; }
    const x = addCandidate(fromOA(w), { s: 'seed', stage: 0 }, { bypassYear: true });
    if (x) userSeeds.push(x.rec);
  }

  // Search.
  const kws = A.kw.length ? A.kw : [QUESTION];
  const yf = yearFrom && yearTo ? `publication_year:${yearFrom}-${yearTo}`
    : yearFrom ? `publication_year:>${yearFrom - 1}` : yearTo ? `publication_year:<${yearTo + 1}` : undefined;
  const srcCounts = {};
  const kwJobs = kws.map((kw, i) => async () => {
    const j = await oaGet({ search: kw, per_page: 100, filter: yf, select: OA_SELECT }, { label: `keyword search ${i + 1}` });
    const res = j?.results || [];
    srcCounts[`kw${i + 1}`] = res.length;
    res.forEach((w, r) => addCandidate(fromOA(w), { s: `kw${i + 1}`, rank: r + 1, stage: 0 }));
  });
  const semJob = async () => {
    const texts = [QUESTION, ...A.para].map((t) => t.slice(0, 600));
    for (const [i, t] of texts.entries()) {
      for (const recent of [false, true]) {
        if (recent && yearTo && yearTo < YEAR - 1) continue;
        const rf = `publication_year:>${YEAR - 2}`;
        let tag = `sem${i + 1}${recent ? 'r' : ''}`;
        const j = await oaGet({ 'search.semantic': t, per_page: 50, filter: recent ? rf : undefined, select: OA_SELECT },
          { semantic: true, quiet: recent, label: `semantic search ${i + 1}${recent ? ' (recent)' : ''}` });
        let res = j?.results || [];
        if (recent && !j) {
          // The year-filtered semantic call 504s on about a third of queries; keyword search with the same filter stands in.
          tag = `kw${i + 1}r`;
          const k = await oaGet({ search: kws[i] || kws[0], per_page: 50, filter: rf, select: OA_SELECT }, { label: `recent keyword search ${i + 1}` });
          res = k?.results || [];
        }
        srcCounts[tag] = res.length;
        res.forEach((w, r) => addCandidate(fromOA(w), { s: tag, rank: r + 1, stage: 0 }));
      }
    }
  };
  const arxJob = async () => {
    if (A['no-arxiv'] || (yearTo && yearTo < YEAR - 1)) return;
    for (const [i, kw] of kws.slice(0, 3).entries()) {
      const res = await arxivSearch(kw, MONTHS);
      srcCounts[`arxiv${i + 1}`] = res.length;
      res.forEach((r, k) => addCandidate(r, { s: 'arxiv', rank: k + 1, stage: 0 }));
    }
  };
  const axJob = async () => {
    if (A['no-alphaxiv'] || (yearTo && yearTo < YEAR - 1)) return;
    const res = await alphaxivSearch(QUESTION, A.kw);
    srcCounts.alphaxiv = res.length;
    res.forEach((r, k) => addCandidate(r, { s: 'alphaxiv', rank: k + 1, stage: 0 }));
  };
  await Promise.all([runPool(kwJobs, 4), semJob(), arxJob(), axJob()]);

  if (C.filter((it) => it.src.some((x) => x.s !== 'seed')).length < 20) {
    warn('OpenAlex returned almost nothing — adding Semantic Scholar search (slow, rate-limited)');
    for (const [i, q] of [QUESTION, ...kws.slice(0, 2)].entries()) {
      const res = await s2Search(q);
      srcCounts[`s2_${i + 1}`] = res.length;
      res.forEach((r, k) => addCandidate(r, { s: 's2', rank: k + 1, stage: 0 }));
    }
  }
  if (!C.length) {
    process.stdout.write(redact(JSON.stringify({ error: 'nothing retrieved', warnings }, null, 2)) + '\n');
    process.exit(2);
  }
  const nSearch = C.length;
  const tSearch = elapsed();

  await grade(C.slice(), 150, deadline - 20000);
  const tGrade0 = elapsed();

  // Expansion.
  const hopLog = [];
  let frontier = C.slice();
  for (let h = 1; h <= HOPS; h++) {
    if (Date.now() > deadline - 45000) { warn(`time budget: stopped before hop ${h}`); break; }
    if (MODE !== 'jev' && h > 1) break; // haiku is too slow for a second hop; bm25 can't tell whether a hop helped
    const thr = seedThreshold();
    let seeds = ranked(frontier).filter((it) => it.expanded === undefined && scoreOf(it) !== null && scoreOf(it) >= thr).slice(0, 5);
    if (h === 1) {
      if (MODE === 'bm25') seeds = ranked(frontier).slice(0, 3); // no grader: the word-match top 3 are the best guess
      if (MODE === 'jev' && seeds.length < 3) {
        warn(`weak seeds: only ${seeds.length} search hits reached P >= .5 — the question or keywords may be off, check the list by eye`);
        if (!seeds.length) seeds = ranked(frontier).filter((it) => scoreOf(it) !== null).slice(0, 2);
      }
      seeds = [...userSeeds.filter((s) => s.expanded === undefined), ...seeds.filter((s) => !userSeeds.includes(s))];
    }
    if (!seeds.length) break;
    const topBefore = new Set(ranked().slice(0, K).map((it) => it.n));
    const fresh = await expand(seeds, h);
    await grade(fresh, MODE === 'haiku' ? 75 : fresh.length, deadline - 15000);
    const enteredTop = ranked().slice(0, K).filter((it) => !topBefore.has(it.n) && it.stage === h).length;
    hopLog.push({ hop: h, seeds: seeds.map((s) => ({ n: s.n, title: s.title, score: scoreOf(s) })), new: fresh.length, entered_top: enteredTop, t: Number(elapsed().toFixed(1)) });
    frontier = fresh;
    if (enteredTop < 2) break; // converged
  }

  // Rank and report.
  const all = ranked(C, finalScore);
  for (const it of all) it.known = [...keysOf(it)].some((k) => known.has(k));
  const graded = all.filter((it) => scoreOf(it) !== null).length;
  const newOnes = all.filter((it) => !it.known);
  const top = newOnes.slice(0, K);
  const knownInTop = all.slice(0, K).filter((it) => it.known);

  const pack = (it, rank) => ({
    rank, score: finalScore(it), grader: MODE, jev_p: it.jev?.p ?? null,
    haiku: it.haiku ?? null, pre: Number((it.pre ?? 0).toFixed(4)), title: it.title, year: it.year, venue: it.venue,
    authors: it.authors, cited_by: it.cited_by, doi: it.doi, arxiv: it.arxiv, openalex: it.oa, known: it.known,
    abstract: it.abstract, abstract_from: it.abstractFrom || (it.abstract ? 'openalex/arxiv' : null),
    stage: it.stage, via: it.src.map((x) => (x.of !== undefined ? `${x.s}${x.sort ? ':' + x.sort : ''}<${x.of}` : `${x.s}#${x.rank ?? ''}`)),
    n: it.n,
  });
  const jevUsd = jev.tokens * 0.042 / 1e6;
  const lat = [...jev.lat].sort((a, b) => a - b);
  const result = {
    version: 1,
    query: { q: QUESTION, ctx: CONTEXT, kw: A.kw, para: A.para, seed: A.seed, from: yearFrom, to: yearTo, exclude: A.exclude },
    grader: MODE,
    grader_note: !FALLBACK ? null : `ranked by ${MODE} because: ${[jev.reason && `jev: ${jev.reason}`, haiku.reason && `haiku: ${haiku.reason}`].filter(Boolean).join('; ')}`,
    warnings,
    counts: { candidates: C.length, search: nSearch, graded, skipped_by_word_match: SKIPPED, known: all.filter((it) => it.known).length, by_source: srcCounts, crossref_abstracts: stats.crossrefFilled, no_abstract: C.filter((it) => !it.abstract).length },
    hops: hopLog,
    cost: {
      openalex_usd: Number(oaStat.usd.toFixed(4)), openalex_calls: oaStat.calls, openalex_remaining_today_usd: oaStat.remaining,
      jev_papers_ok: jev.ok, jev_papers_failed: jev.fail, jev_calls: jev.calls, jev_usd: Number(jevUsd.toFixed(4)),
      jev_latency_ms: lat.length ? { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat[lat.length - 1] } : null,
      haiku_calls: haiku.calls, haiku_usd_equiv: Number(haiku.costUsd.toFixed(3)),
    },
    seconds: { search: Number(tSearch.toFixed(1)), first_grade: Number(tGrade0.toFixed(1)), total: Number(elapsed().toFixed(1)) },
    top: top.map((it, i) => pack(it, i + 1)),
    rest: newOnes.slice(K).map((it, i) => pack(it, K + i + 1)),
    known_hits: all.filter((it) => it.known).map((it) => pack(it, all.indexOf(it) + 1)),
  };
  const outPath = resolve(A.out || join(process.cwd(), 'litfind', `${new Date().toISOString().slice(0, 10)}-${slugOf(QUESTION)}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, redact(JSON.stringify(result, null, 1)));

  // Compact stdout.
  const L = [];
  const hopStr = hopLog.map((h) => `hop${h.hop} +${h.new}`).join(' · ');
  L.push(`litfind  grader=${MODE}${FALLBACK ? '  ⚠ FALLBACK' : ''}  ${C.length} candidates (search ${nSearch}${hopStr ? ' · ' + hopStr : ''})  graded ${graded}  ${elapsed().toFixed(0)} s`);
  L.push(`cost  OpenAlex $${oaStat.usd.toFixed(3)} (left today ${oaStat.remaining === null ? '?' : '$' + oaStat.remaining.toFixed(2)})${jev.calls ? `  Jev ${jev.ok} ok / ${jev.fail} failed (${jev.calls} calls), $${jevUsd.toFixed(3)}` : ''}${haiku.calls ? `  haiku ${haiku.calls} calls` : ''}`);
  for (const w of warnings) L.push(`⚠ ${w}`);
  for (const h of hopLog) L.push(`seeds hop${h.hop}: ${h.seeds.map((s) => `${s.title.slice(0, 55)} (${s.score === null ? '-' : s.score.toFixed(2)})`).join(' | ')}`);
  L.push(`file  ${outPath}`);
  if (knownInTop.length) L.push(`already in --exclude, left out of the list: ${knownInTop.length} of the top ${K}`);
  L.push(`top ${top.length} new — score · year · title — first author · venue · id · found via  († = graded on title only)`);
  top.forEach((it, i) => {
    const au = it.authors?.[0] ? it.authors[0].split(' ').slice(-1)[0] : '?';
    L.push(`${String(i + 1).padStart(3)} ${fmtScore(it)} ${it.year ?? '----'} ${it.abstract ? '' : '† '}${it.title.slice(0, 110)} — ${au} · ${(it.venue || '').slice(0, 30)} · ${idOf(it)} · ${viaOf(it)}`);
  });
  const tail = newOnes.slice(K, K + TAIL);
  if (tail.length) {
    L.push(`next ${tail.length}:`);
    tail.forEach((it, i) => L.push(`${String(K + i + 1).padStart(3)} ${fmtScore(it)} ${it.year ?? '----'} ${it.title.slice(0, 100)} · ${idOf(it)}`));
  }
  process.stdout.write(redact(L.join('\n')) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
