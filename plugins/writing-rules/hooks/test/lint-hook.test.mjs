import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lint-hook.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-hook-'));
const HYPE = 'Remarkably, the model generalizes.\n';
fs.writeFileSync(path.join(work, 'paper.tex'), HYPE);
fs.writeFileSync(path.join(work, 'README.md'), HYPE);
fs.writeFileSync(path.join(work, 'clean.md'), 'The model generalizes to longer sequences.\n');
fs.mkdirSync(path.join(work, '.claude'));
fs.writeFileSync(path.join(work, '.claude', 'notes.md'), HYPE);
fs.writeFileSync(path.join(work, 'many.md'), 'Remarkably it works.\n'.repeat(25));

function run(file, env = {}, tool = 'Write') {
  const input = { session_id: 's', cwd: work, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file } };
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('.tex with "remarkably" gives context', () => {
  const r = run(path.join(work, 'paper.tex'));
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(r.hookSpecificOutput.additionalContext, /^writing-rules lint, .*paper\.tex: 1 hits\n.*paper\.tex:1: \[adverb\] Remarkably/);
});

test('relative path resolved against cwd', () => {
  assert.match(run('paper.tex', {}, 'Edit').hookSpecificOutput.additionalContext, /1 hits/);
});

test('README.md, .claude/, clean file, non-prose file: nothing', () => {
  assert.equal(run(path.join(work, 'README.md')), null);
  assert.equal(run(path.join(work, '.claude', 'notes.md')), null);
  assert.equal(run(path.join(work, 'clean.md')), null);
  assert.equal(run(path.join(work, 'x.py')), null);
});

test('WRITING_RULES_LINT=0: nothing', () => {
  assert.equal(run(path.join(work, 'paper.tex'), { WRITING_RULES_LINT: '0' }), null);
});

test('at most 20 hit lines', () => {
  const c = run(path.join(work, 'many.md')).hookSpecificOutput.additionalContext;
  assert.match(c, /: 25 hits\n/);
  assert.equal((c.match(/\[adverb\]/g) ?? []).length, 20);
  assert.match(c, /… 5 more$/);
});

test('missing file or no python3: silent', () => {
  assert.equal(run(path.join(work, 'gone.md')), null);
  assert.equal(run(path.join(work, 'paper.tex'), { PATH: '/nonexistent' }), null);
});
