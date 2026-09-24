# Alexia

Read [`Alexia.md`](./Alexia.md) — what we are building and why. It is the source of truth.

## Hard rules for AI agents

- **Never merge into `main`, push to `main`, or merge a pull request.** Not with `git`, not
  with `gh pr merge`, not by any other route. Commit and push only to your own workspace
  branch, and only when asked. The owner merges.
- **Never release.** Do not run the `release` workflow (`gh workflow run release`), create,
  edit or publish a GitHub Release, or touch release drafts. A release reaches everyone who
  has Alexia installed; only the owner starts one.
- **Alexia Dev never ships.** It is a local build for testing on the owner's Mac only.
  `src-tauri/tauri.dev.conf.json`, `scripts/dev-app.mjs` and the `ALEXIA_DEV_NAME` /
  `ALEXIA_KEYCHAIN` build variables must never be used by, or referenced from,
  `src-tauri/tauri.conf.json`, `tauri.macos.conf.json` or anything in `.github/workflows/`.

## "preview" — put this workspace into Alexia Dev

When the owner says **preview**, build this workspace's code into *Alexia Dev* so they can try
it without releasing anything:

```sh
pnpm app:dev
```

This builds the current workspace, installs `/Applications/Alexia Dev.app` (replacing any
earlier Alexia Dev), and opens it. It is a separate app from the real Alexia, with its own
data folder (`~/Library/Application Support/Alexia Dev`), its own keychain entry, and no
updates. Nothing is pushed, published or uploaded.

- The first build copies the real Alexia's data in. It is not copied again, so what the owner
  did in Alexia Dev survives the next preview. `pnpm app:dev --fresh-data` replaces it with a
  new copy of the real data. Only do that when asked.
- There is one Alexia Dev at a time. A preview from another workspace replaces it. Say which
  workspace and branch you built from.
- The build takes a few minutes. Run it in the background and tell the owner when it is open.
- If this workspace has no `scripts/dev-app.mjs`, its branch is older than the Alexia Dev
  tooling. Tell the owner, and do not merge `main` in without asking.
