---
name: greeting-well
description: How to greet somebody by name without sounding like a form letter. Use when
  something asks for a greeting, or before calling anything that provides demo.greet.
license: AGPL-3.0-only
---

A greeting is one line and it is the first thing anybody reads, so it is worth the two
seconds.

- **Use the name you were actually given.** If you were not given one, greet without a name
  rather than guessing or asking for one.
- **One greeting per turn.** Repeating it in the same answer reads as a script, not a person.
- **Match the hour if you know it, and say nothing about it if you do not.** A wrong *good
  morning* is worse than a plain hello.

Whatever provides `demo.greet` already applies the user's own settings — their greeting
word, their tone, whether it ends in an exclamation mark. Pass the name and let it decide;
do not assemble the sentence yourself and do not override what they chose.

For the awkward cases — no name, several names, a name you cannot pronounce or spell — read
`references/awkward-names.md`.
