---
name: lit-search
description: Literature search on real paper databases with full-text reading. Use for "what's known about X", "find papers on", "lit review", "literature on", "who works on", "is this new", "citations for". Searches OpenAlex and arXiv with several phrasings, follows references and citers of the best hits, then many cheap model calls read the full text of the top papers and return verbatim quotes that code checks against the text. SKIP for one known paper (fetch it directly) and for quick web facts.
---

# Literature search

You plan, search and write up. A script does the search, a swarm of cheap model calls reads the top
papers' full text, and code checks every quote. You never cite a paper you have only seen the abstract of.

Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/`. Node ≥ 20, no install; `pdftotext` (poppler) for PDFs. Needs
`OPENALEX_API_KEY` (free at openalex.org) in the environment or in a `.env` in the working directory.
Optional: `LIT_SEARCH_EMAIL` (lets the fetcher ask Unpaywall for open copies), `SEMANTIC_SCHOLAR_API_KEY`,
`ALPHAXIV_API_KEY`, `JEV_API_KEY` (a hosted relevance classifier; without it ranking is by word overlap).

## 1. Scope

- One paper or fact → no search loop: fetch it (step 4) or use web search.
- One focused question → 1-2 sub-questions, one round.
- "What's known about X" (default) → 3-5 sub-questions, up to two rounds.
- A novelty check ("is this new", a "first" in a draft): write each claim down word for word before
  searching, search to kill it, and return per claim: survives as worded / falsified (quote the paper)
  / survives only reworded (give the wording).

Tell the user the sub-questions before a long search unless they already scoped it.

## 2. Search each sub-question (Bash timeout 300000, 1-3 min)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/litfind.mjs" --q "<sub-question>" \
  --ctx "<3-4 lines: the project, what you already have, why you are searching>" \
  --kw "<keywords>" --kw "<another phrasing>" ... (4-8 different phrasings) \
  --para "<the question in other words>" [--seed <doi | arXiv id of a paper known to be on target>] \
  [--from YEAR] [--exclude <file listing papers you already have>]
```

It runs keyword and semantic search on OpenAlex plus arXiv, ranks every candidate, follows references
and citers of the best ones, prints the ranked list and writes everything (abstracts, scores, where each
paper came from) to `litfind/<date>-<slug>.json`.

- The `--ctx` lines matter: ranking is worse without them.
- Several `--kw` phrasings matter more than a long `--q`. Different communities name the same thing
  differently; search each name.
- "weak seeds" in the output means few hits were on target: rephrase and rerun, don't read the list.

## 3. Read the top papers (Bash timeout 600000, a few minutes)

One run per sub-question; start them together as background commands:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/readswarm.mjs" --q "<sub-question>" --ctx "<same ctx lines>" \
  --in litfind/<file>.json --top 40
```

It fetches the open-access full text of each paper, sends a few papers per call to a small model
(`claude -p --model haiku` by default, so it draws on your Claude plan; `--backend api` uses
`ANTHROPIC_API_KEY`), and gets back per paper a verdict (answers / partly / background / no), a
one-line claim and up to 3 verbatim quotes. Code then checks every quote against the paper text.
Read `readswarm/<date>-<slug>/digest.md`.

- An exact quote can be cited. A `[fuzzy match]` quote gets looked up in the text first.
- The model's one-line claims are leads: check a claim you will rely on against its quotes.
- Only full text is read. Papers with abstract only (paywall, bot wall, short text) are listed under
  "not read in full" and never count as read.

## 4. Go deeper where the swarm could not

For a paper a claim rests on, its methods or results in depth, or one listed as not read:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/getpaper.mjs" <doi | arXiv id | url>
```

It tries the open-access copies in turn (arXiv, Europe PMC, PubMed Central, publisher open access,
Unpaywall repository copies) and prints JSON with `text_path`, a greppable text file. Grep it for the
passage; don't paste whole papers into context.

## 5. Second round, only for the gaps

Rerun litfind with the best papers as `--seed` (it follows their references and citers), or search the
named gap with new phrasings. Stop when each sub-question has ≥ 2 independent sources and new searches
return papers you have already seen.

## 6. Write it up

The answer first, then the key sources, each with a verbatim quote and its DOI or arXiv id. Label
observation vs interpretation. Name contradictions; say which paper is the original and which restate
it. Keep each source's own hedge: "consistent with" is not "shows". Never write a DOI you did not get
from the search output or the paper itself.
