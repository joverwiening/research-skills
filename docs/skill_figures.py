"""README figures, one per measured skill. Counts are copied from our evaluation notes; the runs used private research data.
  lit-search A: 10 research questions, targets = 92 papers our earlier agent searches had cited. Top 30 of a 4-query keyword
                search (the old pull, ranked by Jev) held 22, lit-search (word-overlap ranking + one hop of citations) 32.
  lit-search B: 7 published reviews (2020-24), targets = their 1204 references, search capped at the review year.
                Hits in the top 100: search alone 95, plus one hop of references and citers 116.
  checker:      146 corrections a researcher made to an agent's claims, replayed on the earlier no-tools critic
                with the top-5 word-match notes pasted in. Caught (strict judge): agent re-reading
                its own message 9, checker without notes 7, checker with the project's notes 26. Wilson 95 % intervals.
"""
import math
import os

import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, 'figure_style.py')).read())
BASE, OURS = COLORS['gray'], COLORS['primary']
INK = '#374151'


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def hbars(ax, labels, values, colors, xmax, text, err=None):
    y = list(range(len(values)))[::-1]
    ax.barh(y, values, color=colors, height=0.62, xerr=err, capsize=2.5,
            error_kw={'elinewidth': 0.8, 'ecolor': INK, 'capthick': 0.8})
    ends = values if err is None else [v + e for v, e in zip(values, err[1])]
    for yi, end, t, c in zip(y, ends, text, colors):
        ax.text(end + xmax * 0.025, yi, t, va='center', ha='left', fontsize=9.5,
                color=INK if c == BASE else OURS, fontweight='normal' if c == BASE else 'bold')
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=9.5)
    ax.tick_params(axis='y', length=0)
    ax.spines['left'].set_visible(False)
    ax.set_xlim(0, xmax)
    ax.spines['bottom'].set_visible(False)
    ax.set_xticks([])


# lit-search
fig, (a, b) = plt.subplots(1, 2, figsize=(7, 1.6), constrained_layout=True)
hbars(a, ['keyword search, Jev-ranked', 'lit-search'], [22, 32], [BASE, OURS], 40, ['22', '32'])
a.set_title('Known papers in the top 30\n10 questions, 92 target papers', fontsize=10, loc='left')
hbars(b, ['search alone', '+ citation chasing'], [95, 116], [BASE, OURS], 140, ['95', '116'])
b.set_title('Review references in the top 100\n7 reviews, 1204 references', fontsize=10, loc='left')
save_fig(fig, 'lit-search', directory=HERE)

# checker
n, caught = 146, [9, 7, 26]
pct = [100 * k / n for k in caught]
ci = [wilson(k, n) for k in caught]
err = [[p - 100 * lo for p, (lo, _) in zip(pct, ci)], [100 * hi - p for p, (_, hi) in zip(pct, ci)]]
fig, ax = plt.subplots(figsize=(4.6, 1.9), constrained_layout=True)
hbars(ax, ['agent re-reads its message', 'checker, no notes', 'checker + project notes'], pct,
      [BASE, BASE, OURS], 32, [f'{p:.0f} %' for p in pct], err=err)
ax.set_title("A researcher's corrections caught\n146 replayed, on a version without file access", fontsize=10, loc='left')
save_fig(fig, 'checker', directory=HERE)
