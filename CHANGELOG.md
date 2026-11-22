# Changelog

## 0.1.0 (unreleased)

- Fixes tool calls local models send in another agent's format: `edits` lists, other argument names, garbled edit keys, bad optional values.
- Corrects mistyped paths in `read`, `edit`, `write`, `glob` and `grep` when exactly one existing path fits, and a misspelled project folder as shell `workdir`.
- Never changes paths inside shell commands, never moves a `write` into a lookalike folder, and never redirects a `write` onto an existing file.
