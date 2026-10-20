import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'review-hooks.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-hooks-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-state-'));
fs.writeFileSync(path.join(work, 'slate.md'), '- fig 2 capacity curve\n- run the shuffle control\n');
fs.writeFileSync(
  path.join(work, 'notes.md'),
  ['# notes', '', 'the shuffle control removes the capacity gap entirely', 'filler', 'filler', 'filler', 'filler', 'filler',
    'filler', 'filler', 'capacity grows linearly with width up to 512 units', ''].join('\n'),
);

function run(mode, input) {
  const r = spawnSync(process.execPath, [SCRIPT, 'reviewer', mode], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const dispatch = (prompt, session, type = 'reviewer') => ({
  session_id: session, cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Task',
  tool_input: { subagent_type: type, description: 'review', prompt },
});
const ev = (line, quote, p = 'notes.md') => ({ path: p, line, quote });
const review = (items, extra = {}) => ({
  status: 'ok', stage: 'direction', angle: 'referee', goal: 'paper fig 2',
  story: { now: 'capacity grows', best: 'capacity grows with width', gap: 'control', lead: 'fig 2' },
  items, missing: [], overall: 'promising with work', top_cut: '', ...extra,
});
const mainItem = (evidence) => ({ item: 'fig 2 capacity curve', kind: 'result', verdict: 'main', why: 'carries it', kill: 'shuffle kills it', evidence });
const stopInput = (msg, active = false, type = 'reviewer') => ({
  session_id: 's', cwd: work, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: type,
  stop_hook_active: active, last_assistant_message: typeof msg === 'string' ? msg : JSON.stringify(msg),
});
const postInput = (text, extra = {}) => ({
  session_id: 's', cwd: work, hook_event_name: 'PostToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: 'reviewer', prompt: 'artifact: slate.md' },
  tool_response: { status: 'completed', content: [{ type: 'text', text }] }, ...extra,
});

test('pre: missing artifact denied, present allowed, third refusal allowed', () => {
  const a = run('pre', dispatch('judge my plan', 'sess-a'));
  assert.equal(a.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(a.hookSpecificOutput.permissionDecisionReason, /Refusing the reviewer dispatch: the brief needs a line `artifact: <path>`/);
  assert.equal(run('pre', dispatch('stage: direction\nartifact: `slate.md`', 'sess-a')), null);
  assert.equal(run('pre', dispatch('artifact: missing.md', 'sess-a')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('pre', dispatch('artifact: missing.md', 'sess-a')), null);
});

test('pre: namespaced reviewers:reviewer gated, checker not', () => {
  assert.equal(run('pre', dispatch('x', 'sess-c', 'reviewers:reviewer')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('pre', dispatch('x', 'sess-c', 'checker')), null);
});

test('stop: valid JSON in a ```json fence allowed', () => {
  const body = JSON.stringify(review([mainItem([ev(11, 'capacity grows linearly with width')])]));
  assert.equal(run('stop', stopInput('```json\n' + body + '\n```')), null);
});

test('stop: invalid JSON or schema blocked, stop_hook_active allowed', () => {
  assert.equal(run('stop', stopInput('looks good overall')).decision, 'block');
  const cut = run('stop', stopInput(review([{ ...mainItem([]), verdict: 'cut' }])));
  assert.equal(cut.decision, 'block');
  assert.match(cut.reason, /no cut in the direction stage/);
  assert.match(cut.reason, /return only the JSON/);
  assert.equal(run('stop', stopInput('looks good overall', true)), null);
});

test('stop: missing quote blocked, moved quote allowed, nofile blocked', () => {
  const r = run('stop', stopInput(review([mainItem([ev(11, 'a sentence that is not in the notes')])])));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /notes\.md:11 quote not found: fix the quote or line, or drop that evidence so the objection shows as unbacked/);
  assert.equal(run('stop', stopInput(review([mainItem([ev(11, 'the shuffle control removes the capacity gap')])]))), null);
  assert.match(run('stop', stopInput(review([mainItem([ev(1, 'x', 'gone.md')])]))).reason, /gone\.md:1 file not found/);
  assert.equal(run('stop', stopInput(review([mainItem([ev(11, 'a sentence that is not in the notes')])]), true)), null);
});

test('post: summary with verdict counts and quote markers', () => {
  const o = review([
    mainItem([ev(11, 'capacity grows linearly with width'), ev(11, 'the shuffle control removes the capacity gap')]),
    { item: 'run the shuffle control', kind: 'plan', verdict: 'develop', why: 'not designed', develop: 'two seeds, 1 GPU-day', kill: 'x',
      evidence: [ev(4, 'a quote nobody wrote down'), ev(1, 'x', 'gone.md')] },
  ]);
  const c = run('post', postInput(JSON.stringify(o))).hookSpecificOutput.additionalContext;
  assert.match(c, /reviewer \(referee; direction\): main 1 \/ fix 0 \/ develop 1/);
  assert.match(c, /2 cited quotes found, 2 not found/);
  assert.match(c, /notes\.md:11 ✓ quote in file/);
  assert.match(c, /notes\.md:11 ~ quote found at line 3/);
  assert.match(c, /notes\.md:4 ✗ quote NOT in file — UNVERIFIED/);
  assert.match(c, /gone\.md:1 ✗ file not found — UNVERIFIED/);
  assert.match(c, /needs: two seeds, 1 GPU-day/);
  assert.match(c, /story best: capacity grows with width/);
});

test('post: background ack and subagent-thread calls skipped', () => {
  assert.equal(run('post', postInput('Async agent launched successfully.\nagentId: abc')), null);
  assert.equal(run('post', postInput(JSON.stringify(review([mainItem([])])), { agent_id: 'sub-1' })), null);
  const ns = postInput(JSON.stringify(review([mainItem([])])));
  ns.tool_input.subagent_type = 'reviewers:reviewer';
  assert.match(run('post', ns).hookSpecificOutput.additionalContext, /reviewer \(referee; direction\)/);
});

test('garbage stdin exits 0 silently', () => {
  assert.equal(run('post', '{'), null);
});
