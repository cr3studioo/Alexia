# Alexia

An open-source AI assistant built as a **tiny core plus a rack of plugins you can pull out
without breaking anything**.

> ## ⚠️ The plugin contract is UNSTABLE and *will* break at M4
>
> This repo is public from its first commit so the work can be watched, not because any of
> it is finished. **Do not write a plugin against this contract yet and expect it to keep
> working.** Breaking it is what M4 is *for*. When the contract freezes (M4-9), this banner
> is replaced with the version it froze at.

---

## The one thing that makes this different

> *A feature you cannot remove is not modular, it is permanent.*

Every feature is a folder under `plugins/`. **Delete the folder while Alexia is running and
nothing else notices** — no dead menu entry, no orphaned setting, no crash. That is not a
design goal, it is a CI check, and it is the reason this project exists: a voice feature was
once added to another assistant and could not be removed without breaking the codebase.

Nine other invariants sit beside it, all enforced on every commit. Core is forbidden from
ever naming a plugin — the check greps for it.

## Status

**Phase 0.** Nothing runs yet. There is no installable build, no release, and no working
feature. What exists is the specification and the plan, which are the point right now: this
is a project where the written contract comes before the code.

- [`Alexia.md`](./Alexia.md) — what is being built and why. The source of truth.
- [`plan.md`](./plan.md) — how, in what order, and what is done so far.
- [`questions.md`](./questions.md) — what is still open.

## Licence

**Split, deliberately.** The app is copyleft so nobody repackages it as the closed
subscription product it was built in reaction to; the plugin SDK is permissive so nobody
needs legal advice to write a plugin.

| What | Licence |
|---|---|
| Alexia itself — core, UI, shell, app | [AGPL-3.0](./LICENSE) |
| `packages/protocol`, `packages/sdk`, `packages/conformance`, `packages/create-plugin` | Apache-2.0 (each carries its own `LICENSE`) |

**If you are writing a plugin, Apache-2.0 is the one that applies to you.** Your plugin is
your own code under your own licence; nothing here reaches into it.
