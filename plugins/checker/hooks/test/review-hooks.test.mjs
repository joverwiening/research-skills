import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'review-hooks.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-hooks-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-state-'));
fs.writeFileSync(path.join(work, 'draft.md'), 'The effect size is 0.73 across all seeds.\n');
fs.writeFileSync(
  path.join(work, 'notes.md'),
  ['# notes', '', 'seed 3 was excluded from the average after the rerun', 'filler', 'filler', 'filler', 'filler', 'filler',
    'filler', 'filler', 'only two of five seeds show the effect above shuffle baseline', ''].join('\n'),
);

function run(mode, input) {
  const r = spawnSync(process.execPath, [SCRIPT, 'checker', mode], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const dispatch = (prompt, session, type = 'checker') => ({
  session_id: session, cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: type, description: 'check', prompt },
});

const out = (items, extra = {}) => ({ status: 'ok', items, delete: [], ...extra });
const wrong = (evidence) => ({ item: 'effect size 0.73 across all seeds', call: 'wrong', why: 'two of five seeds', evidence, kill: 'all seeds above shuffle' });
const ev = (line, quote, p = 'notes.md') => ({ path: p, line, quote });
const stopInput = (msg, active = false, type = 'checker') => ({
  session_id: 's', cwd: work, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: type,
  stop_hook_active: active, last_assistant_message: typeof msg === 'string' ? msg : JSON.stringify(msg),
});
const postInput = (text, extra = {}) => ({
  session_id: 's', cwd: work, hook_event_name: 'PostToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: 'checker', prompt: 'artifact: draft.md' },
  tool_response: { status: 'completed', content: [{ type: 'text', text }] }, ...extra,
});

test('pre: missing artifact denied, present allowed, third refusal allowed', () => {
  const a = run('pre', dispatch('check the claim please', 'sess-a'));
  assert.equal(a.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(a.hookSpecificOutput.permissionDecisionReason, /artifact: <path>/);
  assert.equal(run('pre', dispatch('artifact: draft.md\ncheck it', 'sess-a')), null);
  assert.equal(run('pre', dispatch(`artifact: ${path.join(work, 'draft.md')}`, 'sess-a')), null);
  assert.equal(run('pre', dispatch('artifact: nope.md', 'sess-a')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('pre', dispatch('artifact: nope.md', 'sess-a')), null);
  assert.equal(run('pre', dispatch('no artifact', 'sess-b')).hookSpecificOutput.permissionDecision, 'deny');
});

test('pre: namespaced subagent_type checker:checker is gated, others are not', () => {
  assert.equal(run('pre', dispatch('x', 'sess-c', 'checker:checker')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('pre', dispatch('x', 'sess-c', 'reviewer')), null);
  assert.equal(run('pre', dispatch('x', 'sess-c', 'factchecker')), null);
});

test('stop: valid JSON in a ```json fence with good quotes allowed', () => {
  const body = JSON.stringify(out([wrong([ev(11, 'only two of five seeds show the effect')])]));
  assert.equal(run('stop', stopInput('here it is\n```json\n' + body + '\n```\n')), null);
});

test('stop: invalid JSON blocked, stop_hook_active allowed', () => {
  const r = run('stop', stopInput('I checked it and it looks fine.'));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /return only the JSON/);
  const bad = run('stop', stopInput(out([{ item: 'x', call: 'maybe', why: 'y', evidence: [], kill: '' }])));
  assert.equal(bad.decision, 'block');
  assert.match(bad.reason, /call must be one of/);
  assert.equal(run('stop', stopInput('prose', true)), null);
});

test('stop: missing quote and missing file blocked once, moved quote allowed', () => {
  const r = run('stop', stopInput(out([wrong([ev(11, 'no such sentence anywhere in notes'), ev(2, 'whatever', 'gone.md')])])));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /notes\.md:11 quote not found: fix the quote or line, or drop that evidence/);
  assert.match(r.reason, /gone\.md:2 file not found/);
  assert.equal(run('stop', stopInput(out([wrong([ev(11, 'no such sentence anywhere in notes')])]), true)), null);
  assert.equal(run('stop', stopInput(out([wrong([ev(11, 'seed 3 was excluded from the average')])]))), null);
  assert.equal(run('stop', stopInput('prose', false, 'checker:checker')).decision, 'block');
  assert.equal(run('stop', stopInput('prose', false, 'reviewer')), null);
});

test('post: summary with ok / moved / missing / nofile markers', () => {
  const o = out([
    wrong([ev(11, 'only two of five seeds show the effect')]),
    { ...wrong([ev(11, 'seed 3 was excluded from the average')]), call: 'stale' },
    { ...wrong([ev(5, 'not in the file at all, invented')]), call: 'unsupported' },
  ]);
  const r = run('post', postInput(JSON.stringify(o)));
  const c = r.hookSpecificOutput.additionalContext;
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(c, /checker: 3 objections, 2 backed by a quote found in the file, 1 unverified/);
  assert.match(c, /notes\.md:11 ✓ quote in file/);
  assert.match(c, /notes\.md:11 ~ quote found at line 3/);
  assert.match(c, /notes\.md:5 ✗ quote NOT in file — UNVERIFIED/);
  const nf = run('post', postInput(JSON.stringify(out([wrong([ev(1, 'x', 'gone.md')])]))));
  assert.match(nf.hookSpecificOutput.additionalContext, /gone\.md:1 ✗ file not found — UNVERIFIED/);
  const none = run('post', postInput(JSON.stringify(out([wrong([])]))));
  assert.match(none.hookSpecificOutput.additionalContext, /no evidence given — unbacked/);
});

test('post: background ack and subagent-thread calls skipped', () => {
  assert.equal(run('post', postInput('Async agent launched successfully.\nagentId: abc')), null);
  assert.equal(run('post', { ...postInput('x'), tool_response: { status: 'async_launched', agentId: 'abc' } }), null);
  const o = JSON.stringify(out([wrong([])]));
  assert.equal(run('post', postInput(o, { agent_id: 'sub-1' })), null);
  const ns = postInput(o);
  ns.tool_input.subagent_type = 'checker:checker';
  assert.match(run('post', ns).hookSpecificOutput.additionalContext, /checker: 1 objections/);
});

test('garbage stdin exits 0 silently', () => {
  assert.equal(run('pre', 'not json'), null);
  assert.equal(run('stop', ''), null);
});
