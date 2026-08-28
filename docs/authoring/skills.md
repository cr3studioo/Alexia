# Shipping know-how alongside capability

A **plugin** gives Alexia a new thing it can *do*. A **skill** teaches it to do something it
could already do, *well*. They are different products and they are kept visibly apart.

A skill is a folder with a `SKILL.md` in it. No process, no code, nothing that can fail at
install time. The format is [agentskills.io](https://agentskills.io)'s, unchanged, so a
skill written here works elsewhere.

## Bundling one with your plugin

```jsonc
"skills": ["skills/dictating-well"]
```

Paths are relative to your folder. They install with you, they are read from your folder,
and **they are deleted with you**. A skill bundled with a plugin nobody has enabled is
know-how about something Alexia cannot currently do — it arrives with you and it waits with
you.

## `SKILL.md`

```markdown
---
name: dictating-well
description: How to get clean text out of dictation — when to ask for a re-read, how to
  handle names, and what to do about punctuation nobody said out loud. Use when the user
  is dictating rather than typing.
license: Apache-2.0
---

The body. Whatever a model needs to do this well.
```

Rules that are checked, and the reasons:

- **The frontmatter starts at byte 0.** A blank line or a byte-order mark before the `---`
  is a file most parsers read as having no frontmatter at all, which makes the skill
  silently descriptionless rather than visibly broken.
- **`name` must equal the folder name**, lowercase and hyphen-separated. Same rule as a
  plugin `id`.
- **`description` says what and when**, under 1024 characters. Without a "when", the model
  never opens it, and a skill that never fires looks exactly like one that was never
  installed.

## Why the format was worth adopting

Progressive disclosure:

| Level | Where it lives | What it costs |
|---|---|---|
| `name` + `description` | always in the model's context | about 100 tokens |
| the body of `SKILL.md` | returned when the model opens the skill | a few hundred up |
| any other file in the folder | returned only when the model asks for it by name | nothing until asked |

A hundred installed skills cost a hundred sentences, not a hundred skills.

Everything else in the frontmatter — `compatibility`, `allowed-tools`, whatever another
runtime left there — is ignored on purpose. `allowed-tools` in particular: what a step may
touch is decided by the permission mode, the folder scope and the never-touch list, and a
field in a text file somebody downloaded is not joining that list.
