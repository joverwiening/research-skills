---
name: reviewers
description: Referee-style review of research work in progress or a finished draft. Use for "review this", "is this promising", "is this going anywhere", "is this figure good", "is this result good enough", "what's missing", "review the draft", "judge the plan". Also before a figure or section goes into a paper and before a new round of experiments. Two stages, direction (work in progress) and final (draft or submission). 2-3 reviewer agents with different angles read the raw material, tell the story it could tell, and give every item a verdict. SKIP for checking whether one number or claim is correct (use checker) and for code review.
---

# Reviewers

A reviewer reads what exists and judges it. It never builds: anything new (a run, a proof, an
analysis) it names in one line, and you or the user design it afterwards.

What worked for us: every reviewer gives EVERY item a verdict, reads the raw notes rather than your
summary, and names what would kill each kept item. An open "pressure-test this" brief came back with
everything kept.

What broke: with only keep-or-cut against a slot count, a review run overnight applied its cuts without
asking and a figure went from 7 panels to 3, promising results included. The fix is in this skill:
every reviewer reads the items together first and returns the story, under-evidenced work is
*develop*, never cut, and every cut is a proposal that waits for the user.

## 1. Pick the stage

- **direction**: work in progress, pieces missing. "Is this promising", a fresh result, a half-built
  figure, a plan, a big batch of jobs. No slot cap, nothing cut: a result already killed by a control
  is `dead_end` (flagged, cited, not removed). Overall = promising / promising with work / not promising.
- **final**: a paper draft, a figure going into the paper, a submission. Scarce slots, journal
  referee. Overall = accept / minor / major / reject.

Unsure → direction. Final on unfinished work is what destroyed that figure.

## 2. Write the artifact

- **Slate** (results + plan): a markdown file, numbered items, no argument for any. `goal` one line
  (paper, claim or decision; venue). `story` the line the work is meant to tell. `results` one line
  each with the file and line it rests on. `plan` one line each: running jobs, planned runs, controls,
  side threads.
- **Fresh result**: the results file, plus the claims it should carry.
- **Draft or figure**: the `.tex` / `.md` file or the PNG/PDF itself; items = claims, sections or panels.

Every brief names the story the piece sits in (paper outline, the other figures, the slate): one figure
or section is judged by what it does for the whole, and content that fits the story but not this piece
moves to where it serves instead of being dropped.

## 3. Dispatch 2-3 reviewer agents in parallel, in one message

`subagent_type: "reviewer"` (in a plugin install it may show as `reviewers:reviewer`). The hook refuses
a dispatch without an `artifact:` line naming an existing file. Each brief:

```
artifact: <path>
stage: direction | final
goal: <paper, claim or decision; venue>
story: <the line the work is meant to tell; where the outline or other figures are>
slots: <final: how many main results or panels fit>   plan_slots: <if runs compete for compute>
sources: <results/notes files, data and log dirs, the plan>
angle: <one of the angles below>
```

Angles, one per reviewer, never two with the same:

- *story editor* (every round): the strongest story the existing results can tell, which ones carry
  it, which promising ones are under-used or in the wrong place, the single missing link.
- *skeptic on side work*: which controls, ablations and deep dives cannot change the conclusion.
- *journal referee at <venue>*: per claim or panel, what a referee would demand, the overall call.
  The ≤3 strongest correctness or novelty objections from the communities the paper borrows from or
  claims to beat. A caveat that is not in the title, abstract or figures counts as missing.
- *PI reading fast*: the one message; what a busy reader takes away in 30 seconds.

direction: story editor + skeptic. final: story editor + referee (+ PI for a full paper).

## 4. After they return

Each reviewer returns JSON: `story` (now / best / gap / lead), a verdict per item (main / fix /
develop / supporting / dead_end / cut / stop) with what would kill it, `missing`, `overall`. The
plugin's hooks check every cited quote against its file and mark it (✓ / ~ / ✗). Before you pass on
a cut, stop, dead_end or fix, open the note behind it and check it is current: a referee working from
an old note once judged one of our papers out of scope for its journal, and the user corrected it
within minutes.

- **direction**: work out the leads. One fresh subagent per lead (the story gap, each develop item
  worth it), one route each, the brief carrying the reviewer's one-line need and the notes it rests on.
- **final**: fixes and checks. A checker on every number, caption and claim the fixes touch (the
  `checker` plugin), a literature search for any "first" or "new" claim.

Report per reviewer; never "all reviewers say" unless each did. Where their *best* stories differ, say
so: that is often the most useful thing a round turns up.

## 5. Tell the user

First line: the story the reviewers see and the lead to develop; then the main change (final: the
overall call). Then *develop* (what it needs), *fix*, *dead end*, *cut* (proposed), *stop* (proposed),
*missing*, *I disagree* (which verdict, why), one line each. Offer the per-reviewer detail.

## Don't

- Apply a cut, stop or dead_end without the user's go: no panel, result or thread leaves a figure,
  draft or plan, and no job is cancelled, until they answer.
- Hand reviewers your summary instead of the notes.
- Turn it into a length edit. Reviewers judge claims, panels and experiments, not words.
- Ask a reviewer to design the next step.
