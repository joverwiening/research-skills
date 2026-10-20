#!/usr/bin/env python3
"""Ban-list lint for prose (.md, .tex, .txt). Standard library only.

usage: python lint.py FILE [FILE ...] [--no-dashes]
Prints file:line: [category] match | context, then a count. Exit 1 if anything was flagged.
Code, math, URLs, block quotes and text inside double quotes are skipped: quoted words are someone else's.
Word list adapted in part from BootLoops prose-lint by Matthew D. Schwartz (CC BY 4.0).
"""
import re
import sys

RULES = [
    ('hype', r'delve|tapestry|realm|testament|underscores?|underscored|leverag(e|es|ed|ing)|unlock|unleash|seamless'
             r'|cutting-edge|game.?chang|revolutioni|paradigm shift|deep dive|ever-evolving|treasure trove|a beacon'
             r'|stands as|the beauty of|shed(s|ding)? light on|pave(s|d)? the way|showcas(e|es|ed|ing)|\bcrucial\b'),
    ('adverb', r'remarkably|interestingly|surprisingly|notably|importantly|strikingly|crucially'),
    ('engineer-register', r'footgun|\bmoat\b|happy path|escape hatch|guardrail|dogfood|greenfield|bikeshed|yak.shav'
                          r'|sanity check|edge case|toolchain|tooling|iterate on|blocker|pain point|load-bearing|hand.?off'),
    ('filler', r'not just|is a feature, not|worth noting|the key is|what matters is|in conclusion|in summary|ultimately,'),
    ('announced', r'\bthe (difference|reason|point|answer|upshot|key|trick|surprise) (is|was) (whether|that|what|how|why)\b'),
    ('abstract-agent', r'\bthe (literature|data|analysis|study|section) (argues|reveals|tells|warns|promises|supplies)\b'),
    ('credential', r'byte.for.byte|byte-identical|fail-closed|pre-committed|frozen protocol|declared, not|not waived'
                   r'|did (its|their) job'),
    ('self-rank', r'\bthe (sharpest|strongest|cleanest) [a-z]+'),
    ('priority', r'to our knowledge|proof of principle|for the first time'),
]
PRIORITY_MIN = 2
DASH = r'—|(?<![-\d])---?(?![-\d])'


def blank(m):
    return re.sub(r'[^\n]', ' ', m.group(0))


def prose_view(text):
    """Non-prose blanked to spaces, so line and column numbers survive."""
    t = re.sub(r'(?<!\\)%[^\n]*', blank, text)                                  # LaTeX comments
    t = re.sub(r'\\begin\{(equation|align|gather|displaymath|verbatim|lstlisting)(\*?)\}[\s\S]*?\\end\{\1\2\}', blank, t)
    t = re.sub(r'```[\s\S]*?```', blank, t)                                     # code fences
    t = re.sub(r'`[^`\n]*`', blank, t)                                          # inline code
    t = re.sub(r'\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)', blank, t)  # display math
    t = re.sub(r'\$(?:[^$\\\n]|\\.)*\$', blank, t)                              # inline math
    t = re.sub(r'https?://\S+', blank, t)
    t = re.sub(r'(?m)^[ \t]*>[^\n]*', blank, t)                                 # block quotes
    t = re.sub(r'“[^”]{0,600}”|"[^"\n]{0,600}"|``(?:(?!\'\')[\s\S]){0,600}\'\'', blank, t)
    t = re.sub(r'\\(cite[pt]?|ref|eqref|label|includegraphics|url)\*?(\[[^\]\n]*\])*\{[^}]*\}', blank, t)
    return t


def line_of(text, pos):
    return text.count('\n', 0, pos) + 1


def lint(path, no_dashes):
    raw = open(path, encoding='utf-8', errors='replace').read()
    view = prose_view(raw)
    lines = raw.split('\n')
    hits = []

    def add(cat, m):
        n = line_of(view, m.start())
        ctx = lines[n - 1].strip()
        hits.append((n, cat, m.group(0), ctx[:110]))

    for cat, pat in RULES:
        found = list(re.finditer(pat, view, re.I))
        if cat == 'priority' and len(found) < PRIORITY_MIN:
            continue
        for m in found:
            add(cat, m)
    if no_dashes:
        for m in re.finditer(DASH, view):
            add('dash', m)
    # two or more colons/semicolons inside one sentence = competing stress positions
    for m in re.finditer(r'[^.!?\n]+(?:\n(?![ \t]*(?:\n|[-*•+#]|\d+[.)]))[^.!?\n]*)*', view):
        s = m.group(0)
        if s.count(':') + s.count(';') >= 2:
            n = line_of(view, m.start() + len(s) - len(s.lstrip()))
            hits.append((n, 'stress', f"{s.count(':')} colon(s), {s.count(';')} semicolon(s)", ' '.join(s.split())[:110]))
    hits.sort()
    for n, cat, word, ctx in hits:
        print(f'{path}:{n}: [{cat}] {word} | {ctx}')
    return len(hits)


def main(argv):
    no_dashes = '--no-dashes' in argv
    files = [a for a in argv if a != '--no-dashes']
    if not files:
        print(__doc__.strip().split('\n')[2])
        return 2
    total = sum(lint(f, no_dashes) for f in files)
    print(f'{total} flagged' if total else 'clean')
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
