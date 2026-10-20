# research-skills

Four skills for research work with Claude Code and the Claude app: literature search, a claim checker,
referee review and writing rules. They come from the harness that runs our research agent in a
computational neuroscience lab, where we use them every day. Each one exists because the agent kept
making the same mistake.

## Install

Claude Code:

```
/plugin marketplace add joverwiening/research-skills
/plugin install lit-search@research-skills
```

The other three install the same way: `checker`, `reviewers`, `writing-rules`. Each plugin brings its
skill plus the scripts, hooks and agent it uses.

Claude app: download a zip from [`claude-app/zips/`](claude-app/zips/), then go to Customize > Skills,
click "+", "Create skill", "Upload a skill". Skills need "Code execution and file creation" on under
Settings > Capabilities. A skill loads when your request matches its description. Naming it in the request,
or in a Project's instructions ("use writing-rules when drafting prose"), makes that reliable.

## The problems

### 1. The agent cites papers it has not read

Asked what is known about a topic, an agent searches once in its own words, finds the papers that share
those words, and cites from abstracts.

**lit-search** searches OpenAlex and arXiv with several phrasings, follows the references and citers of
the best hits, and ranks the pool against the question. A small model then reads the full text of the top
papers, a few per call, and returns a verdict and verbatim quotes for each. Code checks every quote against
the paper text. The write-up cites only papers that were read in full.

On 10 of our own research questions, with the 92 papers our earlier searches had cited as targets, the top
30 of this search held 32 of them, against 22 for our previous agent-run search. Those targets came from an
earlier keyword search, which favours this ranking. On 7 published reviews, with their 1204 references as
targets, one hop of citation chasing raised the hits in the top 100 from 95 to 116.

### 2. Its claims are wrong in ways it cannot see

An agent that re-reads its own message catches few of its errors. Many of them can only be seen from
outside the message: an earlier result that says otherwise, or the file the number came from.

**checker** hands the claim to a separate agent that reads the files the claim rests on and the project's
notes. It calls each claim ok, wrong, stale, unsupported, overclaim, or missed (an earlier result
contradicts it). Every objection must quote a file and line. Hooks refuse a dispatch that names no file,
and code looks up every quote. An objection whose quote is not at that line goes back to the checker once,
then reaches you marked as not found.

We replayed 146 corrections a researcher made to our agent's claims. A checker given the project's notes
caught 18 % of them; its largest gain was on results the agent had forgotten. Without the notes it caught 5 %, and the agent
re-reading its own message 6 %. It still misses most errors: use it as a check before a claim leaves your
hands, not as proof that a claim is right.

### 3. Reviews that keep everything or cut everything

An earlier version of our reviewer could only keep or cut. Told to be strict, it cut one of our figures
from 7 panels to 3 overnight, promising results included.

**reviewers** runs 2 or 3 reviewer agents with different angles: a story editor, a skeptic, a referee, a PI
reading fast. Each first reads all items together and says what story they tell now, the best story the
existing results could tell, and the missing link. Then every item gets one verdict: main, fix, develop,
supporting, dead end, cut (final drafts only) or stop (planned work only), with what would change it.
Work with too little evidence gets "develop" and the data or proof it needs, never "cut". The stage is
either direction, for work in progress, or final, for a draft headed to a venue. Cuts stay proposals until
you accept them. The same hooks as the checker refuse a review with no file and check every quote.

### 4. Prose that reads as machine-written

Fluent, organized, correct, and recognizable as AI from the first line.

**writing-rules** starts before the first sentence: name the readers, find the tension, outline the claims,
then write. Then come five tests per sentence (after Gopen and Swan) and a ban list of words that tell the
reader how to feel instead of stating a fact: "remarkably", "crucial", "underscore", "delve" and the rest.
`lint.py` checks the list and skips code, math, URLs and quotes. The plugin runs it after every write to a
`.tex` or `.md` file. The rules cover papers, grant text, essays and long posts; essays keep first person
and a voice.

## How to tell it is working

- lit-search: the digest lists which papers were read in full and which only as abstracts, and flags any
  quote that matched the text only approximately.
- checker and reviewers: every objection arrives marked found, found at another line, or not found.
- writing-rules: lint hits appear after each write. Each hit is a question, not a verdict.
- reviewers: every item has a verdict, and each "develop" item names what it needs.

## Requirements and limits

- lit-search needs Node 20 or later, `pdftotext` (poppler) and a free OpenAlex API key
  (`OPENALEX_API_KEY`). No npm install. The reader runs `claude -p` with Haiku by default, so it uses your
  Claude plan; `--backend api` uses `ANTHROPIC_API_KEY` instead. Optional keys are listed in the skill.
- With `JEV_API_KEY` set, ranking uses Jev, a hosted relevance classifier. The numbers above are without it.
- Hooks run only in Claude Code. The Claude app versions carry the method alone: lit-search uses the app's
  web search, and `referee-review` is one referee in a fresh chat instead of parallel agents.
- Other agents that read `SKILL.md` files may load the skills. We have not tested them.

## Credits

The ban list in `writing-rules` is adapted in part from BootLoops prose-lint by Matthew D. Schwartz
(CC BY 4.0).

## License

MIT
