---
name: writing-rules
description: Rules for drafting or revising prose a reader judges: papers, abstracts, grant text, essays, long posts, docs for a published repo. Reader first, structure, sentence tests, a ban list of persuasion and AI-tell words, and a lint script. Also for "does this read as AI". SKIP for chat, code comments, commit messages and scratch notes.
---

# Writing rules

The failure this prevents: prose that is fluent, organized and correct, and still reads as machine-written
at once. Fluency is not the target. The target is text the intended reader gets through without noticing
the writing at all.

Most register failures are decided before the first sentence exists, so work top to bottom. The sources
and reasoning behind each rule are in `reference.md` in this skill.

## Do first

1. **Name the reader.** Twenty specific people who would argue with the piece. For a paper, the referees.
   For a philosophy essay, the people who hold the view it attacks. For a pop essay, the readers of the
   outlet it is meant for. Write for them, not for "readers".
2. **Find the tension.** What do those readers believe that this piece breaks? Which question can they
   not answer yet? If the draft has no tension, it has no reader. No sentence edit fixes that; it is a
   content problem.
3. **Outline before prose.** The claims (plus figures and key examples) in order of importance, one
   sentence each. Every section opens with its claim, not with its setup.
4. **One message per piece.** If the opening paragraph crowds in several contributions, the piece has
   not decided what it is.
5. Before handing text over, run the mechanical pass (section 5).

If the piece has its own settings (section 7), they override this file.

## 1. Structure

- **Story shape (OCAR): Opening, Challenge, Action, Resolution.** The opening sets the scale of the whole
  piece, so it states the broad question. A concrete scene is fine for an essay, as long as the next
  paragraph says what question it stands for. The challenge is the gap or tension, and the reader must be
  able to state it after the introduction. The resolution answers the challenge as posed, in the words it
  was posed in.
- **The funnel.** Every paragraph between opening and challenge narrows.
- **Paragraphs: context, content, conclusion.** The first sentence sets the topic, the body carries what
  is new, the last sentence states what is to be remembered.
- **No zig-zag.** Each subject appears in exactly one place. Only the central idea recurs. Parallel points
  take parallel grammatical form.
- **Pick the move deliberately:** counter a claim, point at a gap, raise a question, or continue a
  tradition. Claiming a gap when the honest move is "continue a tradition" forces advocacy, and advocacy
  reads as marketing.
- **Arguments (philosophy, opinion):** state the thesis early. Give the strongest objection in its
  strongest form, and answer that form.
- **The skim test.** The section titles plus the first sentence of each section, read alone, must carry
  the whole argument. For an essay without headings, use the first sentence of each paragraph.

## 2. Sentences: five tests, run on each one

These are principles, not rules (Gopen & Swan). A deliberate violation at a moment that deserves weight is
craft. An accidental one every third sentence is the defect.

1. **Subject next to verb.** Anything long between them reads as an interruption.
2. **Stress position.** The end of the sentence carries the emphasis, so the new information goes there.
   If a sentence has more colons, semicolons and clause breaks than it can stress, it is two sentences.
3. **Topic position.** The sentence is read as a story about whatever shows up first. If that is not
   what the sentence is about, rewrite it.
4. **Old before new.** Open on what the reader already has, close on what is new. Breaking this is what
   makes a paragraph read as a list of true statements instead of an argument.
5. **Action in the verb.** No nominalization hung off "provides", "exhibits", "is characterized by".
   "A need exists for greater selection efficiency" becomes "we must select more efficiently".

## 3. Defects, delete on sight

- **Narrated reasoning.** Classic style: the writer knows the point before writing it down. Prose that
  sorts out what it thinks as it goes is a draft.
- **Curse of knowledge.** Every term the reader has not been given is an instance of it.
- **Metadiscourse.** "In this section we will first discuss" helps the writer, not the reader. Cut it, or
  replace it with the question the section answers.
- **Writing about the field instead of the world.** Writing about the state of the debate or of research
  activity instead of about the thing itself.
- **Apologizing.** Prefacing a claim with how hard and contested the topic is.
- **Hedging as a tic.** One hedge at the honest strength. Never a bare claim followed by a clause that
  takes it back.
- **Zombie nouns and metaconcepts.** "level", "issue", "framework", "approach", "perspective" where the
  concrete thing belongs.

## 4. Words and constructions

**The rule.** Cut any word whose job is to tell the reader how to feel about a point instead of stating
it. If deleting the word changes no fact, it was persuasion. If the point is remarkable, the reader needs
no prompting.

**Words that actually show up.** novel, crucial, key (as an adjective), powerful, robust (unless
robustness was shown), significant (unless a test is stated), leverage, underscore, shed light on, pave
the way, it is worth noting, delve, showcase. Persuasion adverbs: remarkably, interestingly,
surprisingly, notably, importantly, strikingly, crucially.

**The full ban list** (what `lint.py` checks):

- *hype:* delve, tapestry, realm, testament, underscore(s/d), leverage, unlock, unleash, seamless,
  cutting-edge, game-changing, revolutionize, paradigm shift, deep dive, ever-evolving, treasure trove,
  a beacon, stands as, the beauty of, shed light on, pave the way, showcase, crucial
- *adverbs:* remarkably, interestingly, surprisingly, notably, importantly, strikingly, crucially
- *engineer register:* footgun, moat, happy path, escape hatch, guardrail, dogfood, greenfield, bikeshed,
  yak shaving, sanity check, edge case, toolchain, tooling, iterate on, blocker, pain point, load-bearing,
  handoff
- *filler:* not just, "is a feature, not", worth noting, the key is, what matters is, in conclusion, in
  summary, "ultimately,"
- *announced point:* "the difference / reason / point / answer / upshot / key / trick / surprise is
  whether / that / what / how / why". Say the thing instead of announcing that a thing is coming.
- *abstract agent:* "the literature / data / analysis / study / section argues / reveals / tells / warns".
  Name who argues it or what was measured.
- *credentials:* byte-for-byte, fail-closed, pre-committed, frozen protocol, "declared, not", "did its
  job"
- *self-ranking:* "the sharpest / strongest / cleanest X"
- *priority* (flag when it appears twice or more): to our knowledge, proof of principle, for the first
  time

A hit is a question, not a verdict. "Robust" with a robustness test behind it stays. A quoted source
keeps its own words.

**Banned constructions.**
- "Not just X but Y" and its variants.
- Three-item lists used for cadence, when there are not exactly three things.
- Short dramatic sentences used as beats.
- Present-participle chains ("reaching X, revealing Y, suggesting Z").
- Rhetorical questions, and any address to the reader. An essay may ask one real question that it then
  answers.

**One point per sentence.** If a sentence joins two claims or two results with "and", split it.

**Report actions and observations, not stances.** "We train X and measure Y", never "we demonstrate the
power of X". In an essay: say what the person did or what the argument shows, not how significant it is.

**Em dashes.** Decide once per piece whether they are allowed. If not, the ban covers every form (—,
`---`, `--` between clauses; a numeric range like 3--5 is fine). Replace with a full stop (usually
right), a comma, a colon before a definition or list, or parentheses. If none fit, the sentence carries
two thoughts and becomes two sentences. Run that last test even when dashes are allowed: a dash often
marks a sentence that was never resolved.

**Terms.**
- Do not coin a term unless the piece is about the new distinction. Then define it once and keep that
  name.
- Do not borrow a term that carries someone else's argument, model or derivation unless you mean all of
  it. When the nearest established term almost fits, describe the thing instead.
- Use the word the field (or the audience) uses, even when it is clumsier.
- One name per object, everywhere: headings, captions, labels.

**Essays.** First person, humor and a recognisable voice are fine, and an essay can carry more
voice than a paper. What stays out is the persuasion: the words that tell the reader how to feel.

## 5. Mechanical pass before the text leaves your hands

Run it even when the text reads clean. It is a checklist, not a judgement.

1. Run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/lint.py" <draft.md|draft.tex|draft.txt>`. Add
   `--no-dashes` when the piece bans em dashes. The plugin also runs it after every write to a `.tex`
   or `.md` file and shows you the hits; fix them or say why a hit stays (a quoted term, a word used
   in its literal sense).
2. Search for the words above that the lint does not enforce (novel, powerful, key, robust,
   significant) and judge each hit.
3. Count colons and semicolons per sentence (the lint flags two or more). More than one competing stress
   position means two sentences.
4. Count words against the venue (section 6), not against a feeling.
5. Check that each object has one name throughout.
6. Check every number, date, quote and attribution against its source. Style does not excuse a wrong
   fact.
7. Pull out the section titles (or paragraph openers) with each first sentence and read only that list.
   It must state the argument without the body. Hand that list over with the draft.

## 6. Calibrating to a venue

Templates are only a prior. Collect six to ten recent pieces from the target journal, magazine or blog.
Per piece, count total words (or abstract words for a paper), numbers quoted up front, and whether the
first sentence states a method, a scene or a claim. Those medians are the spec. Count them yourself from
the actual texts; do not estimate.

## 7. Per-piece settings

A piece (or a Project's notes) can set: the reader, the venue and its measured medians, em dashes yes or
no, banned and required terms, standing instructions from the author. These override this file wherever
they disagree.

## 8. Revision: three passes, largest first

Never revise sentences before the structure is settled, because most of those sentences will be deleted.

1. **Structure.** Does each section answer the challenge it was set? Is there exactly one message? Does
   the resolution use the challenge's words? Fixes here are moves and deletions.
2. **Paragraphs.** Context, content, conclusion in every paragraph? Does old information lead?
3. **Sentences.** The five tests (section 2), then the word list (section 4).

Between passes 1 and 2, read only the figures, captions, and the first and last sentence of each section.
If the argument does not survive that reading, the problem is structural.

Before calling a draft done, review it with the `reviewers` plugin from this marketplace if it is
installed.

---
Ban list adapted in part from BootLoops prose-lint by Matthew D. Schwartz (CC BY 4.0).
