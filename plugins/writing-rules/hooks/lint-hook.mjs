#!/usr/bin/env node
// PostToolUse Write|Edit|MultiEdit|Bash: run scripts/lint.py on an edited .tex/.md file and hand the hits to the agent.
// For Bash, the files are the .tex/.md paths the command names that changed while it ran (shell-targets.mjs).
// Off with WRITING_RULES_LINT=0. No python3, a lint error or any exception: exit 0 with no output.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedDuring, namedFiles } from './shell-targets.mjs';

const MAX_HITS = 20;
const LINT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lint.py');

function skip(file) {
  if (!/\.(tex|md)$/i.test(file)) return true;
  const parts = file.split(/[\\/]+/);
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p === '.claude')) return true;
  return /^(readme|changelog)(\.|$)|^licen[cs]e/i.test(path.basename(file));
}

function lintHits(file) {
  const r = spawnSync('python3', [LINT, file], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status === null || r.status > 1) return [];
  const lines = String(r.stdout ?? '').trimEnd().split('\n');
  if (!/^(\d+ flagged|clean)$/.test(lines[lines.length - 1] ?? '')) return [];
  return lines.filter((l) => /:\d+: \[[a-z-]+\] /.test(l));
}

function emit(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
}

async function main() {
  if (process.env.WRITING_RULES_LINT === '0') return;
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const i = JSON.parse(input);
  const cwd = typeof i?.cwd === 'string' && i.cwd ? i.cwd : process.cwd();
  if (i?.tool_name === 'Bash') {
    // A background command has not run yet.
    if (i.tool_input?.run_in_background === true) return;
    const files = changedDuring(namedFiles(i.tool_input?.command, cwd, (f) => !skip(f)), i.duration_ms).slice(0, 5);
    let left = MAX_HITS;
    const blocks = [];
    for (const file of files) {
      const hits = lintHits(file);
      if (hits.length === 0) continue;
      const shown = hits.slice(0, left);
      left -= shown.length;
      if (hits.length > shown.length) shown.push(`… ${hits.length - shown.length} more`);
      blocks.push(`writing-rules lint, ${file} (written through the shell): ${hits.length} hits\n${shown.join('\n')}`);
    }
    if (blocks.length) emit(blocks.join('\n\n'));
    return;
  }
  const fp = i?.tool_input?.file_path;
  if (typeof fp !== 'string' || !fp) return;
  const file = path.resolve(cwd, fp);
  if (skip(file)) return;
  const hits = lintHits(file);
  if (hits.length === 0) return;
  const shown = hits.slice(0, MAX_HITS);
  if (hits.length > MAX_HITS) shown.push(`… ${hits.length - MAX_HITS} more`);
  emit(`writing-rules lint, ${file}: ${hits.length} hits\n${shown.join('\n')}`);
}

process.on('uncaughtException', () => process.exit(0));
main().then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 0; },
);
