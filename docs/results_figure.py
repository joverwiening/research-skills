"""README figure: the three measured comparisons behind lit-search and checker.

Counts are copied from our evaluation notes; the runs themselves used private research data.
  A: 10 research questions, targets = 92 papers our earlier agent searches had cited.
     Pool of the previous agent-run search, ranked by Jev, 22/92 in the top 30; lit-search (word-overlap ranking + one hop of citations) 32/92.
  B: 7 published reviews (2020-24), targets = their 1204 references, search capped at the review year.
     Hits in the top 100: search alone 95, plus one hop of references and citers 116.
  C: 146 corrections a researcher made to an agent's claims, replayed. Caught (strict judge):
     agent re-reading its own message 9, checker without notes 7, checker with the project's notes 26.
"""
import math
import os

import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, 'figure_style.py')).read())


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


fig, axes = plt.subplots(1, 3, figsize=(7, 2.6), constrained_layout=True)
base, ours = COLORS['gray'], COLORS['primary']


def bars(ax, labels, values, colors, ylabel, top, fmt):
    x = range(len(values))
    ax.bar(x, values, color=colors, width=0.6)
    for i, v in enumerate(values):
        ax.text(i, v + top * 0.02, fmt(v), ha='center', va='bottom', fontsize=9)
    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel(ylabel)
    ax.set_ylim(0, top)


bars(axes[0], ['previous\nagent search', 'lit-search'], [22, 32], [base, ours],
     'known papers in top 30\n(of 92)', 40, lambda v: f'{v}')
axes[0].set_title('Search, 10 questions', fontsize=10)

bars(axes[1], ['search\nalone', '+ citation\nchasing'], [95, 116], [base, ours],
     'reference-list papers\nin top 100 (of 1204)', 140, lambda v: f'{v}')
axes[1].set_title('Search, 7 reviews', fontsize=10)

n = 146
caught = [9, 7, 26]
pct = [100 * k / n for k in caught]
lo_hi = [wilson(k, n) for k in caught]
err = [[p - 100 * lo for p, (lo, hi) in zip(pct, lo_hi)], [100 * hi - p for p, (lo, hi) in zip(pct, lo_hi)]]
ax = axes[2]
ax.bar(range(3), pct, color=[base, base, ours], width=0.6, yerr=err, capsize=3,
       error_kw={'elinewidth': 0.8, 'ecolor': '#374151'})
for i, (p, (lo, hi)) in enumerate(zip(pct, lo_hi)):
    ax.text(i + 0.33, p, f'{p:.0f} %', ha='left', va='center', fontsize=9)
ax.set_xticks(range(3))
ax.set_xticklabels(['agent\nre-reads', 'checker,\nno notes', 'checker\n+ notes'], fontsize=8)
ax.set_ylabel('researcher corrections\ncaught (%, of 146)')
ax.set_ylim(0, 30)
ax.set_title('Checker', fontsize=10)

for a, letter in zip(axes, 'ABC'):
    a.text(-0.32, 1.08, letter, transform=a.transAxes, fontsize=11, fontweight='bold', va='bottom')

save_fig(fig, 'results', directory=HERE)
