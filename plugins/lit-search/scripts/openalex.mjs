#!/usr/bin/env node
/**
 * openalex — keyed OpenAlex search, lookup and citation graph.
 *
 * OpenAlex does not serve keyless search, so `search` needs OPENALEX_API_KEY (free: openalex.org,
 * settings → API key), from the environment or ./.env. The key travels only in the Authorization
 * header and is never printed.
 *
 * Pricing on the free $1/day budget: /works?search= $0.001, filter list calls $0.0001, singleton
 * /works/doi:<doi> $0. arXiv ids cannot be resolved by id (/works/doi:10.48550/arxiv.<id> 404s),
 * so `work <arxiv id>` goes via the arXiv title and filter=title.search.
 *
 * Usage:
 *   node openalex.mjs search "<query>" [--n 25] [--from YEAR] [--to YEAR] [--sort relevance|cited]
 *   node openalex.mjs work <doi | W-id | arxiv id>
 *   node openalex.mjs refs <id> [--n 50]
 *   node openalex.mjs cites <id> [--n 25] [--sort cited|recent]
 *   any command: [--full-abstract]
 *
 * Optional: LIT_SEARCH_EMAIL is sent as the polite-pool mailto.
 * Prints one JSON object. Exit 0 ok, 1 not found, 2 error / bad args / no key.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
loadEnvKeys(['OPENALEX_API_KEY', 'LIT_SEARCH_EMAIL']);

const KEY = process.env.OPENALEX_API_KEY || '';
const EMAIL = process.env.LIT_SEARCH_EMAIL || '';
const UA = EMAIL ? `openalex.mjs (mailto:${EMAIL})` : 'openalex.mjs';
const API = 'https://api.openalex.org';
const TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const SELECT = [
  'id', 'doi', 'title', 'publication_year', 'cited_by_count', 'primary_location',
  'locations', 'authorships', 'abstract_inverted_index',
];
const USAGE = `usage:
  node openalex.mjs search "<query>" [--n 25] [--from YEAR] [--to YEAR] [--sort relevance|cited]
  node openalex.mjs work <doi | W-id | arxiv id>
  node openalex.mjs refs <id> [--n 50]
  node openalex.mjs cites <id> [--n 25] [--sort cited|recent]
  any command: [--full-abstract]
`;
export const NO_KEY_MSG = 'OPENALEX_API_KEY is not set; it is free at openalex.org (settings → API key): export OPENALEX_API_KEY=... or put OPENALEX_API_KEY=... in ./.env';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (KEY ? String(s).split(KEY).join('<api_key>') : String(s));

let costUsd = 0;
let remainingUsd = null;

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

/** GET with timeout and 429/5xx retry. Returns {status, body, headers} or fails. */
async function httpGet(url, headers) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      fail(0, `${new URL(url).host}: ${e.message || e}`);
    }
    const body = await r.text();
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || i >= MAX_RETRIES) return { status: r.status, body, headers: r.headers };
    const after = Number(r.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(after) && after > 0 ? after : 5, 60) * 1000);
  }
}

/** OpenAlex call. 404 -> null; any other non-2xx -> fail(). */
async function oa(path, params = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  if (EMAIL) u.searchParams.set('mailto', EMAIL);
  const headers = { 'User-Agent': UA };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const r = await httpGet(u.toString(), headers);
  const c = Number(r.headers.get('x-ratelimit-cost-usd'));
  if (Number.isFinite(c)) costUsd += c;
  const rem = r.headers.get('x-ratelimit-remaining-usd');
  if (rem !== null && Number.isFinite(Number(rem))) remainingUsd = Number(rem);
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
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i))) return { kind: 'openalex', id: m[1].toUpperCase() };
  const a = s.replace(/^arxiv:/i, '');
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(a)) return { kind: 'arxiv', id: a.replace(/v\d+$/, '') };
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(a)) return { kind: 'arxiv', id: a.replace(/v\d+$/, '') };
  const d = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  // arXiv DOIs are not indexed under the DOI (404), so route by title.
  if ((m = d.match(/^10\.48550\/arxiv\.(.+)$/i))) return { kind: 'arxiv', id: m[1].replace(/v\d+$/, '') };
  if (/^10\.\d{4,9}\/\S+$/.test(d)) return { kind: 'doi', doi: d.toLowerCase() };
  return null;
}

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

async function arxivTitle(id) {
  const url = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const r = await httpGet(url, { 'User-Agent': UA });
  if (r.status < 200 || r.status >= 300) fail(r.status, `export.arxiv.org: ${r.body.slice(0, 300)}`);
  const entry = r.body.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry || /<id>[^<]*api\/errors/.test(entry[1])) return null;
  const t = entry[1].match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!t) return null;
  const title = decodeXml(t[1]).replace(/\s+/g, ' ').trim();
  return title && title !== 'Error' ? title : null;
}

/** Resolve an id to a raw OpenAlex work object, or null. */
async function resolveWork(raw, extraSelect = []) {
  const p = parseId(raw);
  if (!p) return null;
  const select = [...SELECT, ...extraSelect].join(',');
  if (p.kind === 'openalex') return oa(`/works/${p.id}`, { select });
  if (p.kind === 'doi') {
    const path = '/works/doi:' + encodeURIComponent(p.doi).replace(/%2F/gi, '/');
    return oa(path, { select });
  }
  const title = await arxivTitle(p.id);
  if (!title) return null;
  // `,` and `|` are AND/OR separators inside an OpenAlex filter value.
  const q = title.replace(/[,|:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const res = await oa('/works', { filter: `title.search:${q}`, per_page: 5, select });
  const want = normTitle(title);
  const hits = (res?.results || []).filter((w) => normTitle(w.title) === want);
  return hits.find((w) => arxivOf(w) === p.id) || hits[0] || null;
}

// --- output shaping ----------------------------------------------------------

const shortId = (id) => (id ? String(id).replace(/^https?:\/\/openalex\.org\//i, '') : null);

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

function abstractOf(inv, full) {
  if (!inv) return null;
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  const text = words.filter((w) => w !== undefined).join(' ');
  if (!full && text.length > 700) return text.slice(0, 700) + '…';
  return text;
}

function shape(w, full) {
  const names = (w.authorships || []).map((a) => a?.author?.display_name).filter(Boolean);
  const authors = names.slice(0, 3);
  if (names.length > 3) authors.push('et al.');
  return {
    id: shortId(w.id),
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null,
    arxiv: arxivOf(w),
    title: w.title ?? null,
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    cited_by: w.cited_by_count ?? null,
    authors,
    abstract: abstractOf(w.abstract_inverted_index, full),
  };
}

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    if (a === '--full-abstract') flags.fullAbstract = true;
    else if (['--n', '--from', '--to', '--sort'].includes(a)) {
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
  if (!KEY && command === 'search') {
    process.stderr.write(`openalex: ${NO_KEY_MSG}\n`);
    process.exit(2);
  }
  if (!KEY) process.stderr.write('openalex: no OPENALEX_API_KEY in env or ./.env — running anonymously (may 429)\n');
  const full = !!flags.fullAbstract;
  const select = SELECT.join(',');
  const base = { command, query_or_id: arg };
  const done = (extra, works) =>
    emit({ ...base, ...extra, cost_usd: Number(costUsd.toFixed(6)), remaining_usd: remainingUsd,
           results: works.map((w) => shape(w, full)) }, 0);

  if (command === 'search') {
    const n = intFlag(flags.n, 25, 200);
    const from = yearFlag(flags.from);
    const to = yearFlag(flags.to);
    const sort = flags.sort ?? 'relevance';
    if (!['relevance', 'cited'].includes(sort)) usage(2);
    let filter;
    if (from && to) filter = `publication_year:${from}-${to}`;
    else if (from) filter = `publication_year:>${from - 1}`;
    else if (to) filter = `publication_year:<${to + 1}`;
    const res = await oa('/works', {
      search: arg, per_page: n, filter, select,
      sort: sort === 'cited' ? 'cited_by_count:desc' : undefined,
    });
    return done({ count: res?.meta?.count ?? null }, res?.results || []);
  }

  if (command === 'work') {
    if (flags.n || flags.sort || flags.from || flags.to) usage(2);
    const w = await resolveWork(arg);
    if (!w) notFound(arg);
    return done({ resolved: shortId(w.id) }, [w]);
  }

  if (command === 'refs') {
    if (flags.sort || flags.from || flags.to) usage(2);
    const n = intFlag(flags.n, 50);
    const w = await resolveWork(arg, ['referenced_works']);
    if (!w) notFound(arg);
    const ids = (w.referenced_works || []).map(shortId).filter(Boolean);
    const works = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const res = await oa('/works', { filter: `openalex_id:${batch.join('|')}`, per_page: 100, select });
      works.push(...(res?.results || []));
    }
    works.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
    return done({ resolved: shortId(w.id), count: ids.length }, works.slice(0, n));
  }

  if (command === 'cites') {
    if (flags.from || flags.to) usage(2);
    const n = intFlag(flags.n, 25, 200);
    const sort = flags.sort ?? 'cited';
    if (!['cited', 'recent'].includes(sort)) usage(2);
    const w = await resolveWork(arg);
    if (!w) notFound(arg);
    const res = await oa('/works', {
      filter: `cites:${shortId(w.id)}`, per_page: n, select,
      sort: sort === 'recent' ? 'publication_date:desc' : 'cited_by_count:desc',
    });
    return done({ resolved: shortId(w.id), count: res?.meta?.count ?? null }, res?.results || []);
  }

  usage(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
