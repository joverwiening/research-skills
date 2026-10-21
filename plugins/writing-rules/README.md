# writing-rules

A Claude Code plugin with rules for papers, abstracts, grant text and essays. The skill sets the order of
work (readers, open question, outline, then sentences), gives five sentence tests after Gopen and Swan,
and lists words that tell the reader how to feel instead of stating a fact, such as "remarkably",
"crucial" and "delve".

## Hook

After each Write or Edit of a `.tex` or `.md` file, and after a shell command that names one and changes it,
`hooks/lint-hook.mjs` (Node) runs `scripts/lint.py` on that file with Python 3 and shows the hits to Claude.
It reads only the edited file and sends nothing over the network. Set `WRITING_RULES_LINT=0` to turn it off.

Part of the ban list comes from BootLoops prose-lint by Matthew D. Schwartz (CC BY 4.0). MIT license.
