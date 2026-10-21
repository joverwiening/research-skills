// Files a Bash command names and that changed while it ran: catches cat >, heredocs, tee, sed -i, cp/mv and python open() when the path appears literally; misses globs and paths built at runtime.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILES = 50;
const CD_RE = /(?:^|;|&&|\|\||\||\(|\n)\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|()<>]+))/g;

function expandHome(p) {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function namedFiles(command, cwd, keep) {
  if (typeof command !== 'string' || !command) return [];
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const dirs = [base];
  for (const m of command.matchAll(CD_RE)) {
    const d = m[1] ?? m[2] ?? m[3];
    if (d) dirs.push(path.resolve(base, expandHome(d)));
  }
  const out = new Set();
  for (const raw of command.split(/[^\w@%+,.~\/-]+/)) {
    const t = raw.replace(/[.,]+$/, '');
    if (!t || !keep(t)) continue;
    if (t.startsWith('~/')) out.add(expandHome(t));
    else if (path.isAbsolute(t)) out.add(path.normalize(t));
    else for (const d of dirs) out.add(path.resolve(d, t));
    if (out.size >= MAX_FILES) break;
  }
  return [...out].slice(0, MAX_FILES);
}

export function changedDuring(paths, durationMs, now = Date.now()) {
  const since = now - (Number.isFinite(durationMs) ? durationMs : 120000) - 2000;
  return paths.filter((p) => {
    try {
      const s = fs.statSync(p);
      return s.isFile() && s.mtimeMs >= since;
    } catch {
      return false;
    }
  });
}
