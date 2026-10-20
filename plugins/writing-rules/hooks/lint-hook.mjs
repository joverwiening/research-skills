#!/usr/bin/env node
// PostToolUse Write|Edit|MultiEdit: run scripts/lint.py on an edited .tex/.md file and hand the hits to the agent.
// Off with WRITING_RULES_LINT=0. No python3, a lint error or any exception: exit 0 with no output.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_HITS = 20;
const LINT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lint.py');

function skip(file) {
  if (!/\.(tex|md)$/i.test(file)) return true;
  const parts = file.split(/[\\/]+/);
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p === '.claude')) return true;
  return /^(readme|changelog)(\.|$)|^licen[cs]e/i.test(path.basename(file));
}

async function main() {
  if (process.env.WRITING_RULES_LINT === '0') return;
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const i = JSON.parse(input);
  const fp = i?.tool_input?.file_path;
  if (typeof fp !== 'string' || !fp) return;
  const file = path.resolve(typeof i.cwd === 'string' && i.cwd ? i.cwd : process.cwd(), fp);
  if (skip(file)) return;
  const r = spawnSync('python3', [LINT, file], { encoding: 'utf8', timeout: 8000 });
  if (r.error || r.status === null || r.status > 1) return;
  const lines = String(r.stdout ?? '').trimEnd().split('\n');
  if (!/^(\d+ flagged|clean)$/.test(lines[lines.length - 1] ?? '')) return;
  const hits = lines.filter((l) => /:\d+: \[[a-z-]+\] /.test(l));
  if (hits.length === 0) return;
  const shown = hits.slice(0, MAX_HITS);
  if (hits.length > MAX_HITS) shown.push(`… ${hits.length - MAX_HITS} more`);
  const text = `writing-rules lint, ${file}: ${hits.length} hits\n${shown.join('\n')}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
}

process.on('uncaughtException', () => process.exit(0));
main().then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 0; },
);
