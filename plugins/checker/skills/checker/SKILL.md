---
name: checker
description: Check claims (a result, a number, a caption, a sentence in a paper) against the raw sources before they are sent, saved or published. Use when the user doubts something ("is this right?", "are you sure?", "the numbers don't match", "wasn't it X before?", "double check this") and before a result goes into a report, a paper or a commit message. A checker agent re-reads or recomputes each claim and cites file:line for every objection; a hook confirms each quote is in the file. SKIP for judging whether work is good enough or what to cut (use reviewers) and for code review.
---

# Checker

Re-reading your own message is a poor check, because you read the claim the way you wrote it. In our
lab's replay of 146 corrections a user made to an agent's claims, a checker given the project's notes
caught 18 % of them, a checker without the notes 5 %, and the agent re-reading its own message 6 %. The
largest gain was on earlier results the claim had ignored, so always give the checker the notes.

## 1. Write the artifact

Put the claims under doubt in a file, e.g. `/tmp/check-<topic>.md`, or point at the file they already
live in. Each claim verbatim, one per line, with where it came from (results file, output file, job
log). Do not add an argument for them.

## 2. Dispatch one checker agent

`subagent_type: "checker"` (in a plugin install it may show as `checker:checker`). The brief:

```
artifact: /tmp/check-<topic>.md
sources: <output dirs, logs, scripts, the results or notes files the claims came from>
doubt: <what the user doubted, in their words>
```

The hook refuses a checker dispatch without an `artifact:` line naming an existing file. Use two
checkers only when the claims span two projects or datasets.

## 3. Read what comes back

The checker returns JSON: per claim a call (ok / wrong / stale / unsupported / overclaim /
missed_prior), one line why, and evidence as `{path, line, quote}`. The plugin's hooks check every
quote against the file: the checker is sent back once to fix a quote that is not there, and the
result you get carries a marker per objection (✓ quote in file, ~ found at another line, ✗ not in
file). An objection marked ✗ or with no evidence is a lead, not an answer. Open the cited line before
you adopt an objection. Where two notes disagree, the newer wins unless it says otherwise.

## 4. Answer

First line: holds / wrong / stale / unsupported, with the right value or the source in plain words.
Wrong or stale: say what changes and fix the file the claim came from. Holds: one line why.

## Don't

- Answer "is this right?" by re-reading your own message.
- Hand the checker your conclusion instead of the sources.
