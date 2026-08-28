# The ten invariant checks

> **These are the project.** Alexia's code is written by AI under direction, which means
> nobody reads every line — and the thing that keeps the thesis true is therefore not
> discipline, review or good intentions. It is ten checks that run on every commit and go
> red when the thesis stops being true.
>
> They live in `packages/core/test/invariants/`, run in `pnpm check`, and run in CI on
> `windows-latest` and `ubuntu-latest` on every push and pull request.

---

## Running them

```bash
pnpm invariants                                     # all of them
pnpm vitest run --project invariants -t "no-hardcoded-paths"   # one of them
pnpm check                                          # lint, types, unit tests, then these
pnpm check:no-plugins                               # check 2, which `pnpm check` cannot run
```

Every check is named after its file, so the `-t` string is the same as the filename minus
the number. A red check is a **stop**, not a note-to-self.

---

## The ten

| # | Check | Defends | Lands |
|---|---|---|---|
| 1 | `core-names-no-plugin` | Rule 1 | ✅ M0 |
| 2 | `boots-with-no-plugins` | Rule 4 | ✅ M0 |
| 3 | `crasher-contained` | process isolation earning its memory | ✅ M0 |
| 4 | `vanisher-replans` | the invariant meeting the agent loop | ✅ M0 |
| 5 | `purge-leaves-no-residue` | the transition worth testing hardest | ✅ M0 |
| 6 | `no-node-apis-in-ui` | the Tauri port staying a port | ✅ P0-2 |
| 7 | `no-hardcoded-paths` | Windows first, portable by discipline | ✅ P0-2 |
| 8 | `no-overclaiming-strings` | the privacy promise being exactly true | ✅ P0-2 |
| 9 | `memory-budget` | risk 2 — isolation looking like a mistake | ✅ M0 |
| 10 | `rust-line-budget` | Rust you cannot debug at 3am | ✅ P0-2 |

6, 7, 8 and 10 landed at P0-2 **while they still passed trivially**, which is the only time
adding a rule is free. 1 to 5 landed across M0, each with the code it defends: 3 with
`plugins/crasher`, 4 with `plugins/vanisher`, 5 with the store. Checks 1 and 2 also have a
half that is not a test — a `dependency-cruiser` rule and a CI job — because neither could
be a test and still defend what it defends. Each one carries a test proving its pattern catches a real violation,
and one asserting the scanner is reading files at all — a glob that matches nothing passes
silently, forever, and looks exactly like a clean repo.

---

### 1 · `core-names-no-plugin`

**Defends rule 1: core may never know a plugin exists.** The single most important check in
the repo.

Two mechanisms, because neither alone is enough:

- **A grep** over `packages/core/src` for every directory name under `plugins/`, and for any
  import path containing `plugins/`. This catches the string `"voice"` in a switch statement,
  which no import graph would.
- **A `dependency-cruiser` rule** forbidding the edge `packages/core → plugins/`
  structurally. This catches the import the grep would miss because it was spelled with a
  variable.

If you are about to type a plugin's name inside `packages/core`, you have found a missing
capability, not a shortcut.

### 2 · `boots-with-no-plugins`

**Defends rule 4: core works with zero plugins installed.** A CI job that moves `plugins/`
aside and runs core's entire test suite.

A job, not an aspiration. The moment core needs a plugin to start, "delete the folder"
becomes "delete the folder and hope".

**The one check `pnpm check` cannot run**, because it runs with `plugins/` present — which is
the single condition this check exists to remove. `pnpm check:no-plugins` moves the folder
aside locally and puts it back whatever happens, and it exists because the CI job was **red
for two milestones** without anybody finding out (D76): four test files that use the repo's
own plugins as fixtures had never joined `needPlugins` in `vitest.config.ts`. An invariant
that can only be run somewhere you do not look is not a check. Run it before a commit that
adds a test which touches a plugin folder.

### 3 · `crasher-contained`

`plugins/crasher` dies three ways in turn — exits immediately, hangs without answering, and
leaks memory until it is killed. Core stays up through each, backs off between restarts, and
marks the plugin unhealthy after **three crashes in sixty seconds**, telling the user in one
line that names the plugin and says everything else is still running.

This is what process isolation is *for*. If a crashing plugin can take core with it, the
memory cost of a process per plugin is buying nothing.

### 4 · `vanisher-replans`

`plugins/vanisher`'s folder is deleted **mid-task**. The agent loop notices its tools are
gone, tells the model so, re-plans, and the task completes.

This is where the invariant and the agent loop meet, and it is the hardest of the ten to
make true. Alexia.md asks for it by name.

### 5 · `purge-leaves-no-residue`

Snapshot the database and the filesystem. Install → enable → use → delete. Diff.

**The diff must be empty.** Not "empty except the settings row", not "empty except an
orphaned table". The contract this proves is written out in [`storage.md`](./storage.md) as
a table, and this check is that table executed.

**And the secret half** (M1-3): the plugin's `password` setting is filled in during the run,
and the database file — with its write-ahead log beside it — is read back as raw bytes and
searched for the value. It is never in there, before the purge or after it. A column nobody
thought to look in is exactly how a secret in the clear would be missed, so the check looks
at all of them at once.

### 6 · `no-node-apis-in-ui`

`packages/ui` may not import a Node builtin — not `node:fs`, not bare `fs`, not
`node:fs/promises`. Everything it touches has to exist inside a webview.

A Node import in the UI is not a bug today. It is a rewrite scheduled for M5, and it will
arrive at the worst possible moment.

### 7 · `no-hardcoded-paths`

No `C:\`, no `/home/`, no `~/`, no `%APPDATA%`, and no path separator glued into a string by
hand. `join()` and `resolve()` exist so this never has to be written.

Windows is the target and Ubuntu runs in CI beside it, so a portability break shows up the
day it happens rather than at M5. Paths come from `alexia/host/info`, never from a literal.

### 8 · `no-overclaiming-strings`

Every user-facing string is scanned for *"nothing leaves your computer"*, *"never leaves"*,
*"completely private"*, *"no data is sent"*, *"stays on your device"* and their neighbours.

**Local mode means the model runs on this machine. It does not mean nothing left it** — if
you are in Local mode and talking over Telegram, your words crossed Telegram's servers
before any model saw them. One tooltip claiming otherwise breaks a promise the whole project
rests on, so the promise is a test rather than a habit.

Alexia.md asks for this check by name.

### 9 · `memory-budget`

Core stays under **150 MB** resident, and an **enabled-but-idle plugin runs no process at
all** — lazy spawn on first use, shutdown after idle.

Risk 2: if lazy spawn slips, a process per plugin starts looking like an architectural
mistake for reasons that are really an unimplemented optimisation, and the argument gets had
about the wrong thing.

There is deliberately no *per-plugin* budget: a plugin that loads a speech model is
legitimately larger than one that greets people, and a number a real plugin has to break is
a number that gets raised rather than defended. The measured figures, and what they say, are
in [`../memory.md`](../memory.md).

### 10 · `rust-line-budget`

Hand-written Rust in `src-tauri/` stays under **300 lines**, generated code excluded.

Alexia.md's own tripwire. Rust is confined to installer, updates, tray and hotkey. Rust
nobody on this project can debug is worse than no Rust, and the budget is the only thing that
notices it creeping.

---

## Changing a check

A check that is weakened to make a commit pass has stopped defending anything, and the
commit that weakened it is exactly the one you will want to find later. So:

- **Weakening or deleting a check is its own commit**, with the reason in the message and
  nothing else in the diff.
- Raising a budget (9, 10) is weakening. Say what the number bought.
- A check that produces false positives gets **narrowed to what it defends**, not disabled.
- New checks are welcome and cheap. Add them while they still pass trivially.
