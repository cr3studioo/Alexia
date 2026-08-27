# Skills — Alexia's agentskills.io profile

> **Plugins add capability. Skills add know-how.** A plugin gives Alexia a new thing it can
> *do*; a skill teaches it to do something it could already do, well. A skill is a folder
> with a Markdown file in it. No process, no code, no install step that can fail.
>
> Alexia uses **[agentskills.io](https://agentskills.io)**'s `SKILL.md` format unchanged
> rather than inventing one, which means the marketplace starts non-empty and a skill
> written for Alexia works in Hermes and anything else that adopted the standard.
>
> Spec read 2026-08-27; the details below are that reading. Companions:
> [`manifest.md`](./manifest.md) · [`capabilities.md`](./capabilities.md)

---

## The shape

```
dictating-well/
  SKILL.md              ← required; frontmatter must start at byte 0
  references/
    punctuation.md      ← loaded only when the body says to read it
```

```markdown
---
name: dictating-well
description: How to punctuate and format dictated speech. Use when the user is
  speaking rather than typing, or when text arrives from voice.transcribe.
license: Apache-2.0
---

Dictated text arrives without punctuation and with filler words…
```

| Field | Required | Rule |
|---|---|---|
| `name` | ✅ | ≤ 64 chars, lowercase and hyphens, **must match the folder name** |
| `description` | ✅ | ≤ 1024 chars, and it must say **what** and **when** |
| `license` | — | SPDX |
| `compatibility` | — | which runtimes it was written for |
| `metadata` | — | free-form |
| `allowed-tools` | — | experimental upstream; see below |

The `name`-matches-folder rule is the same rule as a plugin's `id`. One rule, learned once,
enforced in both places.

**`description` is the whole of the skill's discoverability.** It is the ~100 tokens that sit
in the model's context permanently, and it is the only thing the model sees when deciding
whether to open the skill at all. A description that says what the skill is and not when to
reach for it produces a skill that never fires. *"How to punctuate dictated speech"* is half
a description; *"…Use when the user is speaking rather than typing"* is the other half.

---

## Progressive disclosure — the reason this format was worth adopting

Three levels, and they are why a hundred installed skills do not cost a hundred skills'
worth of context:

| Level | When it loads | Roughly |
|---|---|---|
| `name` + `description` | always, for every installed skill | ~100 tokens each |
| the body of `SKILL.md` | when the model decides the skill applies | a few hundred to a few thousand |
| files under `references/` | only when the body tells the model to read one | unbounded, and free until used |

So a skill is cheap to have and expensive only to use. Write the body assuming it is being
read for the first time by someone who has already decided to read it, and push anything
long — a table of cases, a full example, an API's field list — into `references/`.

---

## What Alexia supports, and what it ignores

| | |
|---|---|
| **Supported** | `name`, `description`, `license`, `compatibility`, `metadata`, all three disclosure levels, `references/` of any depth |
| **Ignored** | `allowed-tools`, and every unknown key |
| **Not supported** | executable content of any kind. A skill is text. |

Unknown keys being ignored is the spec's own rule and it is what keeps skills portable: a
skill carrying a field some other runtime uses still works here, unchanged.

**`allowed-tools` is ignored deliberately, not by omission.** It is experimental upstream,
and more to the point Alexia already decides what a step may touch — permission mode, the
folder scope, the never-touch list, the safety checker. A field in a text file that a user
downloaded from a marketplace is not going to be added to that list. If it stabilises
upstream and means something Alexia's own rails do not already cover, that is a decision to
revisit with a reason written down.

Frontmatter **must start at byte 0** — no blank line, no BOM before it. Alexia parses with
`gray-matter`, which gets the edge cases right; a file that fails to parse is shown in the
skills list as broken, with the parse error, rather than silently skipped.

---

## Where skills come from

Three routes, one format, and the difference matters only at install and purge.

### Bundled with a plugin

Declared in the manifest, relative to the plugin folder:

```jsonc
"skills": ["skills/dictating-well"]
```

They arrive with the plugin, are enabled with it, and **are deleted with it**. A voice plugin
that teaches Alexia how to handle dictated text is the natural case, and it means the
know-how and the capability are never out of step.

Paths stay inside the plugin folder — no absolute paths, no `..`. The manifest schema rejects
both.

### Installed from the skills marketplace

The user's own skills directory, independent of any plugin. Installed, updated and removed
on their own.

**Two marketplaces, not one, and this is the reason:** a plugin is code that runs on your
machine and a skill is text that cannot execute. Different risk, different review bar. A
skill submission is checked for prompt-injection and for claiming to be something it is not;
a plugin submission is read.

### Learned

Alexia writes one. After a task the model judges was non-trivial and worth repeating, it
offers to distil the step trace into a skill — in the same format, in the same directory,
indistinguishable afterwards from one a person wrote.

**A learned skill announces itself when it fires**, with *edit* and *forget* inline. That is
not a nicety: a skill learned from a task that went subtly wrong will keep going subtly
wrong, silently, until someone sees it happen. Catching it at the moment it matters is the
only mechanism that works.

---

## The invariant holds here for free

Nothing in core names a skill, and nothing in a skill names a plugin — a skill refers to
**capabilities** (`voice.transcribe`), the same way a plugin does. So a skill whose plugin
was deleted degrades into advice about something Alexia cannot currently do, which is
harmless, rather than a dangling reference.

Deleting a skill folder removes the skill. There is no registry row, no database entry and
no cached index to fall out of step, because there is nothing to cache: `name` and
`description` are re-read from disk at start.

---

## Validating one

Upstream ships `skills-ref validate`. Alexia's own loader (M2-2) applies the same rules and
reports the same failures in the skills list. A skill that fails validation is shown as
broken with the reason; it is never silently ignored, because a skill that is not firing and
not visibly broken is the hardest thing in this system to debug.
