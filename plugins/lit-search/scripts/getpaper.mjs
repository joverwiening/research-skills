#!/usr/bin/env node
/**
 * getpaper — resolve a DOI / arXiv id / OpenAlex id / URL to full text on disk.
 *
 * A web-fetch tool cannot read a PDF, and a landing page can look like a paper; this does the
 * download, pdftotext, and the checks that what came back is the article.
 *
 * Ladder, first success wins:
 *   arXiv PDF -> ar5iv HTML -> Europe PMC fullTextXML -> NCBI efetch JATS ->
 *   Springer Nature OA JATS -> eLife -> bioRxiv/medRxiv API -> Unpaywall
 *   repository copies -> Unpaywall publisher copy -> OpenAlex content (paid)
 *   -> the URL as given
 * PMCID / PubMed / OpenReview / ResearchGate / OSF inputs are first resolved to
 * an identifier one of those rungs understands.
 * Repository before publisher is deliberate: the publisher copy of an OA paper
 * is often behind the same Cloudflare challenge as a paywalled one, while the
 * repository mirror (OSTI, PMC, institutional) is not.
 *
 * Usage:
 *   node getpaper.mjs 10.1016/j.neuron.2018.03.044
 *   node getpaper.mjs 2502.08235
 *   node getpaper.mjs https://www.biorxiv.org/content/10.1101/2020.01.01.900000v1.full.pdf
 *   node getpaper.mjs W3171259667
 *   node getpaper.mjs 10.1088/1751-8121/ac411b --also W3171259667
 *
 * --also ids are tried in order after the first, each through its own cache
 * check and ladder; the first ok wins and is reported as matched_input.
 * A DOI or OpenAlex id that fails the ladder gets a rescue stage: OpenAlex
 * locations, the doi.org landing page, Zenodo files, then an arXiv title match
 * (reported as matched_by: "title").
 *
 * Needs `pdftotext` (poppler-utils) on PATH (GETPAPER_PDFTOTEXT overrides).
 * Optional, from the environment or ./.env: LIT_SEARCH_EMAIL (Unpaywall requires
 * an email; without it the Unpaywall rung is skipped; also sent to NCBI and Crossref),
 * SPRINGER_OA_API_KEY, NCBI_API_KEY, OPENALEX_API_KEY (OpenAlex work lookup and content rungs).
 * Cache: GETPAPER_CACHE, default <os tmpdir>/getpaper.
 *
 * Prints one JSON object. status "ok" means TEXT exists and is greppable.
 * status "no-fulltext" is a legitimate answer, not an error — it means no open
 * copy was found, and the honest move is to cite the abstract and say so.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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
loadEnvKeys(['SPRINGER_OA_API_KEY', 'NCBI_API_KEY', 'OPENALEX_API_KEY', 'LIT_SEARCH_EMAIL']);

const EMAIL = process.env.LIT_SEARCH_EMAIL || '';
const CACHE = process.env.GETPAPER_CACHE || join(tmpdir(), 'getpaper');
const PDFTOTEXT = process.env.GETPAPER_PDFTOTEXT || 'pdftotext';
const MIN_CHARS = Number(process.env.GETPAPER_MIN_CHARS || 2000);
// Markup needs a higher bar than a PDF: a repository *landing* page strips to
// 2-4 k chars of navigation and abstract, which is long enough to look like a
// paper and invites quoting something nobody read.
const MARKUP_MIN_CHARS = Number(process.env.GETPAPER_MARKUP_MIN_CHARS || 8000);
const TIMEOUT_MS = Number(process.env.GETPAPER_TIMEOUT_MS || 45000);
// Two agent strings, polite one FIRST: hal.science serves a browser UA the
// Anubis bot check and serves the identified crawler the actual PDF. Other
// repositories do the reverse, hence the fallback. Neither is a challenge
// bypass — Cloudflare hosts refuse both, and that refusal is reported rather
// than worked around.
const UAS = [
  EMAIL ? `getpaper/1.0 (mailto:${EMAIL})` : 'getpaper/1.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

// Springer Nature's free self-service key. Two keys are issued (Open Access and
// Meta); only the OA one returns full text, so only it is read here.
const SPRINGER_KEY = process.env.SPRINGER_OA_API_KEY || '';
// Optional. NCBI allows 3 requests/s unkeyed and 10/s with a key; we make at
// most two calls per paper, so the retry below is the real protection and the
// key is a convenience.
const NCBI_KEY = process.env.NCBI_API_KEY || '';
// Paid per content download out of the free $1/day budget; travels only in the
// Authorization header.
const OPENALEX_KEY = process.env.OPENALEX_API_KEY || '';
const OPENALEX_RESERVE_USD = 0.25;

/** Keys travel in the query string, so they would otherwise land in trace and
 *  in the emitted `url`. */
export function redact(s) {
  let v = String(s);
  for (const k of [SPRINGER_KEY, NCBI_KEY, OPENALEX_KEY]) if (k) v = v.split(k).join('<api_key>');
  return v;
}

// 429 is the one status where giving up is wrong: it means "ask again" (NCBI
// efetch often answers 429 first and the full article on the second call).
// Anything else (404, 403, 500) is a real answer from the rung and falls
// through immediately.
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRIES = Number(process.env.GETPAPER_MAX_RETRIES || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const trace = [];
function note(step, detail) { trace.push(redact(`${step}: ${detail}`)); }

function out(obj) {
  process.stdout.write(JSON.stringify({ ...obj, trace }, null, 2) + '\n');
  process.exit(obj.status === 'ok' ? 0 : 1);
}

export function slug(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) + '-' + createHash('sha1').update(s).digest('hex').slice(0, 8);
}

/** The cache key ladder() files an input under. */
export function cacheKey(raw) {
  const parsed = parseInput(raw);
  return slug(parsed.doi || parsed.id || parsed.pmcid || parsed.pmid || parsed.url || raw);
}

async function getOnce(url, { accept, ua = UAS[0], headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': ua, ...(accept ? { Accept: accept } : {}), ...headers },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', buf, url: r.url,
      retryAfter: r.headers.get('retry-after'),
      costUsd: r.headers.get('x-ratelimit-cost-usd'),
      remainingUsd: r.headers.get('x-ratelimit-remaining-usd'),
    };
  } catch (e) {
    return { ok: false, status: 0, type: '', buf: Buffer.alloc(0), url, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url, opts = {}) {
  const retries = opts.retries ?? MAX_RETRIES;
  for (let i = 0; ; i++) {
    const r = await getOnce(url, opts);
    if (!RETRY_STATUSES.has(r.status) || i >= retries) return r;
    const after = Number(r.retryAfter);
    const wait = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * 3 ** i, 15000);
    note('rate-limit', `HTTP ${r.status} from ${hostOf(url)}, waiting ${wait} ms then retrying`);
    await sleep(wait);
  }
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return '?'; }
}

async function getJson(url, opts = {}) {
  const r = await get(url, { accept: 'application/json', ...opts });
  if (!r.ok) return { error: `HTTP ${r.status}${r.error ? ' ' + r.error : ''}`, res: r };
  try { return { data: JSON.parse(r.buf.toString('utf8')), res: r }; }
  catch { return { error: 'non-JSON response', res: r }; }
}

/**
 * The accept/reject predicates below decide whether a 200 response is the
 * article or something that merely looks like one. Pure and exported so they
 * can be tested without the network.
 */

/** Cloudflare / Anubis / cookie-wall bodies: HTML, 200, and not the document. */
export function isBotChallenge(body) {
  return /Just a moment|cf-browser-verification|Making sure you're not a bot|Enable JavaScript and cookies|error=cookies_not_supported/i.test(body);
}

/**
 * PMC answers its own /pdf/ route with a ~1.8 kB "Preparing to download" page
 * instead of the file. Length-bounded so a real article that happens to contain
 * the phrase is not thrown away.
 */
export function isDownloadInterstitial(body) {
  return /Preparing to download/i.test(body) && body.length < 8000;
}

/**
 * JATS with no <body> is a metadata record — what the archives return for a
 * deposit they hold only front matter for. The length floor does not catch it:
 * a paper with many authors and references clears any floor on front matter alone.
 */
export function hasArticleBody(body) {
  return /<body[\s>]/i.test(body);
}

/**
 * A PMC author-manuscript deposit is the accepted manuscript, not the version of
 * record — different wording and pagination from what a reader of the journal
 * sees, so it gets a version warning.
 */
export function pmcVersionFrom(raw) {
  return /pub-id-type="manuscript"|HHS Public Access|Author manuscript/i.test(raw)
    ? 'acceptedVersion'
    : 'publishedVersion';
}

/** Preprint banner in the first 2 kB, for copies Unpaywall gives no version for. */
export function sniffPreprint(text) {
  return /^[\s\S]{0,2000}?(bioRxiv|medRxiv) preprint/i.test(text) ? 'preprint' : null;
}

/** A truncated download still starts with %PDF- and pdftotext extracts its
 *  first pages, so without the trailer check a partial file passes as a paper. */
export function hasPdfTrailer(buf) {
  return buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF');
}

/**
 * HTML/XML -> text. Crude but sufficient: we grep this, we do not render it.
 * Section headings become `## X` lines so a reader can locate Methods/Results.
 * An HTML <head> (title/meta/link inside) is dropped; a TEI <head> is a heading.
 */
export function markupToText(s) {
  const heading = (x) => (x.trim() ? `\n\n## ${x}\n` : ' ');
  return s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi,
      (_, inner) => (/<(title|meta|link|base)\b/i.test(inner) ? ' ' : heading(inner)))
    .replace(/<sec\b[^>]*>\s*(?:<label\b[^>]*>([\s\S]*?)<\/label>\s*)?<title\b[^>]*>([\s\S]*?)<\/title>/gi,
      (_, label, title) => heading(label ? `${label} ${title}` : title))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _n, x) => heading(x))
    .replace(/(<\/(?:p|div|sec|li)>|<br\s*\/?>)/gi, '$1\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * DSpace 7 serves /bitstreams/<uuid>/download as 405 to non-browser clients but
 * the REST path returns the file.
 */
export function dspaceRestUrl(url) {
  const m = url.match(/^(https?:\/\/[^/]+)\/bitstreams\/([0-9a-f-]{36})\/download\b/i);
  return m ? `${m[1]}/server/api/core/bitstreams/${m[2]}/content` : null;
}

/**
 * The PDF a landing page declares for itself (Highwire citation_pdf_url, EPrints
 * document_url). Authoritative where present: on an EPrints page a preview
 * thumbnail ending in .pdf precedes the file link in the body.
 */
export function metaPdfUrl(html, base) {
  const found = {};
  for (const [tag] of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!name || !content) continue;
    const n = name.toLowerCase();
    if ((n === 'citation_pdf_url' || n === 'eprints.document_url') && !found[n]) found[n] = content.replace(/&amp;/g, '&').trim();
  }
  const hit = found.citation_pdf_url || found['eprints.document_url'];
  if (!hit) return null;
  try { return new URL(hit, base).href; } catch { return null; }
}

/** The PDF a landing page points at: its own meta declaration first, then the first plausible href. */
export function findPdfLink(html, base) {
  let url = metaPdfUrl(html, base);
  if (!url) {
    const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const hit = hrefs.find((h) => /\.pdf(\?|$)/i.test(h))
      || hrefs.find((h) => /\/(pdf|download|bitstream|file)\//i.test(h))
      || hrefs.find((h) => /\/document(\?|$)/i.test(h));
    if (!hit) return null;
    try { url = new URL(hit, base).href; } catch { return null; }
  }
  return dspaceRestUrl(url) || url;
}

/** Under this a text is likely an abstract or poster, not a paper; reported, not rejected. */
const SHORT_CHARS = 8000;
const LAYOUT_NOTE = 'tables only — this copy preserves the physical page, so on a two-column paper its lines interleave the columns and a quote taken from it will splice unrelated sentences. Quote from text_path.';
export function isShortText(chars) {
  return chars < SHORT_CHARS;
}

/**
 * Fetch one candidate and reduce it to text. Returns null when the candidate
 * does not yield MIN_CHARS, so the caller falls through to the next rung.
 * Retries once under the alternate agent string before giving up on a rung.
 */
async function tryCandidate(cand, key) {
  // singleUa: a metered API answers the same way to any agent string, and the
  // retry would spend a second call out of a daily quota to learn nothing.
  const uas = cand.singleUa ? UAS.slice(0, 1) : UAS;
  for (let i = 0; i < uas.length; i++) {
    const hit = await attempt(cand, key, uas[i], i > 0);
    if (hit) return hit;
  }
  return null;
}

function pdfToText(buf, key, label) {
  const pdfPath = join(CACHE, key + '.pdf');
  writeFileSync(pdfPath, buf);
  // Two extractions, because neither pdftotext mode does both jobs. Default
  // reading-order mode reassembles a multi-column page into one prose stream,
  // and it is the only mode a verbatim quote survives: -layout preserves the
  // physical page, so on a two-column paper the left and right columns land
  // on the SAME LINE and a quote pulled from it splices two unrelated
  // sentences into one that still reads as verbatim. -layout is still the
  // only mode that keeps a table's rows intact, so it is kept alongside for
  // reading numbers off tables — best-effort, never fatal.
  try {
    execFileSync(PDFTOTEXT, [pdfPath, join(CACHE, key + '.txt')], { timeout: TIMEOUT_MS });
  } catch (e) {
    note(label, `pdftotext failed: ${String(e.message || e).slice(0, 120)}`);
    return null;
  }
  const text = readFileSync(join(CACHE, key + '.txt'), 'utf8');
  let layoutPath = null;
  const lp = join(CACHE, key + '.layout.txt');
  try {
    execFileSync(PDFTOTEXT, ['-layout', pdfPath, lp], { timeout: TIMEOUT_MS });
    layoutPath = lp;
  } catch { /* prose copy is the contract; the table copy is a bonus */ }
  return { text, layoutPath };
}

async function attempt(cand, key, ua, isRetry) {
  const label = isRetry ? cand.label + ' [browser-ua]' : cand.label;
  const r = await get(cand.url, { ua, headers: cand.headers });
  if (cand.metered) note(label, `cost $${r.costUsd ?? '?'}, remaining $${r.remainingUsd ?? '?'}`);
  if (!r.ok) { note(label, `HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); return null; }

  const isPdf = r.buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf && cand.checkTrailer && !hasPdfTrailer(r.buf)) {
    note(label, `PDF has no %%EOF trailer (${r.buf.length} B) — truncated download`);
    return null;
  }
  let body = isPdf ? '' : r.buf.toString('utf8');

  if (!isPdf && isBotChallenge(body)) {
    note(label, 'bot challenge / cookie wall, not the document');
    return null;
  }
  // Named explicitly so the trace does not read as a transport failure when the
  // article is in fact reachable through the JATS rung two lines up.
  if (!isPdf && isDownloadInterstitial(body)) {
    note(label, `download interstitial (${r.buf.length} B), not the file`);
    return null;
  }
  if (cand.kind === 'pdf' && !isPdf) {
    note(label, `expected PDF, got ${r.type.split(';')[0] || 'unknown'} (${r.buf.length} B)`);
    return null;
  }
  // An API rung answers with JSON that carries the article markup in one field.
  // Unwrapping here rather than in the rung keeps every guard below — body
  // check, length floor, version label — applying to the article and not to the
  // envelope, whose brace-and-quote noise would clear any floor on its own.
  if (!isPdf && cand.unwrap) {
    const inner = cand.unwrap(body);
    if (!inner) { note(label, `API response carried no article payload (${r.buf.length} B)`); return null; }
    body = inner;
  }

  // HTML is full text only from the sources that serve full text as HTML
  // (ar5iv, Europe PMC, ...). Everywhere else it is a landing page until proven
  // otherwise, and its own text is never accepted — no length threshold
  // separates the two (site chrome alone can clear any floor worth setting).
  if (!isPdf && cand.requireBody && !hasArticleBody(body)) {
    note(label, `structured record with no article body (${r.buf.length} B) — metadata only`);
    return null;
  }
  if (!isPdf && !cand.trustedMarkup) {
    if (cand.noFollow) { note(label, 'HTML, not the document'); return null; }
    const link = findPdfLink(body, r.url);
    if (!link) { note(label, `landing page (${r.buf.length} B), no PDF link on it`); return null; }
    note(label, `landing page -> ${link}`);
    return tryCandidate({ label: label + '->pdf', kind: 'pdf', url: link, noFollow: true }, key);
  }

  let text;
  let layoutPath = null;
  if (isPdf) {
    const x = pdfToText(r.buf, key, label);
    if (!x) return null;
    ({ text, layoutPath } = x);
  } else {
    text = markupToText(body);
  }

  const floor = isPdf ? MIN_CHARS : MARKUP_MIN_CHARS;
  if (text.length < floor) {
    note(label, `only ${text.length} chars extracted (< ${floor}) — stub or error page, not full text`);
    return null;
  }
  const txtPath = join(CACHE, key + '.txt');
  writeFileSync(txtPath, text);
  note(label, `OK, ${text.length} chars`);
  // What the open copy IS matters for quoting: an accepted manuscript or a
  // preprint mirror has different wording and pagination from the version of
  // record, and a repository copy of a journal DOI can be the preprint.
  // Unpaywall's own label is used when it has one; otherwise the text is
  // sniffed for a preprint banner.
  const version = (cand.oaVersionFrom ? cand.oaVersionFrom(body) : cand.oaVersion) || sniffPreprint(text);
  return {
    text_path: txtPath, chars: text.length, source: cand.label, url: redact(r.url),
    format: isPdf ? 'pdf' : 'markup',
    ...(layoutPath ? { layout_text_path: layoutPath, layout_note: LAYOUT_NOTE } : {}),
    version: version || 'unknown',
    ...(version && version !== 'publishedVersion'
      ? { version_warning: `this copy is the ${version}, not the publisher's version of record — say so if you quote it` }
      : {}),
  };
}

// --- input parsing ----------------------------------------------------------

export function parseInput(raw) {
  let arg = raw.trim().replace(/^(arxiv:|arXiv:)/i, '');
  let m;
  if ((m = arg.match(/^10\.48550\/arxiv\.(.+)$/i))) return { kind: 'arxiv', id: m[1], doi: arg };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(arg)) return { kind: 'arxiv', id: arg };
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(arg)) return { kind: 'arxiv', id: arg }; // pre-2007 ids
  if ((m = arg.match(/^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d+)\/?$/i))) return { kind: 'openalex', id: m[1].toUpperCase() };
  if ((m = arg.match(/^PMC(\d+)$/i))) return { kind: 'pmcid', pmcid: `PMC${m[1]}` };
  if ((m = arg.match(/^openreview:([A-Za-z0-9_-]+)$/i))) return { kind: 'openreview', id: m[1] };
  if ((m = arg.match(/^10\.31234\/osf\.io\/([a-z0-9]{5}(?:_v\d+)?)$/i))) return { kind: 'osf', id: m[1].toLowerCase(), doi: arg };
  if (/^10\.\d{4,9}\//.test(arg)) return { kind: 'doi', doi: arg };
  // Scheme-less URL: a lowercase host with a TLD, then a path. Checked after the
  // id shapes above so `q-bio.NC/0601001` and DOIs never reach it.
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*$/.test(arg)) arg = 'https://' + arg;

  if ((m = arg.match(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/([^?#]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i))
    || (m = arg.match(/^https?:\/\/(?:ar5iv(?:\.labs)?\.arxiv\.org|ar5iv\.org)\/html\/([^?#]+?)\/?(?:[?#].*)?$/i))) {
    return { kind: 'arxiv', id: m[1] };
  }
  // Before the DOI-in-URL match: a PMC page URL often carries the DOI of a
  // different paper in its query string, and the PMCID is the direct route.
  if (/^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc|(?:www\.)?europepmc\.org|(?:www\.)?ebi\.ac\.uk\/europepmc)\//i.test(arg)
      && (m = arg.match(/[/=](PMC\d+)(?:[/?#.&]|$)/i))) {
    return { kind: 'pmcid', pmcid: m[1].toUpperCase() };
  }
  if ((m = arg.match(/^https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)\/?(?:[?#].*)?$/i))
    || (m = arg.match(/^https?:\/\/(?:www\.)?europepmc\.org\/(?:article|abstract)\/MED\/(\d+)\/?(?:[?#].*)?$/i))) {
    return { kind: 'pmid', pmid: m[1] };
  }
  if ((m = arg.match(/^https?:\/\/(?:www\.)?openreview\.net\/(?:forum|pdf|attachment)\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)/i))) {
    return { kind: 'openreview', id: m[1] };
  }
  if ((m = arg.match(/^https?:\/\/(?:www\.)?researchgate\.net\/(?:profile\/[^/]+\/)?publication\/\d+_([^/?#]+)/i))) {
    let t = m[1];
    try { t = decodeURIComponent(t); } catch { /* keep raw slug */ }
    return { kind: 'researchgate', title: t.replace(/_+/g, ' ').trim() };
  }
  if ((m = arg.match(/^https?:\/\/(?:www\.)?osf\.io\/(?:preprints\/[a-z0-9-]+\/)?([a-z0-9]{5}(?:_v\d+)?)\/?(?:[?#].*)?$/i))) {
    return { kind: 'osf', id: m[1].toLowerCase() };
  }
  if ((m = arg.match(/(10\.\d{4,9}\/[^\s?#]+)/))) {
    const doi = decodeURIComponent(m[1]).replace(/[.,;)]+$/, '');
    const osf = doi.match(/^10\.31234\/osf\.io\/([a-z0-9]{5}(?:_v\d+)?)$/i);
    return osf ? { kind: 'osf', id: osf[1].toLowerCase(), doi } : { kind: 'doi', doi };
  }
  if (/^https?:\/\//.test(arg)) return { kind: 'url', url: arg };
  return { kind: 'unknown', raw: arg };
}

// --- ladder rungs -----------------------------------------------------------

export function arxivCandidates(id) {
  const bare = id.replace(/v\d+$/, '');
  return [
    { label: 'arxiv-pdf', kind: 'pdf', url: `https://arxiv.org/pdf/${id}` },
    { label: 'ar5iv-html', kind: 'markup', trustedMarkup: true, url: `https://ar5iv.labs.arxiv.org/html/${bare}` },
  ];
}

/**
 * DOI -> PMCID, second opinion. Europe PMC's search index misses records the US
 * archive holds; NCBI's own converter is keyless and authoritative for PMCIDs.
 * Only called when the search above came back empty, so it costs nothing on the
 * papers Europe PMC already knows.
 */
async function pmcidFromIdConverter(doi) {
  const u = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${encodeURIComponent(doi)}&format=json&tool=getpaper${EMAIL ? `&email=${encodeURIComponent(EMAIL)}` : ''}`;
  const { data, error } = await getJson(u);
  if (error) { note('pmc-idconv', error); return null; }
  const rec = data?.records?.[0];
  if (!rec?.pmcid) { note('pmc-idconv', 'no PMC record for this DOI'); return null; }
  note('pmc-idconv', `pmcid=${rec.pmcid}`);
  return rec.pmcid;
}

/**
 * PMC rungs.
 *
 * Europe PMC's isOpenAccess is a LICENCE flag — "is this in the redistributable
 * open-access subset" — not a readability one: author-manuscript deposits read
 * perfectly and are marked N. So the flag only decides ORDER. Europe PMC's own
 * full-text route answers HTTP 500 for anything outside the OA subset, so it is
 * offered only when the flag says it will work; NCBI's efetch serves both and
 * is tried either way.
 */
async function pmcCandidates(doi) {
  const q = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&format=json&resultType=core`;
  const { data, error } = await getJson(q);
  let pmcid = null;
  let isOa = false;
  if (error) {
    note('europepmc', error);
  } else {
    const hit = data?.resultList?.result?.[0];
    if (!hit) note('europepmc', 'no record for this DOI');
    else {
      pmcid = hit.pmcid || null;
      isOa = hit.isOpenAccess === 'Y';
      note('europepmc', `record found: pmcid=${pmcid || 'none'}, isOpenAccess=${hit.isOpenAccess || 'N'}`);
    }
  }
  if (!pmcid) pmcid = await pmcidFromIdConverter(doi);
  if (!pmcid) return [];
  return pmcidCandidates(pmcid, isOa);
}

/** The PMCID-dependent half of the PMC rungs, reachable directly from a PMCID input. */
export function pmcidCandidates(pmcid, isOa) {
  const c = [];
  if (isOa) {
    c.push({
      label: 'europepmc-xml', kind: 'markup', trustedMarkup: true, requireBody: true,
      oaVersion: 'publishedVersion',
      url: `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
    });
  }
  c.push({
    label: 'ncbi-efetch-jats', kind: 'markup', trustedMarkup: true, requireBody: true, singleUa: true,
    oaVersionFrom: pmcVersionFrom,
    url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&retmode=xml`
       + `&tool=getpaper${EMAIL ? `&email=${encodeURIComponent(EMAIL)}` : ''}${NCBI_KEY ? `&api_key=${NCBI_KEY}` : ''}`,
  });
  // Last, and expected to fail: this route usually answers with a download
  // interstitial rather than the file. Kept because it costs one request.
  c.push({ label: 'pmc-pdf', kind: 'pdf', url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/` });
  return c;
}

/** PMCID -> {isOa, doi} from Europe PMC; doi feeds the DOI ladder after the PMC rungs. */
async function europePmcByPmcid(pmcid) {
  const q = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID:${pmcid}&resultType=core&format=json`;
  const { data, error } = await getJson(q);
  if (error) { note('europepmc', error); return { isOa: false, doi: null }; }
  const hit = data?.resultList?.result?.[0];
  if (!hit) { note('europepmc', `no record for ${pmcid}`); return { isOa: false, doi: null }; }
  note('europepmc', `record found: doi=${hit.doi || 'none'}, isOpenAccess=${hit.isOpenAccess || 'N'}`);
  return { isOa: hit.isOpenAccess === 'Y', doi: hit.doi || null };
}

/** PMID -> {pmcid, doi} via NCBI's converter, which accepts PMIDs as well as DOIs. */
async function idsFromPmid(pmid) {
  const u = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmid}&format=json&tool=getpaper${EMAIL ? `&email=${encodeURIComponent(EMAIL)}` : ''}`;
  const { data, error } = await getJson(u);
  if (error) { note('pmc-idconv', error); return { pmcid: null, doi: null }; }
  const rec = data?.records?.[0] || {};
  note('pmc-idconv', `pmid=${pmid}: pmcid=${rec.pmcid || 'none'}, doi=${rec.doi || 'none'}`);
  return { pmcid: rec.pmcid || null, doi: rec.doi || null };
}

/**
 * Springer Nature Open Access API -> JATS XML, version of record.
 *
 * Sits after Europe PMC and before Unpaywall because it is the same class of
 * source — publisher-served structured markup, not a mirror — but narrower:
 * Springer/Nature imprints only. A non-Springer or non-OA DOI is a clean HTTP
 * 404, so an unconditional attempt costs one request and cannot be mistaken
 * for a document. Free key from dev.springernature.com.
 */
function springerCandidates(doi) {
  if (!SPRINGER_KEY) { note('springer-oa', 'SPRINGER_OA_API_KEY not set — rung skipped'); return []; }
  return [{
    label: 'springer-oa-jats',
    kind: 'markup',
    trustedMarkup: true,
    requireBody: true,
    oaVersion: 'publishedVersion',
    singleUa: true,
    url: `https://api.springernature.com/openaccess/jats?q=doi:${doi}&api_key=${SPRINGER_KEY}`,
  }];
}

/**
 * eLife's post-2023 model publishes a Reviewed Preprint first, and those are
 * often indexed nowhere the other rungs reach (Europe PMC, Unpaywall and
 * Springer all miss them). The public API carries the whole article as HTML in
 * indexContent.
 *
 * Only Reviewed Preprints need this: a version of record is in PMC and the
 * europepmc rung already serves it, which is the copy we would rather quote.
 */
export function elifeCandidates(doi) {
  const m = doi.match(/^10\.7554\/elife\.(\d+)/i);
  if (!m) return [];
  return [{
    label: 'elife-reviewed-preprint', kind: 'markup', trustedMarkup: true, singleUa: true,
    oaVersion: 'reviewedPreprint',
    unwrap: (raw) => { try { return JSON.parse(raw).indexContent || null; } catch { return null; } },
    url: `https://api.elifesciences.org/reviewed-preprints/${m[1]}`,
  }];
}

/**
 * bioRxiv/medRxiv: doi.org and the Unpaywall URLs for 10.1101 land on
 * www.biorxiv.org, which answers this host HTTP 429 (Cloudflare 1015). The
 * details API is a different host, knows the latest version, and hands out the
 * JATS source URL. 10.64898 is bioRxiv's newer prefix; the API resolves it.
 */
export function biorxivCandidatesFrom(server, doi, data) {
  const coll = data?.collection || [];
  if (!coll.length) return [];
  const latest = coll.reduce((a, b) => (Number(b.version) > Number(a.version) ? b : a));
  const c = [];
  if (latest.jatsxml) {
    c.push({ label: `${server}-jats`, kind: 'markup', trustedMarkup: true, requireBody: true,
             oaVersion: 'preprint', url: latest.jatsxml });
  }
  c.push({ label: `${server}-pdf`, kind: 'pdf', oaVersion: 'preprint',
           url: `https://www.${server}.org/content/${doi}v${latest.version}.full.pdf` });
  return c;
}

async function biorxivCandidates(doi) {
  if (!/^10\.(1101|64898)\//.test(doi)) return [];
  for (const server of ['biorxiv', 'medrxiv']) {
    const { data, error } = await getJson(`https://api.biorxiv.org/details/${server}/${doi}`);
    if (error) { note(`${server}-api`, error); continue; }
    const c = biorxivCandidatesFrom(server, doi, data);
    if (c.length) { note(`${server}-api`, `record found, ${c.length} candidate(s)`); return c; }
    note(`${server}-api`, 'no record');
  }
  return [];
}

async function unpaywallCandidates(doi) {
  if (!EMAIL) { note('unpaywall', 'LIT_SEARCH_EMAIL not set (Unpaywall requires an email) — rung skipped'); return { cands: [], meta: null }; }
  const { data, error } = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(EMAIL)}`);
  if (error) { note('unpaywall', error); return { cands: [], meta: null }; }
  const meta = { title: data.title || null, year: data.year || null, journal: data.journal_name || null, is_oa: !!data.is_oa };
  if (!data.is_oa) { note('unpaywall', 'is_oa=false — no open copy known'); return { cands: [], meta }; }
  const locs = (data.oa_locations || []).filter((l) => l && (l.url_for_pdf || l.url));
  // Repository copies first: an OA paper's publisher page is frequently behind
  // the same bot challenge as a paywalled one, the mirror rarely is.
  const rank = (l) => (l.host_type === 'repository' ? 0 : 1);
  locs.sort((a, b) => rank(a) - rank(b) || (b.url_for_pdf ? 1 : 0) - (a.url_for_pdf ? 1 : 0));
  note('unpaywall', `is_oa=true, ${locs.length} location(s)`);
  const cands = [];
  for (const l of locs.slice(0, 6)) {
    const host = (() => { try { return new URL(l.url_for_pdf || l.url).host; } catch { return '?'; } })();
    // Derived direct-file URLs go BEFORE the URL as listed: the listed one is
    // often a landing page or a path that 405s, and trying the file first saves
    // a round trip as well as a chance to mistake chrome for an article.
    const oaVersion = l.version || null;
    if (l.url_for_pdf) {
      const alt = dspaceRestUrl(l.url_for_pdf);
      if (alt) cands.push({ label: `oa-${l.host_type}-dspace-rest(${host})`, kind: 'pdf', url: alt, oaVersion });
      cands.push({ label: `oa-${l.host_type}-pdf(${host})`, kind: 'pdf', url: l.url_for_pdf, oaVersion });
    } else {
      // HAL lists repository records with url_for_pdf=null; the file is always
      // at <record>/document.
      if (/(^|\.)hal\.science$/i.test(host) || /(^|\.)archives-ouvertes\.fr$/i.test(host)) {
        cands.push({ label: `oa-${l.host_type}-hal-doc(${host})`, kind: 'pdf', url: l.url.replace(/\/+$/, '') + '/document', oaVersion });
      }
      cands.push({ label: `oa-${l.host_type}(${host})`, kind: 'markup', url: l.url, oaVersion });
    }
  }
  return { cands, meta };
}

/**
 * OpenAlex content, LAST for a DOI: parsed full text OpenAlex holds for works
 * no open location serves, paid per download out of the $1/day key budget. The
 * singleton lookup that says whether content exists is free. A reserve is kept
 * so a fetch spree cannot starve search (openalex.mjs, litfind.mjs) for the day.
 */
async function openalexContentCandidates(doi) {
  if (!OPENALEX_KEY) { note('openalex-content', 'OPENALEX_API_KEY not set — rung skipped'); return []; }
  const auth = { Authorization: `Bearer ${OPENALEX_KEY}` };
  const { data, error, res } = await getJson(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,has_content`, { headers: auth });
  if (error) { note('openalex-content', `lookup ${error}`); return []; }
  const wid = String(data.id || '').split('/').pop();
  if (!/^W\d+$/.test(wid)) { note('openalex-content', 'lookup returned no work id'); return []; }
  const remaining = Number(res.remainingUsd);
  if (Number.isFinite(remaining) && remaining < OPENALEX_RESERVE_USD) {
    note('openalex-content', `skipped: $${remaining} left today, below the $${OPENALEX_RESERVE_USD} search reserve`);
    return [];
  }
  const hc = data.has_content;
  note('openalex-content', `${wid} has_content=${hc ? JSON.stringify(hc) : 'absent'}`);
  const base = { trustedMarkup: true, singleUa: true, metered: true, headers: auth };
  const c = [];
  if (!hc || hc.grobid_xml) {
    c.push({ ...base, label: 'openalex-grobid-xml', kind: 'markup', requireBody: true,
             url: `https://content.openalex.org/works/${wid}.grobid-xml` });
  }
  if (!hc || hc.pdf) {
    c.push({ ...base, label: 'openalex-pdf', kind: 'pdf', checkTrailer: true,
             url: `https://content.openalex.org/works/${wid}.pdf` });
  }
  if (!c.length) note('openalex-content', 'no stored content for this work');
  return c;
}

/** OpenAlex titles scraped from reference lists can carry the citation's URL tail,
 *  e.g. "... deep neural networks Preprint at http://arxiv.org/abs". */
export function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*(?:\b(?:preprint|available|published|retrieved)\s+(?:at|from|online)\b[:\s]*)?https?:\/\/\S*\s*$/i, '')
    .trim();
}

const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?\/?(?:[?#].*)?$/i;

/** OpenAlex work -> the identifiers and locations the rescue stage tries. */
export function fromOpenalexWork(work) {
  const locs = (work?.locations || []).filter(Boolean);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const doiRaw = work?.doi || work?.ids?.doi || null;
  const doi = doiRaw ? String(doiRaw).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : null;
  let arxiv = null;
  const axId = work?.ids?.arxiv;
  if (axId) arxiv = (String(axId).match(ARXIV_URL_RE) || [])[1] || String(axId).replace(/^arxiv:/i, '');
  if (!arxiv && doi) arxiv = (doi.match(/^10\.48550\/arxiv\.(.+)$/i) || [])[1] || null;
  if (!arxiv) {
    for (const u of locs.flatMap((l) => [l.landing_page_url, l.pdf_url])) {
      const m = u && String(u).match(ARXIV_URL_RE);
      if (m) { arxiv = m[1]; break; }
    }
  }
  return {
    id: String(work?.id || '').split('/').pop() || null,
    doi,
    arxiv: arxiv || null,
    title: cleanTitle(work?.title || work?.display_name) || null,
    pdfUrls: uniq(locs.map((l) => l.pdf_url)),
    landingUrls: uniq(locs.map((l) => l.landing_page_url)),
  };
}

const workMemo = new Map();
async function openalexWork(idOrDoi) {
  if (!OPENALEX_KEY) { note('openalex-work', 'OPENALEX_API_KEY not set — rung skipped'); return null; }
  const isW = /^W\d+$/i.test(idOrDoi);
  const memoKey = (isW ? idOrDoi : `doi:${idOrDoi}`).toLowerCase();
  if (workMemo.has(memoKey)) return workMemo.get(memoKey);
  const path = isW ? idOrDoi.toUpperCase() : `doi:${encodeURIComponent(idOrDoi)}`;
  const { data, error } = await getJson(
    `https://api.openalex.org/works/${path}?select=id,doi,ids,title,display_name,locations`,
    { headers: { Authorization: `Bearer ${OPENALEX_KEY}` } });
  let w = null;
  if (error) note('openalex-work', `${idOrDoi} ${error}`);
  else {
    w = fromOpenalexWork(data);
    note('openalex-work', `${w.id} doi=${w.doi || 'none'} arxiv=${w.arxiv || 'none'} `
      + `${w.pdfUrls.length} pdf / ${w.landingUrls.length} landing url(s)`);
    if (w.id) workMemo.set(w.id.toLowerCase(), w);
    if (w.doi) workMemo.set(`doi:${w.doi}`.toLowerCase(), w);
  }
  workMemo.set(memoKey, w);
  return w;
}

/** Zenodo record -> file download URLs, PDFs first. */
export function zenodoFileUrls(record) {
  const files = (record?.files || []).filter((f) => f?.links?.self);
  const isPdf = (f) => /\.pdf$/i.test(f.key || f.filename || '') || /pdf/i.test(f.mimetype || '');
  return [...files.filter(isPdf), ...files.filter((f) => !isPdf(f))].map((f) => f.links.self);
}

async function zenodoCandidates(doi) {
  const m = doi.match(/^10\.5281\/zenodo\.(\d+)$/i);
  if (!m) return [];
  const { data, error } = await getJson(`https://zenodo.org/api/records/${m[1]}`);
  if (error) { note('zenodo-api', error); return []; }
  const urls = zenodoFileUrls(data);
  note('zenodo-api', `${urls.length} file(s)`);
  return urls.slice(0, 5).map((u) => ({ label: 'zenodo-file', kind: 'pdf', url: u }));
}

/**
 * OSF preprints (PsyArXiv, SocArXiv, …): the landing page is a JS app with no
 * file link, so the API is the only route to the PDF. Two free calls.
 */
async function osfCandidates(id) {
  const { data, error } = await getJson(`https://api.osf.io/v2/preprints/${id}/`);
  if (error) { note('osf-api', error); return []; }
  const fileHref = data?.data?.relationships?.primary_file?.links?.related?.href;
  if (!fileHref) { note('osf-api', 'preprint has no primary file'); return []; }
  const f = await getJson(fileHref);
  if (f.error) { note('osf-api', `file ${f.error}`); return []; }
  const dl = f.data?.data?.links?.download;
  if (!dl) { note('osf-api', 'file record has no download link'); return []; }
  note('osf-api', `primary file ${f.data.data.attributes?.name || '?'}`);
  return [{ label: 'osf-pdf', kind: 'pdf', oaVersion: 'preprint', url: dl }];
}

/** api2 wraps every content field as {value}; api v1 (pre-2023 venues) does not. */
export function openreviewTitleFrom(data) {
  const t = data?.notes?.[0]?.content?.title;
  const v = t && typeof t === 'object' ? t.value : t;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function openreviewTitle(id) {
  for (const host of ['api2.openreview.net', 'api.openreview.net']) {
    const { data, error } = await getJson(`https://${host}/notes?id=${encodeURIComponent(id)}`);
    if (error) { note('openreview-api', `${host} ${error}`); continue; }
    const t = openreviewTitleFrom(data);
    if (t) { note('openreview-api', `title: ${t}`); return t; }
    note('openreview-api', `${host} no note/title for ${id}`);
  }
  return null;
}

// --- title -> identifier ------------------------------------------------------

export function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Strict: an unverified title hit would hand over the text of a different
 * paper under this one's name. `prefix` is for ResearchGate slugs, which are
 * cut off mid-title; a short prefix matches too many papers, hence the floor.
 */
export function titleMatches(candidate, want, { prefix = false } = {}) {
  const c = normTitle(candidate);
  const w = normTitle(want);
  if (!c || !w) return false;
  if (c === w) return true;
  return prefix && w.length >= 25 && c.startsWith(w);
}

export function parseArxivFeed(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)(?:v\d+)?\s*<\/id>/) || [])[1] || null,
    title: markupToText((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' '),
  })).filter((x) => x.id);
}

// arXiv asks for at most 1 API request per 3 s; the stamp file holds that
// across concurrent processes sharing the cache directory.
async function arxivApiThrottle() {
  const f = join(CACHE, '.arxiv-api-last');
  try {
    const wait = statSync(f).mtimeMs + 3000 - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 3000));
  } catch { /* first call */ }
  writeFileSync(f, String(Date.now()));
}

async function resolveTitle(title, { prefix = false } = {}) {
  const words = title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let arxivId = null;
  let doi = null;
  await arxivApiThrottle();
  const axUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${words}"`)}&max_results=10`;
  let ax = await get(axUrl);
  if (ax.status === 429) {
    note('title-arxiv', 'HTTP 429, one more try in 5 s');
    await sleep(5000);
    await arxivApiThrottle();
    ax = await get(axUrl);
  }
  if (!ax.ok) note('title-arxiv', `HTTP ${ax.status}`);
  else {
    const hit = parseArxivFeed(ax.buf.toString('utf8')).find((e) => titleMatches(e.title, title, { prefix }));
    if (hit) { arxivId = hit.id; note('title-arxiv', `match arXiv:${hit.id} "${hit.title}"`); }
    else note('title-arxiv', 'no strict title match');
  }
  const cr = await getJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(words)}`
    + `&rows=5&select=DOI,title${EMAIL ? `&mailto=${encodeURIComponent(EMAIL)}` : ''}`);
  if (cr.error) note('title-crossref', cr.error);
  else {
    const hit = (cr.data?.message?.items || []).find((it) => titleMatches((it.title || [])[0], title, { prefix }));
    if (hit) { doi = hit.DOI; note('title-crossref', `match doi=${hit.DOI} "${hit.title[0]}"`); }
    else note('title-crossref', 'no strict title match');
  }
  return { arxivId, doi };
}

async function doiLadder(doi, { skipPmc = false } = {}) {
  let c = skipPmc ? [] : await pmcCandidates(doi);
  c = c.concat(springerCandidates(doi), elifeCandidates(doi), await biorxivCandidates(doi));
  const u = await unpaywallCandidates(doi);
  return { cands: c.concat(u.cands), meta: u.meta };
}

// --- main -------------------------------------------------------------------

/** argv after the script name -> ordered inputs: the positional id, then each --also. */
export function parseArgs(argv) {
  let primary = null;
  const also = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true, inputs: [] };
    if (a === '--also') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { error: '--also needs an id', inputs: [] };
      also.push(v);
    } else if (a.startsWith('--also=')) {
      if (!a.slice(7)) return { error: '--also needs an id', inputs: [] };
      also.push(a.slice(7));
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}`, inputs: [] };
    } else if (primary === null) {
      primary = a;
    } else {
      return { error: `unexpected extra argument ${a} (use --also)`, inputs: [] };
    }
  }
  if (primary === null) return { error: 'no id given', inputs: [] };
  return { inputs: [primary, ...also] };
}

// Shared across every input of one invocation: an --also id for the same paper
// resolves to the same locations, and none of them is worth fetching twice.
// Unpaywall routinely lists the same landing page under several locations, too.
const seen = new Set();
const dedupe = (list) => list.filter((c) => !seen.has(c.url) && seen.add(c.url));
const doneDois = new Set();
const titleMemo = new Map();

async function resolveTitleOnce(title) {
  const k = normTitle(title);
  if (!titleMemo.has(k)) titleMemo.set(k, await resolveTitle(title));
  else note('title', 'already searched for an earlier input');
  return titleMemo.get(k);
}

/**
 * Last-chance routes for a DOI or OpenAlex work, reached only when the ladder
 * and the paid OpenAlex content rung have failed: the work's own locations, the
 * DOI landing page, Zenodo files, and finally an arXiv copy found by title.
 */
async function rescue(parsed, meta, work, run) {
  const doi = parsed.doi || null;
  if (!work) work = await openalexWork(parsed.kind === 'openalex' ? parsed.id : doi);
  let hit = null;
  if (work) {
    if (work.arxiv) {
      parsed.arxiv = work.arxiv;
      hit = await run(arxivCandidates(work.arxiv), { arxiv: work.arxiv });
    }
    hit = hit || await run(work.pdfUrls.map((u) => ({ label: `openalex-loc-pdf(${hostOf(u)})`, kind: 'pdf', url: u })));
    hit = hit || await run(work.landingUrls.map((u) => ({ label: `openalex-loc(${hostOf(u)})`, kind: 'markup', url: u })));
  }
  if (!hit && doi) hit = await run([{ label: 'doi-landing', kind: 'markup', url: `https://doi.org/${doi}` }]);
  if (!hit && doi) hit = await run(await zenodoCandidates(doi));
  if (!hit) {
    const title = work?.title || cleanTitle(meta?.title);
    if (!title) note('title', 'no title known — title search skipped');
    else {
      const r = await resolveTitleOnce(title);
      if (r.arxivId) {
        parsed.arxiv = r.arxivId;
        hit = await run(arxivCandidates(r.arxivId), { matched_by: 'title', arxiv: r.arxivId });
      }
    }
  }
  return hit;
}

/** One id through cache and ladder. Returns a result object; never prints or exits. */
async function ladder(raw) {
  note('input', raw);
  const parsed = parseInput(raw);
  const key = cacheKey(raw);

  // Cache hit: same identifier already converted. Cheap and makes repeated
  // quoting of the same paper free.
  const cached = join(CACHE, key + '.txt');
  const cachedLayout = join(CACHE, key + '.layout.txt');
  // A cached .txt next to a .pdf with no .layout.txt beside it is an incomplete
  // entry; refetch rather than serve it.
  const stalePdfCache = existsSync(join(CACHE, key + '.pdf')) && !existsSync(cachedLayout);
  if (existsSync(cached) && statSync(cached).size >= MIN_CHARS && !stalePdfCache) {
    const chars = readFileSync(cached, 'utf8').length;
    note('cache', `hit ${cached}`);
    // where the text came from (an arXiv copy found by title, a fallback location) outlives the first fetch
    let via = {};
    try { via = JSON.parse(readFileSync(join(CACHE, key + '.via.json'), 'utf8')); } catch { /* older entry */ }
    return {
      status: 'ok', resolved: parsed, text_path: cached, chars, ...via, source: 'cache', cached: true,
      ...(existsSync(cachedLayout) ? { layout_text_path: cachedLayout } : {}),
    };
  }
  if (stalePdfCache) note('cache', 'ignoring incomplete cache entry');

  let candidates = [];
  let meta = null;
  let ladderDoi = null;
  let work = null;
  const addDoi = async (doi, opts) => {
    if (doneDois.has(doi.toLowerCase())) { note('doi-ladder', `${doi} already tried for an earlier input`); return; }
    doneDois.add(doi.toLowerCase());
    const l = await doiLadder(doi, opts);
    meta = meta || l.meta;
    ladderDoi = ladderDoi || doi;
    candidates = candidates.concat(l.cands);
  };

  if (parsed.kind === 'arxiv') {
    candidates = arxivCandidates(parsed.id);
  } else if (parsed.kind === 'doi') {
    await addDoi(parsed.doi);
  } else if (parsed.kind === 'openalex') {
    work = await openalexWork(parsed.id);
    if (work?.doi) { parsed.doi = work.doi; await addDoi(work.doi); }
  } else if (parsed.kind === 'pmcid' || parsed.kind === 'pmid') {
    let pmcid = parsed.pmcid || null;
    let doi = null;
    if (parsed.kind === 'pmid') ({ pmcid, doi } = await idsFromPmid(parsed.pmid));
    if (pmcid) {
      const e = await europePmcByPmcid(pmcid);
      doi = doi || e.doi;
      candidates = pmcidCandidates(pmcid, e.isOa);
    }
    if (doi) { parsed.doi = doi; await addDoi(doi, { skipPmc: !!pmcid }); }
  } else if (parsed.kind === 'osf') {
    candidates = await osfCandidates(parsed.id);
  } else if (parsed.kind === 'openreview') {
    const t = await openreviewTitle(parsed.id);
    if (t) {
      parsed.title = t;
      const r = await resolveTitleOnce(t);
      if (r.arxivId) { parsed.arxiv = r.arxivId; candidates = arxivCandidates(r.arxivId); }
      if (r.doi) { parsed.doi = r.doi; await addDoi(r.doi); }
    }
    candidates.push({ label: 'openreview-pdf', kind: 'pdf', url: `https://openreview.net/pdf?id=${parsed.id}` });
  } else if (parsed.kind === 'researchgate') {
    const r = await resolveTitle(parsed.title, { prefix: true });
    if (r.doi) { parsed.doi = r.doi; await addDoi(r.doi); }
    if (r.arxivId) { parsed.arxiv = r.arxivId; candidates = candidates.concat(arxivCandidates(r.arxivId)); }
  } else if (parsed.kind === 'url') {
    const isPdf = /\.pdf(\?|$)/i.test(parsed.url);
    candidates = [{ label: 'as-given', kind: isPdf ? 'pdf' : 'markup', url: parsed.url }];
  } else {
    return { status: 'error', resolved: parsed, reason: 'could not parse as DOI, arXiv id, OpenAlex id, or URL' };
  }

  let tried = 0;
  const run = async (list, extra = {}) => {
    for (const cand of dedupe(list)) {
      tried++;
      const hit = await tryCandidate(cand, key);
      if (hit) return { ...hit, ...extra };
    }
    return null;
  };
  let hit = await run(candidates);
  // Paid, so only reached once every free location has failed.
  if (!hit && ladderDoi) hit = await run(await openalexContentCandidates(ladderDoi));
  if (!hit && (parsed.kind === 'doi' || parsed.kind === 'openalex')) hit = await rescue(parsed, meta, work, run);
  if (hit) {
    const via = Object.fromEntries(['source', 'url', 'version', 'matched_by', 'arxiv'].filter((k) => hit[k] != null).map((k) => [k === 'source' ? 'fetched_from' : k, hit[k]]));
    try { writeFileSync(join(CACHE, key + '.via.json'), JSON.stringify(via)); } catch { /* cache is best-effort */ }
    return { status: 'ok', resolved: parsed, meta, ...hit, cached: false };
  }

  if (!tried) {
    return { status: 'no-fulltext', resolved: parsed, meta,
             reason: 'no open-access location found; cite the abstract and set quote=null' };
  }
  return { status: 'no-fulltext', resolved: parsed, meta,
           reason: `all ${tried} candidate location(s) failed — see trace; cite the abstract and set quote=null` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.error) {
    if (args.error) process.stderr.write(`getpaper: ${args.error}\n`);
    process.stderr.write('usage: node getpaper.mjs <doi | arxiv-id | openalex-id | url> [--also <id>]...\n');
    process.exit(2);
  }
  const { inputs } = args;
  try { execFileSync(PDFTOTEXT, ['-v'], { stdio: 'ignore' }); } catch (e) {
    if (e.code === 'ENOENT') out({ status: 'error', input: inputs[0], reason: `${PDFTOTEXT} not found: install poppler-utils (pdftotext) or set GETPAPER_PDFTOTEXT` });
  }
  mkdirSync(CACHE, { recursive: true });

  const results = [];
  for (const raw of inputs) {
    const r = await ladder(raw);
    if (r.status === 'ok') {
      const { status, ...rest } = r;
      out({ status, input: inputs[0], matched_input: raw, ...rest, ...(isShortText(r.chars) ? { short: true } : {}) });
    }
    results.push({ input: raw, ...r });
  }
  const first = results[0];
  out({
    status: results.some((r) => r.status === 'no-fulltext') ? 'no-fulltext' : 'error',
    input: inputs[0], resolved: first.resolved, meta: first.meta, reason: first.reason,
    ...(inputs.length > 1 ? { attempts: results.map((r) => ({ input: r.input, status: r.status, reason: r.reason })) } : {}),
  });
}

// Guarded so the predicates above can be imported by a test without the driver
// firing (and calling process.exit) at module load.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
