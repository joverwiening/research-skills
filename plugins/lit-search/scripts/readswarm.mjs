#!/usr/bin/env node
/**
 * readswarm — after a literature search, many cheap model calls read the FULL TEXT of the top papers and
 * return, per paper, a verdict plus verbatim passages that answer the question. Code then checks every
 * quote against the paper text, so the digest holds only passages that are in the paper.
 *
 * load     --in: litfind output (`top` then `rest`, first --top; jev_p / jev_rel carried through) or a file with one
 *          id per line (doi / arXiv id / OpenAlex W-id; title and abstract unknown).
 *          --items: generic documents instead of papers. A .jsonl with {id, text} or {id, path} per line (path
 *          relative to the .jsonl), or a directory: its regular text files, recursive, skipping dot-dirs,
 *          node_modules and files with a NUL byte in the first 8 KB; id = relative path, sorted, first --top.
 *          --in and --items are mutually exclusive.
 * fetch    papers: `node getpaper.mjs <id>` (sibling script) per paper (arxiv id, else doi, else openalex, the rest
 *          as --also), --fetch-concurrency at a time, 180 s each. Only full text is read: a paper without it is listed
 *          as not read ("abstract only" or "no text"), never sent to the model. Items: text as given, no fetching.
 * prepare  papers: a trailing references section (last such heading in the final 40 %) is cut. Longer than
 *          --max-chars: first 70 % + last 30 % of the budget with a `[... N chars omitted ...]` line.
 * read     --per-call papers per call, --concurrency calls at once, one retry. Papers get the verdicts
 *          answers / partly / background / no; items get the --choice ids ("id: meaning", repeatable, in order;
 *          default yes / partly / no). --backend (swarm-call.mjs):
 *          cli    default. `claude -p` through the claude CLI on PATH with your own login, at most 350k chars per
 *                 call, at most READSWARM_MAX_CALLS (default 8) calls at once across all readswarm runs on the machine,
 *                 300 s each. A usage-limit answer stops new calls; what finished is written.
 *          api    Messages API with ANTHROPIC_API_KEY (environment or ./.env), at most 200k chars per call (< 100k tokens).
 *          batch  Message Batches API, same key, half price, async (minutes to hours).
 *          api/batch spend is logged to ~/.cache/lit-search/swarm-api-spend.jsonl; once month-to-date + estimate would
 *          pass READSWARM_MONTHLY_CAP_USD (default 150) the rest of the run falls back to cli (run.json, digest).
 * check    every quote against the text the model saw, after normalisation (NFKC, ligatures, soft
 *          hyphens, "-\n", whitespace, case, curly quotes/dashes): exact substring, else fuzzy (≥ 85 % of
 *          the quote's word 3-grams inside one window of 2× the quote length), else not_found;
 *          under 4 words: too_short.
 * digest   verdict sections cover what was read; "not read in full" lists the rest (by jev_p); papers mode
 *          adds "Jev vs Haiku" when the input carries jev_p: no/background with jev_p >= 0.8, answers with jev_p < 0.3.
 *
 * Usage. Fetching 60 papers and reading them takes several minutes (with Claude Code's Bash tool, set timeout 600000).
 *   node readswarm.mjs --q "<question>" [--ctx "<3-4 lines of project context>"] \
 *     (--in <litfind .json | id-list file> | --items <file.jsonl | dir> [--choice "id: meaning" ...]) \
 *     [--top 60] [--per-call 5] [--max-chars 80000] [--concurrency 6] \
 *     [--fetch-concurrency 3] [--model claude-haiku-5-5] [--backend cli|api|batch] [--out DIR] [--dry-run]
 * Writes results.jsonl, digest.md and run.json to --out (default ./readswarm/<date>-<slug>/); --dry-run
 * fetches and prepares but stops before the model calls and writes run.json + batches.json.
 * Exit 0 outputs written, 2 bad args.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseId } from './openalex.mjs';
import {
  acquireSlot, runChild, CLI, cliEnv, readEnvFile, createBudget, estimateUsd, priceUsage, apiMessage, batchRun, API_BASE_DEFAULT, STATE_DIR,
} from './swarm-call.mjs';

export { acquireSlot };

// SWARM_SPEND_LEDGER / SWARM_API_BASE / SWARM_BACKOFF_MS / SWARM_BATCH_POLL_MS: test hooks (mock server, temp ledger).
const ENVF = readEnvFile(join(process.cwd(), '.env'));
const setting = (k) => process.env[k] || ENVF[k] || '';
const API_KEY = setting('ANTHROPIC_API_KEY');
const SECRETS = [API_KEY, process.env.CLAUDE_CODE_OAUTH_TOKEN].filter((s) => s && s.length > 8);
const redact = (s) => SECRETS.reduce((acc, k) => acc.split(k).join('<key>'), String(s));

const CALL_CHAR_CAP = 350000;
// api/batch: Haiku 5.5 input price jumps 5x above 100k prompt tokens; paper text is ~2.4 chars/token.
const API_CALL_CHAR_CAP = 200000;
const API_MAX_TOKENS = 16000;
const FETCH_TIMEOUT_MS = 180000;
const CALL_TIMEOUT_MS = 300000;
const SYS = 'You read scientific papers and answer only in the requested JSON.';
const SYS_ITEMS = 'You read documents and answer only in the requested JSON.';
const VERDICTS = ['answers', 'partly', 'background', 'no'];
const DEFAULT_CHOICES = [
  { id: 'yes', meaning: 'the document answers the question directly.' },
  { id: 'partly', meaning: 'it addresses part of the question or a close variant of it.' },
  { id: 'no', meaning: 'it does not answer the question.' },
];
const JEV_HIGH = 0.8;
const JEV_LOW = 0.3;
const BACKENDS = ['cli', 'api', 'batch'];

const USAGE = `usage: node readswarm.mjs --q "<question>" [--ctx "<context>"]
  (--in <litfind .json | id-list file> | --items <file.jsonl | dir> [--choice "id: meaning" ...])
  [--top 60] [--per-call 5] [--max-chars 80000] [--concurrency 6] [--fetch-concurrency 3]
  [--model claude-haiku-5-5] [--backend cli|api|batch] [--out DIR] [--dry-run]
`;

// --- pure functions (tested in readswarm.test.mjs) ----------------------------------------

const FLAGS = new Set(['q', 'ctx', 'in', 'items', 'top', 'per-call', 'max-chars', 'concurrency', 'fetch-concurrency', 'model', 'out', 'backend']);
const MULTI = new Set(['choice']);
const BOOL = new Set(['dry-run']);

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const k = t.slice(2);
    if (BOOL.has(k)) { a[k] = true; continue; }
    if (!FLAGS.has(k) && !MULTI.has(k)) throw new Error(`unknown flag: ${t}`);
    if (i + 1 >= argv.length) throw new Error(`missing value for ${t}`);
    if (MULTI.has(k)) (a[k] ||= []).push(argv[++i]);
    else a[k] = argv[++i];
  }
  return a;
}

export function slugOf(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'question';
}

export function normalizeForMatch(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/­/g, '')
    .replace(/-[ \t]*\r?\n\s*/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// normText may be passed precomputed when many quotes are checked against one paper.
// 3-grams at 85 %: one changed word anywhere in a 30-word quote stays fuzzy (3 of 28 grams lost),
// a paraphrase does not.
const G = 3;
const FUZZY_SHARE = 0.85;

export function checkQuote(quote, text, normText = null) {
  const q = normalizeForMatch(quote);
  const qw = q ? q.split(' ') : [];
  if (qw.length < 4) return 'too_short';
  const t = normText ?? normalizeForMatch(text);
  if (t.includes(q)) return 'exact';
  const tw = t.split(' ');
  const pos = new Map();
  for (let i = 0; i + G <= tw.length; i++) {
    const g = tw.slice(i, i + G).join(' ');
    const l = pos.get(g);
    if (l) l.push(i); else pos.set(g, [i]);
  }
  const nGrams = qw.length - G + 1;
  const need = Math.ceil(FUZZY_SHARE * nGrams);
  const hits = [];
  const found = new Set();
  for (let j = 0; j < nGrams; j++) {
    const l = pos.get(qw.slice(j, j + G).join(' '));
    if (!l) continue;
    found.add(j);
    for (const p of l) hits.push([p, j]);
  }
  if (found.size < need) return 'not_found';
  hits.sort((x, y) => x[0] - y[0]);
  const win = 2 * qw.length;
  const cnt = new Map();
  let distinct = 0;
  let lo = 0;
  for (let hi = 0; hi < hits.length; hi++) {
    const g = hits[hi][1];
    cnt.set(g, (cnt.get(g) || 0) + 1);
    if (cnt.get(g) === 1) distinct++;
    while (hits[hi][0] - hits[lo][0] >= win) {
      const h = hits[lo++][1];
      cnt.set(h, cnt.get(h) - 1);
      if (cnt.get(h) === 0) distinct--;
    }
    if (distinct >= need) return 'fuzzy';
  }
  return 'not_found';
}

export function stripReferences(text) {
  // pdftotext renders small caps as 'R EFERENCES'.
  const re = /^\s*(r ?eferences|b ?ibliography|l ?iterature cited)\s*$/i;
  const lines = text.split('\n');
  let off = 0;
  let cut = -1;
  for (const line of lines) {
    if (re.test(line) && off >= 0.6 * text.length) cut = off;
    off += line.length + 1;
  }
  return cut >= 0 ? text.slice(0, cut).replace(/\s+$/, '') : text;
}

export function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(0.7 * maxChars);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n[... ${omitted} chars omitted ...]\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

export function prepareText(text, maxChars) {
  return truncateText(stripReferences(text), maxChars);
}

// items: [{chars, ...}] in reading order; returns arrays of items.
export function makeBatches(items, perCall, charCap = CALL_CHAR_CAP) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= perCall || chars + it.chars > charCap)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.chars;
  }
  if (cur.length) out.push(cur);
  return out;
}

const isRowArray = (v) => Array.isArray(v) && v.length > 0 && v.every((o) => o && typeof o === 'object' && !Array.isArray(o));

export function parseModelOutput(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const tries = [s];
  for (const m of s.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)) tries.push(m[1].trim());
  const last = s.lastIndexOf(']');
  if (last > 0) {
    for (let i = s.indexOf('['); i >= 0 && i < last; i = s.indexOf('[', i + 1)) tries.push(s.slice(i, last + 1));
  }
  for (const c of tries) {
    try {
      const v = JSON.parse(c);
      if (isRowArray(v)) return v;
    } catch { /* next */ }
  }
  return null;
}

// j: the parsed stdout of `claude -p --output-format json`.
export function isUsageLimit(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.modelUsage && Object.keys(j.modelUsage).includes('<synthetic>')) return true;
  if (j.is_error) return true;
  const txt = String(j.result ?? '');
  return /usage limit|rate limit|limit reached|hit your \w+ limit/i.test(txt) && parseModelOutput(txt) === null;
}

export function loadPapers(raw, top) {
  let j = null;
  try { j = JSON.parse(raw); } catch { /* id list */ }
  if (j && typeof j === 'object' && (Array.isArray(j.top) || Array.isArray(j.rest))) {
    return [...(j.top || []), ...(j.rest || [])].slice(0, top).map((p, i) => ({
      rank: p.rank ?? i + 1, title: p.title ?? null, year: p.year ?? null, authors: p.authors ?? null,
      doi: p.doi ?? null, arxiv: p.arxiv ?? null, openalex: p.openalex ?? null, abstract: p.abstract ?? null,
      jev_p: typeof p.jev_p === 'number' ? p.jev_p : null, ...(p.jev_rel !== undefined ? { jev_rel: p.jev_rel } : {}),
    }));
  }
  const ids = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return ids.slice(0, top).map((id, i) => {
    const p = parseId(id);
    return {
      rank: i + 1, title: null, year: null, authors: null,
      doi: p?.kind === 'doi' ? p.doi : null,
      arxiv: p?.kind === 'arxiv' ? p.id : null,
      openalex: p?.kind === 'openalex' ? p.id : null,
      abstract: null, jev_p: null,
      ...(p ? {} : { raw_id: id }),
    };
  });
}

export const fetchIdOf = (p) => p.arxiv || p.doi || p.openalex || p.raw_id || null;
// every id the paper has, best first: getpaper tries the rest (--also) when the first finds no full text
export const fetchIdsOf = (p) => [...new Set([p.arxiv, p.doi, p.openalex, p.raw_id].filter(Boolean))];
export const getpaperArgs = (ids) => [ids[0], ...ids.slice(1).flatMap((x) => ['--also', x])];

export function parseChoices(list) {
  if (!list?.length) return DEFAULT_CHOICES;
  const out = list.map((c) => {
    const m = String(c).match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) throw new Error(`--choice must be "id: meaning", got ${JSON.stringify(c)}`);
    return { id: m[1], meaning: m[2].trim() };
  });
  if (new Set(out.map((c) => c.id)).size !== out.length) throw new Error('--choice ids must be distinct');
  return out;
}

function hasNul(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
}

// Regular text files under root, sorted relative paths, first `top`.
export function listTextFiles(root, top) {
  const all = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(f); } else if (e.isFile()) all.push(relative(root, f).split(sep).join('/'));
    }
  };
  walk(root);
  all.sort();
  const out = [];
  for (const r of all) {
    if (out.length >= top) break;
    if (!hasNul(join(root, r))) out.push(r);
  }
  return out;
}

// --items: a directory or a .jsonl of {id, text} / {id, path}. Returns items with raw_text (null when none).
export function loadItems(src, top) {
  const readText = (f) => { try { return { text: readFileSync(f, 'utf8') }; } catch (e) { return { text: null, status: e.code === 'ENOENT' ? 'missing' : 'unreadable' }; } };
  if (statSync(src).isDirectory()) {
    return listTextFiles(src, top).map((id, i) => ({ rank: i + 1, id, path: join(src, id), raw_text: readText(join(src, id)).text }));
  }
  const lines = readFileSync(src, 'utf8').split('\n');
  const out = [];
  for (let n = 0; n < lines.length && out.length < top; n++) {
    if (!lines[n].trim()) continue;
    let o;
    try { o = JSON.parse(lines[n]); } catch { throw new Error(`--items line ${n + 1}: not JSON`); }
    if (!o || typeof o !== 'object') throw new Error(`--items line ${n + 1}: not an object`);
    const it = { rank: out.length + 1, id: String(o.id ?? out.length + 1) };
    if (typeof o.text === 'string') it.raw_text = o.text;
    else if (typeof o.path === 'string') {
      it.path = resolve(dirname(src), o.path);
      const r = readText(it.path);
      it.raw_text = r.text;
      if (r.status) it.fetch_status = r.status;
    } else it.raw_text = null;
    out.push(it);
  }
  return out;
}

export function buildItemPrompt(q, ctx, batch, choices = DEFAULT_CHOICES) {
  const ids = choices.map((c) => `"${c.id}"`).join('|');
  const head = `Research question: ${q}\n\n`
    + (ctx ? `Context (who is asking and why):\n${ctx}\n\n` : '')
    + `You read documents. Below are ${batch.length} documents, labelled P1..P${batch.length}. Read each one and judge what it contributes to the question.\n\n`
    + 'Verdicts:\n'
    + choices.map((c) => `- "${c.id}": ${c.meaning}\n`).join('') + '\n'
    + 'Return ONE JSON array with exactly one object per document, in this form:\n'
    + `[{"pid":"P1","verdict":${ids},"claim":"one sentence: what this document says or shows that bears on the question, or why it does not","quotes":["verbatim passage", ...]}]\n\n`
    + 'Quotes: 0 to 3 per document, for any verdict, each at most 400 characters, copied EXACTLY from the document text: no paraphrase, '
    + 'no ellipses inside a quote, no added or changed words. Pick the passages that best support the claim. '
    + 'Every quote is checked against the document text by a program, and a quote that is not found there is discarded.\n\n'
    + 'Output only the JSON array.\n\n';
  return head + batch.map((p, k) => `=== P${k + 1} | ${p.id} ===\n${p.text}`).join('\n\n') + '\n';
}

export function buildPrompt(q, ctx, batch) {
  const head = `Research question: ${q}\n\n`
    + (ctx ? `Project context (who is asking and why):\n${ctx}\n\n` : '')
    + `Below are ${batch.length} papers, labelled P1..P${batch.length}. Read each one and judge what it contributes to the research question.\n\n`
    + 'Verdicts:\n'
    + '- "answers": the paper gives a direct result or argument on the question.\n'
    + '- "partly": it addresses part of the question or a close variant of it.\n'
    + '- "background": same topic, but it does not answer the question.\n'
    + '- "no": off topic.\n\n'
    + 'Return ONE JSON array with exactly one object per paper, in this form:\n'
    + '[{"pid":"P1","verdict":"answers"|"partly"|"background"|"no","claim":"one sentence: what this paper says or shows that bears on the question, or why it does not","quotes":["verbatim passage", ...]}]\n\n'
    + 'Quotes: 0 to 3 per paper, each at most 400 characters, copied EXACTLY from the paper text: no paraphrase, '
    + 'no ellipses inside a quote, no added or changed words. Pick the passages that best support the claim. '
    + 'Every quote is checked against the paper text by a program, and a quote that is not found there is discarded. '
    + 'Use an empty quotes list for "no".\n\nOutput only the JSON array.\n\n';
  return head + batch.map((p, k) => `=== P${k + 1} | ${p.title || fetchIdOf(p) || 'untitled'} (${p.year ?? 'n.d.'}) | source: ${p.source} ===\n${p.text}`).join('\n\n') + '\n';
}

export const callCharCap = (backend) => (backend === 'api' || backend === 'batch' ? API_CALL_CHAR_CAP : CALL_CHAR_CAP);

// Returns { backend, reason }: the backend the run starts with.
export function resolveBackend(requested, { key, monthToDate, cap }) {
  if (requested === 'cli') return { backend: 'cli', reason: null };
  if (!key) return { backend: 'cli', reason: 'ANTHROPIC_API_KEY not set' };
  if (monthToDate >= cap) return { backend: 'cli', reason: `monthly cap: $${monthToDate.toFixed(2)} of $${cap} spent` };
  return { backend: requested, reason: null };
}

// --- I/O ----------------------------------------------------------------------------------

async function runPool(jobs, n) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}

async function fetchPaper(p) {
  const ids = fetchIdsOf(p);
  let gp = null;
  if (ids.length) {
    // READSWARM_GETPAPER_SCRIPT: test hook (fake full text)
    const r = await runChild(process.execPath, [process.env.READSWARM_GETPAPER_SCRIPT || join(import.meta.dirname, 'getpaper.mjs'), ...getpaperArgs(ids)], { env: process.env, cwd: process.cwd(), ms: FETCH_TIMEOUT_MS });
    try { gp = JSON.parse(r.out); } catch { gp = { status: r.killed ? 'timeout' : 'error', reason: r.err.slice(-200) }; }
  }
  if (gp?.meta?.title && !p.title) p.title = gp.meta.title;
  if (gp?.meta?.year && !p.year) p.year = gp.meta.year;
  p.fetch_status = gp?.status ?? 'no-id';
  if (gp?.status === 'ok' && gp.matched_by === 'title') p.read_via = `title match${gp.resolved?.arxiv ? ` arXiv:${gp.resolved.arxiv}` : ''}`;
  else if (gp?.status === 'ok' && gp.matched_input && gp.matched_input !== ids[0]) p.read_via = gp.matched_input;
  // under 8k chars is a poster or conference abstract, not a paper
  if (gp?.status === 'ok' && gp.short) {
    p.source = 'abstract';
    p.short_text = true;
  } else if (gp?.status === 'ok' && gp.text_path && existsSync(gp.text_path)) {
    p.source = 'fulltext';
    p.raw_text = readFileSync(gp.text_path, 'utf8');
    p.text_path = gp.text_path;
  } else if (p.abstract) {
    p.source = 'abstract';
  } else {
    p.source = 'none';
  }
}

const isRead = (p) => p.source === 'fulltext' || p.source === 'text';

function digestMd(q, model, papers, run, { items = false, verdicts = VERDICTS } = {}) {
  const L = [];
  const read = papers.filter(isRead);
  const byV = Object.fromEntries(verdicts.map((v) => [v, read.filter((p) => p.verdict === v)]));
  const checks = {};
  for (const p of read) for (const x of p.quotes || []) checks[x.check] = (checks[x.check] || 0) + 1;
  const bySrc = {};
  for (const p of papers) bySrc[p.source] = (bySrc[p.source] || 0) + 1;
  L.push(`# readswarm: ${q}`, '');
  L.push(`- model: ${model}`);
  const bk = run.backend || {};
  if (bk.start) {
    L.push(`- backend: ${bk.start}${bk.start_reason ? ` (requested ${bk.requested}: ${bk.start_reason})` : ''}`
      + `${bk.fallback ? `; fell back to cli from call ${bk.fallback.from_call}: ${bk.fallback.reason}` : ''}`
      + `${run.api?.spend_usd ? `; api spend $${run.api.spend_usd.toFixed(4)}` : ''}`);
  }
  if (items) L.push(`- read: ${read.length} of ${papers.length} items (no text ${papers.length - read.length})`);
  else L.push(`- full text: ${read.length} of ${papers.length} read in full (abstract only ${bySrc.abstract || 0}, no text ${bySrc.none || 0})`);
  L.push(`- verdicts${items ? '' : ' (full text only)'}: ${verdicts.map((v) => `${v} ${byV[v].length}`).join(', ')}, failed ${read.filter((p) => !p.verdict).length}`);
  L.push(`- quote checks: ${['exact', 'fuzzy', 'not_found', 'too_short'].map((c) => `${c} ${checks[c] || 0}`).join(', ')}`);
  if (!items) L.push(`- sources: ${['fulltext', 'abstract', 'none'].map((s) => `${s} ${bySrc[s] || 0}`).join(', ')}`);
  if (run.stop_reason) L.push(`- run: ${run.stop_reason}`);
  L.push('');
  const idOf = (p) => (p.id != null ? p.id : p.doi ? `doi:${p.doi}` : p.arxiv ? `arXiv:${p.arxiv}` : p.openalex || p.raw_id || '');
  const t = (p) => (items ? p.id : `${p.title || idOf(p)} (${p.year ?? 'n.d.'})`);
  const full = items ? verdicts : verdicts.filter((v) => v !== 'no');
  for (const v of full) {
    if (!byV[v].length) continue;
    L.push(`## ${v}`, '');
    for (const p of byV[v]) {
      L.push(items ? `### ${p.id}` : `### ${t(p)} ${idOf(p)}`);
      L.push(`source: ${p.source}${p.read_via ? ` via ${p.read_via}` : ''}${p.truncated ? ' (truncated)' : ''}`, '');
      L.push(p.claim || '(no claim)', '');
      for (const x of p.quotes) {
        if (x.check !== 'exact' && x.check !== 'fuzzy') continue;
        L.push(`> ${x.text.replace(/\s*\n\s*/g, ' ')}${x.check === 'fuzzy' ? ' [fuzzy match]' : ''}`, '');
      }
      const failed = p.quotes.filter((x) => x.check !== 'exact' && x.check !== 'fuzzy').length;
      if (failed) L.push(`(${failed} quotes failed the check)`, '');
    }
  }
  if (!items && byV.no?.length) L.push(`**no:** ${byV.no.map(t).join('; ')}`, '');
  const failedReads = read.filter((p) => !p.verdict);
  if (failedReads.length) L.push(`**read failed:** ${failedReads.map((p) => `${t(p)} [${p.error || 'not read'}]`).join('; ')}`, '');
  if (!items) {
    const hasJ = (p) => typeof p.jev_p === 'number';
    const mism = read.filter((p) => hasJ(p) && (((p.verdict === 'no' || p.verdict === 'background') && p.jev_p >= JEV_HIGH) || (p.verdict === 'answers' && p.jev_p < JEV_LOW)));
    if (mism.length) {
      L.push('## Jev vs Haiku', '');
      for (const p of mism) L.push(`- ${t(p)} ${idOf(p)}: verdict ${p.verdict}, jev_p ${p.jev_p.toFixed(2)}`);
      L.push('');
    }
  }
  const jp = (p) => (typeof p.jev_p === 'number' ? p.jev_p : -1);
  const notRead = papers.map((p, i) => [p, i]).filter(([p]) => !isRead(p)).sort(([x, i], [y, j]) => jp(y) - jp(x) || i - j).map(([p]) => p);
  if (notRead.length) {
    L.push('## not read in full', '');
    for (const p of notRead) {
      L.push(`- ${items ? p.id : `${t(p)} ${idOf(p)}`}${typeof p.jev_p === 'number' ? `; jev_p ${p.jev_p.toFixed(2)}` : ''}; ${p.not_read}`);
    }
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const T0 = Date.now();
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`readswarm: ${e.message}\n\n${USAGE}`); process.exit(2); }
  const die = (m) => { process.stderr.write(`readswarm: ${m}\n\n${USAGE}`); process.exit(2); };
  if (!a.q) die('--q is required');
  if (a.in && a.items) die('--in and --items are mutually exclusive');
  if (!a.in && !a.items) die('--in or --items is required');
  if (a.in && !existsSync(a.in)) die(`--in not found: ${a.in}`);
  if (a.items && !existsSync(a.items)) die(`--items not found: ${a.items}`);
  if (a.in && a.choice) die('--choice needs --items');
  let choices;
  try { choices = parseChoices(a.choice); } catch (e) { die(e.message); }
  const num = (k, d) => {
    if (a[k] === undefined) return d;
    const n = Number(a[k]);
    if (!Number.isInteger(n) || n < 1) die(`--${k} must be a positive integer`);
    return n;
  };
  const opt = {
    q: a.q, ctx: a.ctx || '', in: a.in ? resolve(a.in) : null, items: a.items ? resolve(a.items) : null,
    choices: a.items ? choices : null, top: num('top', 60), perCall: num('per-call', 5),
    maxChars: num('max-chars', 80000), concurrency: num('concurrency', 6), fetchConcurrency: num('fetch-concurrency', 3),
    model: a.model || 'claude-haiku-5-5', dryRun: !!a['dry-run'], backend: a.backend || 'cli',
  };
  if (!BACKENDS.includes(opt.backend)) die(`--backend must be one of ${BACKENDS.join('|')}`);
  const outDir = resolve(a.out || join('readswarm', `${new Date().toISOString().slice(0, 10)}-${slugOf(opt.q)}`));
  opt.out = outDir;

  const key = API_KEY || null;
  const cap = Number(setting('READSWARM_MONTHLY_CAP_USD')) || 150;
  const budget = createBudget({ ledger: process.env.SWARM_SPEND_LEDGER || join(STATE_DIR, 'swarm-api-spend.jsonl'), cap });
  const mtd0 = budget.monthToDate();
  const start = resolveBackend(opt.backend, { key, monthToDate: mtd0, cap });
  const charCap = callCharCap(start.backend);
  if (opt.maxChars > charCap) die(`--max-chars must be at most ${charCap} with backend ${start.backend}`);
  const runId = `${slugOf(opt.q)}-${T0}`;

  const itemsMode = !!opt.items;
  let papers;
  if (itemsMode) {
    try { papers = loadItems(opt.items, opt.top); } catch (e) { die(e.message); }
  } else papers = loadPapers(readFileSync(opt.in, 'utf8'), opt.top);
  if (!papers.length) die(itemsMode ? 'no items in --items' : 'no papers in --in');
  mkdirSync(outDir, { recursive: true });

  const tf = Date.now();
  if (itemsMode) for (const p of papers) p.source = p.raw_text?.trim() ? 'text' : 'none';
  else await runPool(papers.map((p) => () => fetchPaper(p)), opt.fetchConcurrency);
  const fetchMs = Date.now() - tf;

  for (const p of papers) {
    if (!isRead(p)) {
      p.chars = 0;
      p.truncated = false;
      p.not_read = p.short_text ? 'abstract only (short text under 8k chars)' : p.source === 'abstract' ? 'abstract only' : 'no text';
      delete p.raw_text;
      continue;
    }
    const r = itemsMode ? truncateText(p.raw_text, opt.maxChars) : prepareText(p.raw_text, opt.maxChars);
    p.text = r.text;
    p.truncated = r.truncated;
    p.chars = r.text.length;
    delete p.raw_text;
  }
  const readable = papers.filter(isRead);
  const allowed = itemsMode ? opt.choices.map((c) => c.id) : VERDICTS;
  const sys = itemsMode ? SYS_ITEMS : SYS;
  const batches = makeBatches(readable, opt.perCall, charCap);
  batches.forEach((b, i) => b.forEach((p, k) => { p.call_id = i + 1; p.pid = `P${k + 1}`; }));

  const srcCount = Object.fromEntries((itemsMode ? ['text', 'none'] : ['fulltext', 'abstract', 'none']).map((s) => [s, papers.filter((p) => p.source === s).length]));
  const fulltext = { read: readable.length, abstract_only: srcCount.abstract || 0, none: srcCount.none,
    share: papers.length ? Number((readable.length / papers.length).toFixed(3)) : 0 };
  const srcLine = Object.entries(srcCount).map(([k, v]) => `${k} ${v}`).join(', ');
  const run = {
    run_id: runId, args: { ...opt, ctx: opt.ctx || null }, started: new Date(T0).toISOString(),
    backend: { requested: opt.backend, start: start.backend, start_reason: start.reason, fallback: null },
    api: { cap_usd: cap, month_to_date_start_usd: Number(mtd0.toFixed(6)), spend_usd: 0 },
    timings: { fetch_ms: fetchMs }, sources: srcCount, fulltext, calls: [], totals: {}, stop_reason: null,
  };

  if (opt.dryRun) {
    const bj = batches.map((b, i) => ({
      call_id: i + 1, chars: b.reduce((s, p) => s + p.chars, 0),
      papers: b.map((p) => ({ pid: p.pid, rank: p.rank, title: p.title ?? null, id: p.id ?? fetchIdOf(p), source: p.source, chars: p.chars, truncated: p.truncated })),
    }));
    const unread = papers.filter((p) => !isRead(p)).map((p) => ({ rank: p.rank, title: p.title ?? null, id: p.id ?? fetchIdOf(p), not_read: p.not_read, fetch_status: p.fetch_status ?? null }));
    writeFileSync(join(outDir, 'batches.json'), redact(JSON.stringify({ calls: bj, not_read: unread }, null, 1)));
    run.stop_reason = 'dry run';
    run.timings.total_ms = Date.now() - T0;
    run.totals = { papers: papers.length, calls: batches.length, chars: bj.reduce((s, b) => s + b.chars, 0) };
    run.batches = bj.map((b) => ({ call_id: b.call_id, papers: b.papers.length, chars: b.chars }));
    writeFileSync(join(outDir, 'run.json'), redact(JSON.stringify(run, null, 1)));
    process.stdout.write([
      `readswarm dry run: ${papers.length} ${itemsMode ? 'items' : 'papers'} — ${srcLine}`,
      `${batches.length} calls (backend ${start.backend}), chars per call: ${bj.map((b) => b.chars).join(', ')}`,
      `fetch ${(fetchMs / 1000).toFixed(0)} s`,
      `batches: ${join(outDir, 'batches.json')}`,
    ].join('\n') + '\n');
    return;
  }

  const argv = ['-p', '--model', opt.model, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
    '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', sys];
  const base = process.env.SWARM_API_BASE || API_BASE_DEFAULT;
  const backoffMs = Number(process.env.SWARM_BACKOFF_MS) || 2000;
  let stopped = null;
  const setFallback = (callId, reason) => { if (!run.backend.fallback) run.backend.fallback = { to: 'cli', from_call: callId, reason }; };
  const useApi = () => start.backend !== 'cli' && !run.backend.fallback;
  const ledgerRec = (backend, model, u, usd) => ({
    run: runId, backend, model, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, usd: Number(usd.toFixed(6)),
  });
  const calls = batches.map((b, i) => ({ call_id: i + 1, papers: b.map((p) => p.rank), chars: b.reduce((s, p) => s + p.chars, 0), backend: null,
    attempt_backends: [], attempts: 0, ms: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cost_usd: 0, models: [], error: null }));
  run.calls = calls;
  const addUsage = (call, u, usd, model) => {
    call.input_tokens += u.input_tokens || 0;
    call.output_tokens += u.output_tokens || 0;
    call.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    call.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    call.cost_usd += usd;
    run.api.spend_usd += usd;
    if (model && !call.models.includes(model)) call.models.push(model);
  };
  const prompts = batches.map((b) => (itemsMode ? buildItemPrompt(opt.q, opt.ctx, b, opt.choices) : buildPrompt(opt.q, opt.ctx, b)));
  const applyRows = (b, rows) => {
    const byPid = new Map();
    for (const o of rows) if (o && typeof o.pid === 'string' && !byPid.has(o.pid.trim().toUpperCase())) byPid.set(o.pid.trim().toUpperCase(), o);
    for (const p of b) {
      const o = byPid.get(p.pid);
      if (!o) { p.error = 'missing from model output'; continue; }
      p.verdict = allowed.includes(o.verdict) ? o.verdict : null;
      if (!p.verdict) p.error = `bad verdict: ${String(o.verdict).slice(0, 40)}`;
      p.claim = typeof o.claim === 'string' ? o.claim : null;
      const nt = normalizeForMatch(p.text);
      p.quotes = (Array.isArray(o.quotes) ? o.quotes : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)
        .map((x) => ({ text: x, check: checkQuote(x, null, nt) }));
    }
  };
  const done = new Set();
  const tm = Date.now();

  if (start.backend === 'batch') {
    const reqs = [];
    const ests = new Map();
    for (let i = 0; i < batches.length; i++) {
      const est = estimateUsd(opt.model, prompts[i].length, API_MAX_TOKENS, { batch: true });
      if (est == null) { setFallback(i + 1, `no price for ${opt.model}`); break; }
      if (!budget.tryReserve(est)) { setFallback(i + 1, `monthly cap $${cap} reached`); break; }
      ests.set(i, est);
      reqs.push({ custom_id: `call-${i + 1}`, model: opt.model, system: sys, prompt: prompts[i], maxTokens: API_MAX_TOKENS });
    }
    if (reqs.length) {
      const t = Date.now();
      const br = await batchRun({ base, key, requests: reqs, pollMs: Number(process.env.SWARM_BATCH_POLL_MS) || 60000, timeoutMs: CALL_TIMEOUT_MS, backoffMs,
        onStatus: (x) => process.stderr.write(`readswarm: batch ${x.id} ${x.processing_status} ${JSON.stringify(x.request_counts || {})}\n`) });
      run.batch = { id: br.id ?? null, requests: reqs.length, ms: Date.now() - t, error: br.error ? redact(br.error) : null };
      if (br.spendCap) setFallback(1, 'api 429 without retry-after (org spend cap)');
      for (const [i, est] of ests) {
        const call = calls[i];
        call.attempts++;
        call.attempt_backends.push('batch');
        const r = br.results.get(`call-${i + 1}`);
        let usd = 0;
        if (r?.usage) { usd = priceUsage(opt.model, r.usage, { batch: true }) ?? 0; addUsage(call, r.usage, usd, r.model); }
        budget.settle(est, r?.usage ? ledgerRec('batch', r.model || opt.model, r.usage, usd) : null);
        const rows = r?.ok ? parseModelOutput(r.text) : null;
        if (rows) { call.backend = 'batch'; applyRows(batches[i], rows); done.add(i); }
      }
    }
  }

  const runCall = async (i) => {
    const b = batches[i];
    const call = calls[i];
    const prompt = prompts[i];
    if (stopped) { call.error = 'not launched: ' + stopped; for (const p of b) p.error = call.error; return; }
    let rows = null;
    let lastErr = null;
    while (call.attempts < 2 && !rows) {
      if (stopped) break;
      if (useApi()) {
        const est = estimateUsd(opt.model, prompt.length, API_MAX_TOKENS);
        if (est == null) setFallback(call.call_id, `no price for ${opt.model}`);
        else if (!budget.tryReserve(est)) setFallback(call.call_id, `monthly cap $${cap} reached`);
        else {
          call.attempts++;
          call.attempt_backends.push('api');
          const t = Date.now();
          let r;
          try {
            r = await apiMessage({ base, key, model: opt.model, system: sys, prompt, maxTokens: API_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS, backoffMs });
          } catch (e) { r = { ok: false, error: `api: ${e.message}`, usage: null }; }
          call.ms += Date.now() - t;
          let usd = 0;
          if (r.usage) { usd = priceUsage(opt.model, r.usage) ?? 0; addUsage(call, r.usage, usd, r.model); }
          budget.settle(est, r.usage ? ledgerRec('api', r.model || opt.model, r.usage, usd) : null);
          if (r.ok) {
            call.backend = 'api';
            rows = parseModelOutput(r.text);
            if (!rows) lastErr = 'unparseable model output';
          } else {
            lastErr = redact(r.error);
            if (r.spendCap) setFallback(call.call_id, 'api 429 without retry-after (org spend cap)');
          }
          continue;
        }
      }
      call.attempts++;
      call.attempt_backends.push('cli');
      const release = await acquireSlot();
      let r;
      try { r = await runChild(CLI, argv, { env: cliEnv(), cwd: tmpdir(), input: prompt, ms: CALL_TIMEOUT_MS }); } finally { release(); }
      if (r.code === -1 && /ENOENT/.test(r.err)) {
        stopped = 'stopped: claude CLI not found on PATH';
        lastErr = stopped;
        break;
      }
      call.ms += r.ms;
      let j = null;
      try { j = JSON.parse(r.out); } catch { /* below */ }
      if (j) {
        call.backend = 'cli';
        const u = j.usage || {};
        call.input_tokens += u.input_tokens || 0;
        call.output_tokens += u.output_tokens || 0;
        call.cache_read_input_tokens += u.cache_read_input_tokens || 0;
        call.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
        call.cost_usd += j.total_cost_usd || 0;
        for (const m of Object.keys(j.modelUsage || {})) if (!call.models.includes(m)) call.models.push(m);
        if (isUsageLimit(j)) {
          stopped = 'stopped: usage limit';
          lastErr = `usage limit: ${String(j.result ?? '').slice(0, 160).replace(/\s+/g, ' ')}`;
          break;
        }
        rows = parseModelOutput(j.result);
        if (!rows) lastErr = 'unparseable model output';
      } else {
        lastErr = r.killed ? `timeout after ${CALL_TIMEOUT_MS / 1000} s` : `cli exit ${r.code}: ${redact(r.err).slice(-200).replace(/\s+/g, ' ')}`;
      }
    }
    if (!rows) {
      call.error = lastErr || stopped || 'not run';
      for (const p of b) p.error = call.error;
      return;
    }
    applyRows(b, rows);
  };
  await runPool(batches.map((_, i) => i).filter((i) => !done.has(i)).map((i) => () => runCall(i)), opt.concurrency);
  run.timings.model_ms = Date.now() - tm;
  run.stop_reason = stopped || 'completed';
  run.calls.sort((x, y) => x.call_id - y.call_id);

  for (const p of papers) if (!p.quotes) p.quotes = [];
  const lines = papers.map((p) => JSON.stringify({
    ...(itemsMode
      ? { rank: p.rank, id: p.id, ...(p.path ? { path: p.path } : {}) }
      : { rank: p.rank, title: p.title, year: p.year, doi: p.doi, arxiv: p.arxiv, openalex: p.openalex, jev_p: p.jev_p ?? null,
        ...(p.jev_rel !== undefined ? { jev_rel: p.jev_rel } : {}) }),
    source: p.source, chars: p.chars, truncated: p.truncated, verdict: p.verdict ?? null, claim: p.claim ?? null, quotes: p.quotes,
    call_id: p.call_id ?? null, ...(p.read_via ? { read_via: p.read_via } : {}),
    ...(p.not_read ? { not_read: p.not_read, fetch_status: p.fetch_status ?? null } : {}),
    ...(p.error ? { error: p.error } : {}),
  }));
  writeFileSync(join(outDir, 'results.jsonl'), redact(lines.join('\n') + '\n'));
  const digestPath = join(outDir, 'digest.md');
  writeFileSync(digestPath, redact(digestMd(opt.q, opt.model, papers, run, { items: itemsMode, verdicts: allowed })));

  const sum = (k) => run.calls.reduce((s, c) => s + c[k], 0);
  const checks = {};
  for (const p of papers) for (const x of p.quotes) checks[x.check] = (checks[x.check] || 0) + 1;
  const verdicts = Object.fromEntries(allowed.map((v) => [v, papers.filter((p) => p.verdict === v).length]));
  run.totals = {
    papers: papers.length, calls: batches.length, calls_ok: run.calls.filter((c) => !c.error).length,
    input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
    cache_read_input_tokens: sum('cache_read_input_tokens'), cache_creation_input_tokens: sum('cache_creation_input_tokens'),
    cost_usd_equiv: Number(sum('cost_usd').toFixed(4)), api_spend_usd: Number(run.api.spend_usd.toFixed(6)), verdicts, quote_checks: checks,
  };
  run.timings.total_ms = Date.now() - T0;
  writeFileSync(join(outDir, 'run.json'), redact(JSON.stringify(run, null, 1)));

  process.stdout.write(redact([
    `readswarm: ${papers.length} ${itemsMode ? 'items' : 'papers'} — ${srcLine}`,
    `${run.totals.calls_ok}/${batches.length} calls ok, ${run.stop_reason}, ${(run.timings.total_ms / 1000).toFixed(0)} s`,
    `verdicts: ${allowed.map((v) => `${v} ${verdicts[v]}`).join(', ')}, failed ${readable.filter((p) => !p.verdict).length}, not read ${papers.length - readable.length}`,
    `quotes: ${['exact', 'fuzzy', 'not_found', 'too_short'].map((c) => `${c} ${checks[c] || 0}`).join(', ')}`,
    `digest: ${digestPath}`,
  ].join('\n')) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
