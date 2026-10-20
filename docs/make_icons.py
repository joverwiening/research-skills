# Draws the four plugin icons (512 px PNG): python docs/make_icons.py <out dir>, then copy each to plugins/<name>/.claude-plugin/icon.png.
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Circle, Polygon
import sys
out = sys.argv[1]
BG, FG = '#2563EB', 'white'

def base():
    fig = plt.figure(figsize=(5.12, 5.12), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0.02, 0.02), 0.96, 0.96, boxstyle='round,pad=0,rounding_size=0.18', fc=BG, ec='none'))
    return fig, ax

def page(ax, x, y, w, h, lines=4):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0,rounding_size=0.03', fc='none', ec=FG, lw=14))
    for i in range(lines):
        yy = y + h - 0.1 - i * (h - 0.16) / max(lines - 1, 1)
        ax.plot([x + 0.07, x + w - 0.07 - (0.08 if i == lines - 1 else 0)], [yy, yy], color=FG, lw=12, solid_capstyle='round')

# lit-search: page + magnifier
fig, ax = base()
page(ax, 0.18, 0.28, 0.42, 0.52)
ax.add_patch(Circle((0.6, 0.42), 0.15, fc=BG, ec=FG, lw=16, zorder=4))
ax.plot([0.71, 0.82], [0.31, 0.2], color=FG, lw=24, solid_capstyle='round', zorder=5)
fig.savefig(f'{out}/lit-search.png', transparent=True); plt.close(fig)

# checker: check mark
fig, ax = base()
ax.plot([0.26, 0.43, 0.75], [0.5, 0.33, 0.7], color=FG, lw=34, solid_capstyle='round', solid_joinstyle='round')
fig.savefig(f'{out}/checker.png', transparent=True); plt.close(fig)

# reviewers: two overlapping pages, front one with a check
fig, ax = base()
ax.add_patch(FancyBboxPatch((0.22, 0.3), 0.36, 0.48, boxstyle='round,pad=0,rounding_size=0.03', fc='none', ec=FG, lw=14, alpha=0.6))
ax.add_patch(FancyBboxPatch((0.4, 0.2), 0.36, 0.48, boxstyle='round,pad=0,rounding_size=0.03', fc=BG, ec=FG, lw=14))
ax.plot([0.48, 0.55, 0.68], [0.44, 0.36, 0.53], color=FG, lw=16, solid_capstyle='round', solid_joinstyle='round')
fig.savefig(f'{out}/reviewers.png', transparent=True); plt.close(fig)

# writing-rules: page + pen
fig, ax = base()
page(ax, 0.18, 0.22, 0.42, 0.56)
A, B = (0.82, 0.78), (0.58, 0.38)
ax.plot([A[0], B[0]], [A[1], B[1]], color=BG, lw=48, solid_capstyle='butt', zorder=4)
ax.plot([A[0], B[0]], [A[1], B[1]], color=FG, lw=28, solid_capstyle='butt', zorder=5)
import math
ux, uy = B[0] - A[0], B[1] - A[1]; n = math.hypot(ux, uy); ux, uy = ux / n, uy / n
px, py = -uy * 0.038, ux * 0.038
ax.add_patch(Polygon([[B[0] + px, B[1] + py], [B[0] - px, B[1] - py], [B[0] + ux * 0.08, B[1] + uy * 0.08]], closed=True, fc=FG, ec=FG, lw=1, zorder=5))
fig.savefig(f'{out}/writing-rules.png', transparent=True); plt.close(fig)
