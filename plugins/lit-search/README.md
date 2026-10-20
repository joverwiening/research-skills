# lit-search

Literature search for Claude Code. It queries OpenAlex and arXiv with several phrasings, follows the
references and citers of the best hits, and ranks the results against your question. A small model then
reads the top papers in full and returns verbatim quotes, and code checks each quote against the paper
text. Measurements are in the [repository README](https://github.com/joverwiening/research-skills).

## Requirements

Node 20 or later, `pdftotext` (poppler), and a free OpenAlex API key in `OPENALEX_API_KEY`, set in the
environment or in a `.env` file in the working directory. No npm install.

## What it runs and sends

The skill has Claude run the Node scripts in `scripts/`. There are no hooks. The scripts send search
terms, paper identifiers and paper text to these services:

- Search: OpenAlex, arXiv, Crossref, and with a key Semantic Scholar (`SEMANTIC_SCHOLAR_API_KEY`) and
  alphaXiv (`ALPHAXIV_API_KEY`).
- Full text: arXiv and ar5iv, Unpaywall (only with `LIT_SEARCH_EMAIL`), Europe PMC, PubMed Central,
  bioRxiv, eLife, OSF, Zenodo, OpenReview, Springer Nature (only with `SPRINGER_OA_API_KEY`), and the
  publisher page a DOI resolves to.
- Ranking, only with `JEV_API_KEY`: the Jev API at api.typesafe.ai receives the question, the project
  context you pass, and each candidate's title and abstract.
- Reading: the paper texts and the question go to Claude, through `claude -p` on your plan by default or
  the Anthropic API with `ANTHROPIC_API_KEY`.

Results go to `litfind/` and `readswarm/` in the working directory, downloaded papers to a cache in the
system temp folder.

MIT license.
