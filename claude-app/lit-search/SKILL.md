---
name: lit-search
description: Literature search with web search — "what's known about X", "find papers on", "lit review", "is this new", "citations for". Several phrasings per question, citation chasing from the best hits, and no paper cited without a passage read in it. SKIP for quick web facts.
---

# Literature search

This is the light version, for the Claude app. It has no ranking script and no full-text reading swarm,
only the method. The Claude Code plugin of the same name adds both.

## 1. Scope

- Split the question into 1-5 sub-questions. Tell the user the sub-questions before a long search.
- A novelty check ("is this new", a "first" in a draft): write each claim down word for word, search to
  kill it, and return per claim: survives as worded / falsified (quote the paper) / survives only
  reworded (give the wording).

## 2. Search

- Per sub-question, 4-8 different phrasings. Different communities name the same thing differently
  (a physicist's "order parameter" is a neuroscientist's "population statistic"); search each name.
- Search the paper databases, not only the open web: Google Scholar, Semantic Scholar, OpenAlex, arXiv,
  PubMed, PhilPapers for philosophy.
- Take the 3-5 papers most on target and chase them: what they cite (their related-work section), and
  who cites them (newest first).
- Stop when each sub-question has ≥ 2 independent sources and new searches return papers you have
  already seen.

## 3. Read before citing

- Open the full text where it is free (arXiv, PubMed Central, the author's page, a repository copy).
- A paper counts as read only if you read a passage in it that answers the question. Abstract only →
  list it as "abstract only", never as support.
- Every cited claim carries a verbatim quote from the paper and where it is (section or page).
- Never write a DOI, arXiv id, author list or year you did not see on the paper's own page.

## 4. Write it up

The answer first, then the key sources, each with its quote and identifier. Label observation vs
interpretation. Name contradictions; say which paper is the original and which restate it. Keep each
source's own hedge: "consistent with" is not "shows".
