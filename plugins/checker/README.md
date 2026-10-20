# checker

A Claude Code plugin that checks claims, numbers and captions against the files they came from. The
skill writes the claims to a file and hands it to a checker agent, which reads the sources and the
project's notes. The agent marks each claim ok, wrong, stale, unsupported, overclaim or missed (an
earlier result contradicts it), and every objection has to quote a file and line.

In a replay of 146 corrections a researcher had made to our agent, the checker with notes caught 18 %
and the agent re-reading its own message 6 %. Most errors still get through.

## Hooks

`hooks/review-hooks.mjs` runs with Node around the checker agent:

- before a dispatch, it refuses a brief that names no existing file (at most twice per session);
- when the agent finishes, it asks once more if the answer is not the expected JSON or a quote is not
  at the cited line;
- after it returns, it tells the main agent which objections were found in the files.

The hooks read local files, keep a small counter in the system temp folder, and send nothing over the
network.

MIT license.
