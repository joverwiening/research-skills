# Draws the four plugin icons (1024 px PNG): python docs/make_icons.py <out dir>, then copy each to plugins/<name>/.claude-plugin/icon.png.
# Coordinates are fractions of the icon; every glyph sits in the same 0.21-0.79 box so the four look like one set.
import math, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Circle, Polygon

out = sys.argv[1]
BG, FG = '#2563EB', 'white'   # primary blue of docs/figure_style.py
SIZE_IN, DPI = 5.12, 200
S = 0.032                     # main stroke, as a fraction of the icon width

def pt(f):
    return f * SIZE_IN * 72

def base():
    fig = plt.figure(figsize=(SIZE_IN, SIZE_IN), dpi=DPI)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0.02, 0.02), 0.96, 0.96, boxstyle='round,pad=0,rounding_size=0.2', fc=BG, ec='none'))
    return fig, ax

def line(ax, xs, ys, w=S, c=FG, z=3, **kw):
    ax.plot(xs, ys, color=c, lw=pt(w), solid_capstyle='round', solid_joinstyle='round', zorder=z, **kw)

def save(fig, name):
    fig.savefig(f'{out}/{name}.png', transparent=True); plt.close(fig)

# lit-search: a magnifier over a citation graph
fig, ax = base()
cx, cy, r = 0.435, 0.565, 0.20
ax.add_patch(Circle((cx, cy), r, fc='none', ec=FG, lw=pt(S), zorder=4))
a = -math.pi / 4
line(ax, [cx + (r + S / 2) * math.cos(a), 0.755], [cy + (r + S / 2) * math.sin(a), 0.245], w=1.7 * S, z=4)
hub = (cx, cy)
sats = [(cx + d * math.cos(math.radians(g)), cy + d * math.sin(math.radians(g)))
        for g, d in [(25, 0.112), (100, 0.105), (170, 0.115), (240, 0.108), (310, 0.112)]]
for p in sats:
    line(ax, [hub[0], p[0]], [hub[1], p[1]], w=0.45 * S)
for i, j in [(0, 1), (2, 3)]:
    line(ax, [sats[i][0], sats[j][0]], [sats[i][1], sats[j][1]], w=0.45 * S)
ax.add_patch(Circle(hub, 0.045, fc=FG, ec='none', zorder=5))
for p in sats:
    ax.add_patch(Circle(p, 0.027, fc=FG, ec='none', zorder=5))
save(fig, 'lit-search')

# checker: data with error bars and a check badge
fig, ax = base()
line(ax, [0.24, 0.24, 0.76], [0.76, 0.24, 0.24], w=0.8 * S)
line(ax, [0.29, 0.635], [0.335, 0.522], w=0.45 * S, c=(1, 1, 1, 0.7), dashes=(2.2, 1.6))   # model
for x, y, e in [(0.35, 0.36, 0.06), (0.47, 0.43, 0.065), (0.59, 0.49, 0.06)]:
    line(ax, [x, x], [y - e, y + e], w=0.4 * S)
    for yy in (y - e, y + e):
        line(ax, [x - 0.015, x + 0.015], [yy, yy], w=0.4 * S)
    ax.add_patch(Circle((x, y), 0.024, fc=FG, ec='none', zorder=4))
bx, by, br = 0.665, 0.675, 0.10
ax.add_patch(Circle((bx, by), br, fc=FG, ec='none', zorder=5))
line(ax, [bx - 0.047, bx - 0.013, bx + 0.05], [by + 0.0, by - 0.035, by + 0.041], w=0.85 * S, c=BG, z=6)
save(fig, 'checker')

# reviewers: a manuscript (figure + text) with a verdict next to each part
fig, ax = base()
dx = 0.012
px0, px1, py0, py1 = 0.22 + dx, 0.56 + dx, 0.22, 0.78
ax.add_patch(FancyBboxPatch((px0, py0), px1 - px0, py1 - py0, boxstyle='round,pad=0,rounding_size=0.035',
                            fc='none', ec=FG, lw=pt(0.8 * S), zorder=3))
for i, h in enumerate([0.045, 0.075, 0.105]):
    x = px0 + 0.07 + i * 0.075
    ax.add_patch(FancyBboxPatch((x, 0.605), 0.045, h, boxstyle='round,pad=0,rounding_size=0.008', fc=FG, ec='none', zorder=3))
for y, x1 in [(0.495, px1 - 0.065), (0.445, px1 - 0.11), (0.345, px1 - 0.065), (0.295, px1 - 0.13)]:
    line(ax, [px0 + 0.07, x1], [y, y], w=0.7 * S)
mx, m = 0.70 + dx, 0.042
line(ax, [mx - m, mx - 0.01, mx + m], [0.655, 0.62, 0.69], w=0.8 * S)                     # keep
line(ax, [mx, mx], [0.505, 0.462], w=0.8 * S)                                            # fix
ax.add_patch(Circle((mx, 0.425), 0.4 * S * 1.15, fc=FG, ec='none', zorder=4))
line(ax, [mx - 0.034, mx + 0.034], [0.286, 0.354], w=0.8 * S)                             # cut
line(ax, [mx - 0.034, mx + 0.034], [0.354, 0.286], w=0.8 * S)
save(fig, 'reviewers')

# writing-rules: lines of text, one flagged word, a pen nib writing the last line
fig, ax = base()
dx, lw_t = 0.035, 0.7 * S
line(ax, [0.225 + dx, 0.40 + dx], [0.73, 0.73], w=lw_t); line(ax, [0.45 + dx, 0.70 + dx], [0.73, 0.73], w=lw_t)
line(ax, [0.225 + dx, 0.32 + dx], [0.59, 0.59], w=lw_t)
line(ax, [0.37 + dx, 0.55 + dx], [0.59, 0.59], w=lw_t, c=(1, 1, 1, 0.45))
t = np.linspace(0, 1, 80)
line(ax, 0.37 + dx + 0.18 * t, 0.53 + 0.012 * np.sin(2 * np.pi * 3 * t), w=0.4 * S)
line(ax, [0.225 + dx, 0.48 + dx], [0.43, 0.43], w=lw_t)
line(ax, [0.225 + dx, 0.42 + dx], [0.27, 0.27], w=lw_t)
tip = np.array([0.465 + dx, 0.27]); ang = math.pi / 4
U = np.array([math.cos(ang), math.sin(ang)]); V = np.array([-U[1], U[0]])
L1, L, W = 0.17, 0.27, 0.062
us = np.linspace(0, L1, 30)
ws = W * np.sin(np.pi / 2 * us / L1) ** 0.85
side = [(u, w) for u, w in zip(us, ws)] + [(L, W)]
pts = [tip + u * U + w * V for u, w in side] + [tip + u * U - w * V for u, w in reversed(side)]
ax.add_patch(Polygon(pts, closed=True, fc=FG, ec=FG, lw=pt(0.12 * S), joinstyle='round', zorder=5))
line(ax, *zip(tip + 0.03 * U, tip + 0.11 * U), w=0.22 * S, c=BG, z=6)
ax.add_patch(Circle(tip + 0.125 * U, 0.018, fc=BG, ec='none', zorder=6))
save(fig, 'writing-rules')
