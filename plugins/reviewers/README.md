# reviewers

A Claude Code plugin for referee-style review of research in progress or a finished draft. Two or three
reviewer agents with different angles read the raw material. Each one first says what story the results
tell now and what is missing, then gives every item one verdict: main, fix, develop, supporting, dead
end, cut (drafts only) or stop (planned work only). Results with thin evidence get "develop" and what
they need. Cuts wait for your approval.

## Hooks

`hooks/review-hooks.mjs` runs with Node around the reviewer agents:

- before a dispatch, it refuses a brief that names no existing file (at most twice per session);
- when an agent finishes, it asks once more if the answer is not the expected JSON or a quote is not at
  the cited line;
- after it returns, it tells the main agent which quotes were found in the files.

The hooks read local files, keep a small counter in the system temp folder, and send nothing over the
network.

MIT license.
