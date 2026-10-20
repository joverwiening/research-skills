#!/usr/bin/env node
// Hooks for the checker and reviewer agents. The same file ships in both plugins so each works alone.
// usage: node review-hooks.mjs <checker|reviewer> <pre|stop|post>   (hook input JSON on stdin)
//   pre  (PreToolUse Agent|Task):  refuse a dispatch whose brief names no existing `artifact: <path>` file, at most 2x per session
//   stop (SubagentStop):           block once on a return that is not the role's JSON, then once on quotes not found in the cited file
//   post (PostToolUse Agent|Task): give the main agent the per-item summary with each quote checked against the file
// Any error: exit 0 with no output, so the session is never broken by this hook.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUS_VALUES = ['ok', 'partial', 'failed'];
const CHECKER_CALLS = ['ok', 'wrong', 'stale', 'unsupported', 'overclaim', 'missed_prior'];
const REVIEWER_VERDICTS = ['main', 'fix', 'develop', 'supporting', 'dead_end', 'cut', 'stop'];
const ROLE_RE = { checker: /(^|:)checker$/, reviewer: /(^|:)reviewer$/ };
const MIN_MOVED_QUOTE = 20;
const MAX_ARTIFACT_REFUSALS = 2;

const isString = (v) => typeof v === 'string';
const isArray = (v) => Array.isArray(v);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- JSON validation

function scanBalancedObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function extractJsonCandidates(raw) {
  const text = raw.trim();
  const candidates = [];
  if (text.startsWith('{')) candidates.push(text);
  const fenceRe = /```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) candidates.push(body);
  }
  for (const region of scanBalancedObjects(text)) candidates.push(region);
  return candidates;
}

function checkEvidence(evs, i, errors) {
  evs.forEach((ev, j) => {
    if (!isObject(ev)) {
      errors.push(`items[${i}].evidence[${j}] must be object`);
      return;
    }
    if (!isString(ev.path)) errors.push(`items[${i}].evidence[${j}].path must be string`);
    if (!Number.isInteger(ev.line) || ev.line < 1) errors.push(`items[${i}].evidence[${j}].line must be integer >= 1`);
    if (!isString(ev.quote) || !ev.quote.trim()) errors.push(`items[${i}].evidence[${j}].quote must be non-empty string`);
  });
}

function validateChecker(obj, errors) {
  if (obj.delete === undefined) obj.delete = [];
  if (isArray(obj.items)) {
    for (const it of obj.items) {
      if (!isObject(it)) continue;
      if (it.evidence === undefined) it.evidence = [];
      if (it.kill === undefined && it.call === 'ok') it.kill = '';
    }
  }
  let nonOk = 0;
  if (!isArray(obj.items)) {
    errors.push('items must be array');
  } else {
    obj.items.forEach((it, i) => {
      if (!isObject(it)) {
        errors.push(`items[${i}] must be object`);
        return;
      }
      for (const k of ['item', 'why', 'kill']) {
        if (!isString(it[k])) errors.push(`items[${i}].${k} must be string`);
      }
      if (!isString(it.call) || !CHECKER_CALLS.includes(it.call)) {
        errors.push(`items[${i}].call must be one of ${CHECKER_CALLS.join('|')}`);
      } else if (it.call !== 'ok') {
        nonOk++;
      }
      if (!isArray(it.evidence)) errors.push(`items[${i}].evidence must be array ([] if none)`);
      else checkEvidence(it.evidence, i, errors);
      if (it.fix !== undefined && !isString(it.fix)) errors.push(`items[${i}].fix must be string`);
    });
    if (nonOk > 3) errors.push(`at most 3 non-ok items, got ${nonOk}`);
    if (nonOk === 0 && !(isString(obj.no_objection_reason) && obj.no_objection_reason.trim())) {
      errors.push('no_objection_reason must be a non-empty string when no item is non-ok');
    }
  }
  if (!isArray(obj.delete) || !obj.delete.every(isString)) errors.push('delete must be string[] ([] if none)');
}

function validateReviewer(obj, errors) {
  for (const k of ['angle', 'goal', 'overall', 'top_cut']) {
    if (!isString(obj[k])) errors.push(`${k} must be string`);
  }
  const stage = obj.stage;
  if (stage !== 'direction' && stage !== 'final') errors.push('stage must be "direction" or "final"');
  if (!isObject(obj.story)) {
    errors.push('story must be an object {now, best, gap, lead}');
  } else {
    for (const k of ['now', 'best', 'gap', 'lead']) {
      const v = obj.story[k];
      if (!isString(v) || !v.trim()) errors.push(`story.${k} must be a non-empty string`);
    }
  }
  const isSlot = (v) => Number.isInteger(v) && v >= 1;
  const slots = obj.slots;
  if (stage === 'final' && !isSlot(slots)) errors.push('slots must be integer >= 1 in the final stage');
  if (slots !== undefined && !isSlot(slots)) errors.push('slots must be integer >= 1 when given');
  const planSlots = obj.plan_slots;
  if (planSlots !== undefined && !isSlot(planSlots)) errors.push('plan_slots must be integer >= 1 when given');
  if (!isArray(obj.items) || obj.items.length === 0) {
    errors.push('items must be a non-empty array');
  } else {
    let mainResults = 0;
    let mainPlans = 0;
    obj.items.forEach((it, i) => {
      if (!isObject(it)) {
        errors.push(`items[${i}] must be object`);
        return;
      }
      for (const k of ['item', 'why', 'kill']) {
        if (!isString(it[k])) errors.push(`items[${i}].${k} must be string`);
      }
      if (it.kind !== 'result' && it.kind !== 'plan') errors.push(`items[${i}].kind must be "result" or "plan"`);
      const verdict = it.verdict;
      if (!isString(verdict) || !REVIEWER_VERDICTS.includes(verdict)) {
        errors.push(`items[${i}].verdict must be one of ${REVIEWER_VERDICTS.join('|')}`);
      } else {
        if (verdict === 'main' && it.kind === 'plan') mainPlans++;
        else if ((verdict === 'main' || verdict === 'fix') && it.kind === 'result') mainResults++;
        if (verdict === 'cut' && stage === 'direction') {
          errors.push(`items[${i}]: no cut in the direction stage; dead_end if a result killed it, else develop or supporting`);
        }
        if (verdict === 'stop' && it.kind !== 'plan') errors.push(`items[${i}]: stop is for plan items only`);
        if (verdict === 'fix' && (!isString(it.fix) || !it.fix.trim())) {
          errors.push(`items[${i}].fix must say what to change when verdict is fix`);
        }
        if (verdict === 'develop' && (!isString(it.develop) || !it.develop.trim())) {
          errors.push(`items[${i}].develop must say what it needs (data, proof, control, design) when verdict is develop`);
        }
        if (verdict === 'dead_end' && (!isArray(it.evidence) || it.evidence.length === 0)) {
          errors.push(`items[${i}]: dead_end must cite the result that killed it in evidence`);
        }
      }
      if (it.evidence !== undefined && !isArray(it.evidence)) errors.push(`items[${i}].evidence must be array when given`);
      else if (isArray(it.evidence)) checkEvidence(it.evidence, i, errors);
    });
    if (stage === 'final' && isSlot(slots) && mainResults > slots) {
      errors.push(`${mainResults} results are main or fix but slots is ${slots}`);
    }
    if (isSlot(planSlots) && mainPlans > planSlots) {
      errors.push(`${mainPlans} plan items are main but plan_slots is ${planSlots}`);
    }
  }
  if (obj.missing === undefined) obj.missing = [];
  if (!isArray(obj.missing) || !obj.missing.every(isString)) {
    errors.push('missing must be string[] ([] if none)');
  } else if (obj.missing.length > 3) {
    errors.push(`at most 3 missing entries, got ${obj.missing.length}`);
  }
}

function validateOutput(role, raw) {
  const errors = [];
  let obj;
  let fallback;
  let lastParseError = 'no JSON object found in output';
  for (const candidate of extractJsonCandidates(String(raw ?? ''))) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (e) {
      lastParseError = e.message;
      continue;
    }
    if (!isObject(parsed)) {
      if (fallback === undefined) fallback = parsed;
      continue;
    }
    if (isString(parsed.status)) { obj = parsed; break; }
    if (obj === undefined) obj = parsed;
  }
  if (obj === undefined) {
    if (fallback !== undefined) return { valid: false, errors: ['Output is not a JSON object'], parsed: fallback };
    return { valid: false, errors: [`Invalid JSON: ${lastParseError}`] };
  }
  if (!isString(obj.status) || !STATUS_VALUES.includes(obj.status)) {
    errors.push(`root: status must be one of ${STATUS_VALUES.join('|')}, got ${JSON.stringify(obj.status)}`);
  }
  if (role === 'checker') validateChecker(obj, errors);
  else validateReviewer(obj, errors);
  return { valid: errors.length === 0, errors, parsed: obj };
}

// ---------------------------------------------------------------- quote checks

function resolveEvidencePath(p, bases) {
  if (!p) return null;
  if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
  for (const b of bases) {
    const r = path.resolve(b, p);
    if (fs.existsSync(r)) return r;
  }
  return null;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function span(lines, start, len) {
  if (start < 1 || start + len - 1 > lines.length) return null;
  return norm(lines.slice(start - 1, start - 1 + len).join(' '));
}

function spanHas(lines, start, q) {
  for (let len = 1; len <= 3; len++) {
    const s = span(lines, start, len);
    if (s !== null && s.includes(q)) return true;
  }
  return false;
}

function contextAround(lines, center) {
  const out = [];
  for (let n = center - 1; n <= center + 1; n++) {
    if (n < 1 || n > lines.length) continue;
    out.push(`${n}│ ${clip(lines[n - 1], 200)}`);
  }
  return out;
}

function checkQuote(ev, bases) {
  const file = resolveEvidencePath(ev.path, bases);
  if (!file) return { status: 'nofile', context: [] };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'nofile', context: [] };
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const q = norm(ev.quote ?? '');
  const line = Number.isInteger(ev.line) ? ev.line : 1;
  if (!q) return { status: 'missing', context: contextAround(lines, line) };
  for (let start = line - 3; start <= line + 3; start++) {
    if (spanHas(lines, start, q)) return { status: 'ok', context: contextAround(lines, line) };
  }
  // Anywhere else in the file only counts for a quote long enough to be specific.
  if (q.length < MIN_MOVED_QUOTE) return { status: 'missing', context: contextAround(lines, line) };
  for (let start = 1; start <= lines.length; start++) {
    for (let len = 1; len <= 3; len++) {
      const s = span(lines, start, len);
      if (s === null || !s.includes(q)) continue;
      const rest = len > 1 ? span(lines, start + 1, len - 1) : null;
      if (rest !== null && rest.includes(q)) continue;
      return { status: 'moved', foundLine: start, context: contextAround(lines, start) };
    }
  }
  return { status: 'missing', context: contextAround(lines, line) };
}

function marker(c) {
  switch (c.status) {
    case 'ok': return '✓ quote in file';
    case 'moved': return `~ quote found at line ${c.foundLine}`;
    case 'missing': return '✗ quote NOT in file — UNVERIFIED';
    case 'nofile': return '✗ file not found — UNVERIFIED';
  }
  return '';
}

function summarizeChecker(out, bases) {
  const items = isArray(out.items) ? out.items : [];
  let nonOk = 0;
  let verified = 0;
  const body = [];
  for (const it of items) {
    if (it.call === 'ok') continue;
    const evs = isArray(it.evidence) ? it.evidence : [];
    const checks = evs.map((ev) => ({ ev, c: checkQuote(ev, bases) }));
    nonOk++;
    if (checks.some(({ c }) => c.status === 'ok' || c.status === 'moved')) verified++;
    body.push(`${nonOk}. [${it.call}] ${clip(String(it.item ?? ''), 160)} — ${clip(String(it.why ?? ''), 200)}`);
    if (checks.length === 0) body.push('   (no evidence given — unbacked)');
    for (const { ev, c } of checks) {
      body.push(`   ${ev.path}:${ev.line} ${marker(c)}`);
      for (const l of c.context) body.push(`     ${l}`);
    }
  }
  const head = `checker: ${nonOk} objections, ${verified} backed by a quote found in the file, ${nonOk - verified} unverified`;
  return [head, ...body].join('\n');
}

function summarizeReviewer(out, bases) {
  const items = isArray(out.items) ? out.items : [];
  const counts = { main: 0, fix: 0, develop: 0, supporting: 0, dead_end: 0, cut: 0, stop: 0 };
  let found = 0;
  let notFound = 0;
  const body = [];
  for (const it of items) {
    if (it.verdict in counts) counts[it.verdict]++;
    const evs = isArray(it.evidence) ? it.evidence : [];
    const checks = evs.map((ev) => ({ ev, c: checkQuote(ev, bases) }));
    body.push(`[${it.verdict}${it.kind === 'plan' ? ', plan' : ''}] ${clip(String(it.item ?? ''), 160)} — ${clip(String(it.why ?? ''), 200)}`);
    if (it.verdict === 'fix' && it.fix) body.push(`   fix: ${clip(String(it.fix), 200)}`);
    if (it.verdict === 'develop' && it.develop) body.push(`   needs: ${clip(String(it.develop), 200)}`);
    for (const { ev, c } of checks) {
      if (c.status === 'ok' || c.status === 'moved') found++;
      else notFound++;
      body.push(`   ${ev.path}:${ev.line} ${marker(c)}`);
      for (const l of c.context) body.push(`     ${l}`);
    }
  }
  const st = out.story;
  if (st && typeof st === 'object') {
    body.unshift(
      `story now: ${clip(String(st.now ?? ''), 240)}`,
      `story best: ${clip(String(st.best ?? ''), 240)}`,
      `story gap: ${clip(String(st.gap ?? ''), 240)}`,
      `lead: ${clip(String(st.lead ?? ''), 240)}`,
    );
  }
  const missing = isArray(out.missing) ? out.missing : [];
  for (const m of missing) body.push(`missing: ${clip(String(m), 200)}`);
  if (out.overall) body.push(`overall: ${clip(String(out.overall), 240)}`);
  if (out.top_cut) body.push(`top cut: ${clip(String(out.top_cut), 200)}`);
  const slotText =
    (out.slots !== undefined ? `slots ${out.slots}` : 'no slot cap') + (out.plan_slots !== undefined ? `, plan slots ${out.plan_slots}` : '');
  const head =
    `reviewer (${out.angle}; ${out.stage}): main ${counts.main} / fix ${counts.fix} / develop ${counts.develop} / ` +
    `supporting ${counts.supporting} / dead_end ${counts.dead_end} / cut ${counts.cut} / stop ${counts.stop}, ${slotText}; ` +
    `${found} cited quotes found, ${notFound} not found`;
  return [head, ...body].join('\n');
}

// ---------------------------------------------------------------- artifact gate

function artifactPaths(prompt) {
  const out = [];
  for (const m of prompt.matchAll(/^\s*artifact:\s*(\S+)/gim)) {
    const p = m[1].replace(/^[`'"]+|[`'"]+$/g, '');
    if (p) out.push(p);
  }
  return out;
}

function resolveArtifactFile(p, bases) {
  const r = resolveEvidencePath(p, bases);
  if (!r) return null;
  try {
    return fs.statSync(r).isFile() ? r : null;
  } catch {
    return null;
  }
}

function stateFile(role, sessionId) {
  const id = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(os.tmpdir(), 'claude-review-hooks', `${role}-${id}.json`);
}

function readRefusals(file) {
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')).artifactRefusals;
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeRefusals(file, n) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ artifactRefusals: n }));
}

function artifactRefusal(role, prompt, bases, sessionId) {
  if (artifactPaths(prompt).some((p) => resolveArtifactFile(p, bases))) return null;
  const file = stateFile(role, sessionId);
  const n = readRefusals(file);
  if (n >= MAX_ARTIFACT_REFUSALS) return null;
  writeRefusals(file, n + 1);
  const what =
    role === 'checker'
      ? 'naming the file to check (a claim: the draft or notes entry; paper: the .tex file). '
      : 'naming the slate to judge (results so far and the plan, one item per line: write it to a file first). ';
  return (
    `Refusing the ${role} dispatch: the brief needs a line \`artifact: <path>\` ${what}` +
    `The path is relative to the working directory or absolute, and the file must exist. ` +
    `A ${role} that only sees your summary checks your summary.`
  );
}

// ---------------------------------------------------------------- hook modes

function extractWorkerText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse == null) return null;
  if (Array.isArray(toolResponse)) {
    const texts = toolResponse
      .map((b) => (typeof b === 'object' && b !== null && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  if (typeof toolResponse === 'object') {
    if (typeof toolResponse.text === 'string') return toolResponse.text;
    if (Array.isArray(toolResponse.content)) return extractWorkerText(toolResponse.content);
  }
  return null;
}

const isDispatch = (i, role) =>
  (i.tool_name === 'Agent' || i.tool_name === 'Task') &&
  isString(i.tool_input?.subagent_type) &&
  ROLE_RE[role].test(i.tool_input.subagent_type);

const basesOf = (i) => [isString(i.cwd) && i.cwd ? i.cwd : process.cwd()];

function pre(role, i) {
  if (!isDispatch(i, role)) return null;
  const reason = artifactRefusal(role, String(i.tool_input.prompt ?? ''), basesOf(i), i.session_id);
  if (!reason) return null;
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

function stop(role, i) {
  if (!isString(i.agent_type) || !ROLE_RE[role].test(i.agent_type)) return null;
  if (i.stop_hook_active) return null;
  const r = validateOutput(role, i.last_assistant_message ?? '');
  if (!r.valid) {
    return {
      decision: 'block',
      reason:
        `your final message does not match the ${role} JSON schema (${r.errors.slice(0, 6).join('; ')}). ` +
        `return only the JSON: one object in the schema from your instructions, nothing before or after it. ` +
        `reuse what you already found; do not redo the work.`,
    };
  }
  const bad = [];
  const bases = basesOf(i);
  for (const it of isArray(r.parsed.items) ? r.parsed.items : []) {
    for (const ev of isArray(it?.evidence) ? it.evidence : []) {
      const c = checkQuote(ev, bases);
      if (c.status === 'missing') bad.push(`${ev.path}:${ev.line} quote not found`);
      else if (c.status === 'nofile') bad.push(`${ev.path}:${ev.line} file not found`);
    }
  }
  if (bad.length === 0) return null;
  return {
    decision: 'block',
    reason:
      bad.map((b) => `${b}: fix the quote or line, or drop that evidence so the objection shows as unbacked`).join('\n') +
      `\nthen return only the JSON again.`,
  };
}

function post(role, i) {
  if (i.agent_id) return null;
  if (!isDispatch(i, role)) return null;
  const raw = extractWorkerText(i.tool_response);
  if (raw == null || !raw.trim()) return null;
  if (raw.includes('Async agent launched successfully')) return null;
  const r = validateOutput(role, raw);
  let text;
  if (!r.valid) {
    text =
      `${role} output did not match its JSON schema (${r.errors.slice(0, 5).join('; ')}); ` +
      `its quotes were not checked. Read the text directly and do not treat its objections as verified.`;
  } else {
    const block = role === 'checker' ? summarizeChecker(r.parsed, basesOf(i)) : summarizeReviewer(r.parsed, basesOf(i));
    text =
      `${role} return, each cited quote checked against the file on disk. Anything marked UNVERIFIED or unbacked ` +
      `is not established: check each point you adopt against the lines shown and drop what does not hold.\n\n${block}`;
  }
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

const MODES = { pre, stop, post };

async function main() {
  const [role, mode] = process.argv.slice(2);
  if (!ROLE_RE[role] || !MODES[mode]) return;
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const i = JSON.parse(input);
  if (!isObject(i)) return;
  const out = MODES[mode](role, i);
  if (out) process.stdout.write(JSON.stringify(out));
}

process.on('uncaughtException', () => process.exit(0));
// No process.exit on success: stdout to a pipe is async on macOS and exit would cut it off.
main().then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 0; },
);
