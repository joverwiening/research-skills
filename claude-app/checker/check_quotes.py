#!/usr/bin/env python3
"""Check that each cited quote is really in its file. Standard library only.

usage: python check_quotes.py objections.json
objections.json: [{"claim": "...", "path": "file", "line": 42, "quote": "verbatim text"}, ...]
Relative paths resolve from the current directory, then from the JSON file's directory.
A quote counts as found at its line if it sits within 3 lines of it (spans of up to 3 lines are joined).
Elsewhere in the file only counts for quotes of 20+ characters: a short one like "0.73" matches anywhere.
Exit 1 if any quote is not found.
"""
import json
import os
import re
import sys

MIN_MOVED = 20


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def span(lines, start, n):
    if start < 1 or start + n - 1 > len(lines):
        return None
    return norm(' '.join(lines[start - 1:start - 1 + n]))


def has(lines, start, q):
    for n in (1, 2, 3):
        s = span(lines, start, n)
        if s is not None and q in s:
            return True
    return False


def check(ev, bases):
    p = ev.get('path') or ''
    f = p if os.path.isabs(p) else next((os.path.join(b, p) for b in bases if os.path.exists(os.path.join(b, p))), p)
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            lines = fh.read().replace('\r\n', '\n').replace('\r', '\n').split('\n')
    except OSError:
        return 'no file', None
    q = norm(ev.get('quote'))
    line = ev.get('line') if isinstance(ev.get('line'), int) else 1
    if not q:
        return 'not found', None
    if any(has(lines, s, q) for s in range(line - 3, line + 4)):
        return 'found', line
    if len(q) < MIN_MOVED:
        return 'not found', None
    for s in range(1, len(lines) + 1):
        for n in (1, 2, 3):
            t = span(lines, s, n)
            if t is None or q not in t:
                continue
            rest = span(lines, s + 1, n - 1) if n > 1 else None
            if rest is not None and q in rest:
                continue
            return 'found elsewhere', s
    return 'not found', None


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    bases = [os.getcwd(), os.path.dirname(os.path.abspath(src))]
    with open(src, encoding='utf-8') as fh:
        items = json.load(fh)
    bad = 0
    for ev in items:
        status, at = check(ev, bases)
        where = f"{ev.get('path')}:{ev.get('line')}"
        note = f' (line {at})' if status == 'found elsewhere' else ''
        print(f'{status:16} {where}{note}  "{norm(ev.get("quote"))[:80]}"')
        bad += status in ('not found', 'no file')
    print(f'{len(items) - bad} of {len(items)} quotes found')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
