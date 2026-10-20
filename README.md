# research-skills

Four skills for doing research with Claude: literature search, writing rules, referee review and claim
checking. Each comes as a Claude Code plugin (skill, agents, hooks and scripts) and as a plain skill file
for the Claude app.

They come out of the harness we run for a research agent in a computational neuroscience lab. These four
are the ones we use most; the literature search is the one with a measured gain.

| skill | what it does | the Claude Code plugin adds |
|---|---|---|
| `lit-search` | searches with many phrasings, follows citations, cites only what was read | search and ranking script, a full-text reading swarm, quote checks in code |
| `writing-rules` | reader first, structure, sentence tests, a ban list of persuasion and AI-tell words | a lint that runs after every `.tex` / `.md` write |
| `reviewers` | referee review in two stages; tells the story the work could tell, a verdict on every item | a reviewer agent; hooks refuse a review with no file to review and check every quote it cites |
| `checker` | checks claims and numbers against the raw sources, file:line for every objection | a checker agent; the same two hooks |

## Install

Claude Code:

```
/plugin marketplace add <owner>/research-skills
/plugin install lit-search@research-skills
/plugin install writing-rules@research-skills
/plugin install reviewers@research-skills
/plugin install checker@research-skills
```

Claude app: zip a folder from `claude-app/` (`cd claude-app && zip -r checker.zip checker`) and upload it
as a custom skill in the app's settings. Skills load when the request matches their description; naming
the skill in your request, or in a Project's instructions ("use writing-rules when drafting prose"), makes
that reliable.

## lit-search

On 10 of our own research questions, with the 92 papers our earlier searches had cited as targets, the
top 30 of this search held 32 of them, against 22 for our previous agent-run search. Following references
and citers matters more further down the list: on 7 published reviews, with their 1204 references as
targets, one hop of citation chasing raised the hits in the top 100 from 95 to 116.

`litfind.mjs` queries OpenAlex (keyword and semantic search) and arXiv with every phrasing, ranks the
candidates by word overlap with the question and its context, and follows references and citers of the
best ones. `readswarm.mjs` fetches the open-access full text of the top papers and sends a few per call to
a small model (`claude -p --model haiku` by default, or the API), which returns a verdict and verbatim
quotes per paper; code checks every quote against the text. `getpaper.mjs` resolves a DOI, arXiv id or URL
to a text file through the open-access copies.

Needs Node ≥ 20, `pdftotext` (poppler) and a free OpenAlex API key (`OPENALEX_API_KEY`). No npm install.
Optional keys are listed in the skill file. The Claude app version is the method only, using the app's
web search.

## writing-rules

The rules start before the first sentence: name the readers, find the tension, outline the claims, then
write. Then five tests per sentence and a ban list of words that persuade rather than report
("remarkably", "crucial", "underscore", "delve" and the rest). `lint.py` checks the list, skipping code, math,
URLs and quoted text. Works for papers, grant text, essays and long posts; essays keep first person and a
voice.

## reviewers

A reviewer reads the items together first and says what story they tell now, the best story the
existing results could tell, and the missing link. Then every item gets one verdict: main, fix, develop,
supporting, dead end, cut (final drafts only) or stop (planned work only), with what would change it.
Under-evidenced work is "develop", never "cut": an earlier version without that rule cut one of our
figures from 7 panels to 3, promising results included. Two stages: direction for work in progress,
final for a draft at a venue. Run 2-3 reviewers with different angles (story editor, skeptic, referee,
a PI reading fast).

## checker

In a replay of 146 corrections a researcher made to an agent's claims, a checker that was given the
project's notes caught 18 % of them. The agent re-reading its own message caught 6 %, and a checker
without the notes 5 %. Most misses were real numbers from the wrong run or setup.

The checker calls each claim ok, wrong, stale, unsupported, overclaim, or missed (an earlier result
contradicts it), and every objection cites `{path, line, quote}`. "ok" is a valid answer: an objection
that turns out wrong costs more than a missed one.

## Why the hooks

The hooks do the mechanical part in code instead of asking the model to remember it: is there a file to
review, is each cited quote really at that line, what does the lint flag. A checker or reviewer whose
quote is not in the file is sent back once to fix it, and the result you see marks every objection as
found, found at another line, or not found.

## Credits

The word list in `writing-rules` is adapted in part from BootLoops prose-lint by Matthew D. Schwartz
(CC BY 4.0).

## License

MIT
