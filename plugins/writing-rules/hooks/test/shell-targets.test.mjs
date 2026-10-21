import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedDuring, namedFiles } from '../shell-targets.mjs';

const CWD = '/w';
const keep = (f) => /\.(md|tex|py)$/.test(f);
const named = (cmd) => namedFiles(cmd, CWD, keep);

test('cat > with a heredoc', () => {
  assert.deepEqual(named("cat > paper.md <<'EOF'\nThe model generalizes.\nEOF"), ['/w/paper.md']);
});

test('tee -a, sed -i', () => {
  assert.deepEqual(named('echo hi | tee -a notes.md'), ['/w/notes.md']);
  assert.deepEqual(named("sed -i 's/a/b/' main.tex"), ['/w/main.tex']);
});

test('cp names both files', () => {
  assert.deepEqual(named('cp draft.md final.md'), ['/w/draft.md', '/w/final.md']);
});

test('python open() with the path in quotes', () => {
  assert.deepEqual(named(`python -c "open('theory_verify_a.py','w').write(s)"`), ['/w/theory_verify_a.py']);
});

test('cd DIR && ... resolves against cwd and DIR', () => {
  const r = named('cd sub && cat > main.tex');
  assert.ok(r.includes('/w/sub/main.tex'));
  assert.ok(r.includes('/w/main.tex'));
});

test('dd of=out.md gives out.md', () => {
  assert.deepEqual(named('dd if=/dev/zero of=out.md'), ['/w/out.md']);
});

test('quoted path with a space: allowed to miss', () => {
  assert.ok(!named('cat > "quoted dir/x.md"').includes('/w/quoted dir/x.md'));
});

test('~/x.md resolves to the home directory', () => {
  assert.deepEqual(named('cat > ~/x.md'), [path.join(os.homedir(), 'x.md')]);
});

test('trailing period stripped', () => {
  assert.deepEqual(named('echo see paper.tex.'), ['/w/paper.tex']);
});

test('changedDuring: fresh in, old out, missing out, absent duration_ms is a 120 s window', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-targets-'));
  const fresh = path.join(d, 'fresh.md');
  const old = path.join(d, 'old.md');
  const mid = path.join(d, 'mid.md');
  fs.writeFileSync(fresh, 'x');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(mid, 'x');
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 3600e3), new Date(now - 3600e3));
  fs.utimesSync(mid, new Date(now - 60e3), new Date(now - 60e3));
  const all = [fresh, old, mid, path.join(d, 'missing.md'), d];
  assert.deepEqual(changedDuring(all, 1000, now), [fresh]);
  assert.deepEqual(changedDuring(all, undefined, now), [fresh, mid]);
});
