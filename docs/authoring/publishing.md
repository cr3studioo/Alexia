# Publishing

**A plugin version is a GitHub Release.** Nothing ships inside the Alexia installer — every
plugin on somebody's machine got there as a download — so publishing one is cutting a release
and nothing else. There is no index to regenerate and no site to deploy: the release *is* the
listing, and it shows up on the Plugins screen of everybody whose Alexia can run it.

## 1. Pass conformance

```bash
npx @alexia/conformance .
```

It runs the mechanical half of review: does the manifest validate, does it boot, does it
handshake, are the tools described and reachable, did stdout stay clean, does it survive a
dependency that is not there, did everything it wrote go through the contract.

Exit code 1 on a failure, 0 on warnings. Warnings are worth fixing and will not block you.

This is the same suite review runs, so nothing about the outcome is a surprise. What is left
for a person is the half that needs judgement: is what this does honest, and are the
sentences in `requires[]` true.

## 2. Say which Alexia it runs on

```json
{
  "version": "1.0.4",
  "alexia_protocol": 4,
  "min_app": "0.2.0"
}
```

Two different questions, and both are asked before a download:

- **`alexia_protocol`** is the *shape* of the contract — the `alexia/*` layer your plugin
  speaks. `docs/spec/versions.md` says which revisions core accepts.
- **`min_app`** and **`max_app`** are the *builds*. A capability that arrived in 0.2.0 is not
  a new protocol revision, and a plugin that needs it will handshake perfectly on 0.1.9 and
  then not work. This is where you say so.

Both are optional in the sense that `max_app` almost always should be absent, and `min_app`
should name the oldest Alexia you actually tested against rather than the one you happen to
be running. **A range is a promise.** Narrowing one that did not need narrowing takes your
plugin off the shelf of everybody who has not updated yet, and they are not told what they are
missing — only that *one plugin needs a newer Alexia*.

An Alexia that is too old does not show your plugin at all, does not offer it as an update,
and refuses to install it if it is asked to anyway. Those are the same check in three places
(`versionVerdict`), so there is no path that installs something that cannot load.

## 3. Cut the release

If your plugin lives in this repository:

```bash
node scripts/publish.mjs --only my-plugin        # cuts the release
node scripts/publish.mjs --only my-plugin --dry-run   # prints what it would publish
```

If it lives in yours, do the same three things the script does:

```bash
tar -czf my-plugin-1.0.4.tgz my-plugin/
sha256sum my-plugin-1.0.4.tgz
gh release create my-plugin-v1.0.4 my-plugin-1.0.4.tgz \
  --title "My Plugin 1.0.4" --notes-file notes.md --latest=false
```

Three rules, and each of them is load-bearing:

- **The `.tgz` is an asset on the release**, with your plugin folder at the root or one level
  down. Alexia reads the download URL off the asset rather than out of the notes, so what is
  offered is always what is attached. Anything in the archive that is not a file or a
  directory — a symlink in particular — is dropped on install rather than followed.
- **The tag is `<id>-v<version>`.** Not required by anything that reads the release, and it is
  what makes a list of a hundred releases legible to a person.
- **`--latest=false`.** Alexia updates *itself* from `releases/latest/download/latest.json`,
  and GitHub's *latest* is whichever release was published most recently. A plugin release
  claiming to be latest points every install's updater at a release with no installer on it.

### The block in the release notes

The notes are read by two audiences. Write whatever a person should know, and include one
fenced block that Alexia reads:

````markdown
Reads a document you give it and hands back what it says.

It asks for:
- `fs.read_scoped` — To open the document you attached. It only ever reads.

```alexia
{
  "id": "my-plugin",
  "name": "My Plugin",
  "summary": "One sentence.",
  "version": "1.0.4",
  "license": "Apache-2.0",
  "author": "you",
  "sha256": "…64 hex characters…",
  "alexia_protocol": 4,
  "mcp_protocol": "2025-11-25",
  "min_app": "0.2.0",
  "requires": [{ "cap": "net.request", "why": "To ask a forecast service." }],
  "provides": ["weather.forecast"]
}
```
````

A release with no block is not a plugin release and is ignored — which is how Alexia's own
installers live in the same repository without turning up on the Plugins screen.

`requires` is in the block and not only in the archive, because the library shows what you
asked for **before** anything is downloaded. Deciding whether to want something should not
require already having it, and the `why` sentences are shown in your own words, never
rewritten.

**`sha256` is checked against the bytes that arrive**, before anything is unpacked. A
mismatch deletes the download and says so. Get it from the archive you actually attached.

### Publishing an update

Bump `version` in `plugin.json` and cut another release. An existing tag is never rewritten:
a published version is somebody else's download now, and changing the bytes under a checksum
that a machine may already have written down is the one thing this cannot allow.

Alexia offers the update on the Plugins screen with what it keeps spelled out — settings,
stored data, and the plugin's own directory all survive, because an update replaces the
install folder and nothing else.

## Signing

Optional, and useful once a plugin has users. A detached ed25519 signature over the sha256
hex, base64, in the `signature` field of the block.

Alexia shows three states and conflates none of them:

- **signed**, and the user has the publisher key configured — checked
- **signature not checked** — it carries one and there is no key here to check it against,
  which is worth exactly as much as none
- nothing — no claim made

The checksum gates the install in all three cases.

## Withdrawing a plugin

Delete the release. It disappears from every shelf within fifteen minutes — that is how long
a listing is cached — and every install after that fails.

**It reaches nobody who already installed it**, and that is a real limitation rather than an
oversight. The static registry layout (`--pages`, or the Worker in `registry/`) has a
`/v0/revoked.json` that a client re-reads and shows to somebody who is *not* currently
browsing, with the reason. If you are running a registry that strangers depend on, that is the
shape to use; `scripts/publish.mjs --pages` still emits it, and pointing Alexia at it is one
setting.

## What you are agreeing to

- **The contract is unstable and will break.** When it does, `alexia_protocol` goes up and
  your plugin declines to load with a readable sentence rather than crashing. Publish an
  update when that happens, and set `min_app` to the build you fixed it on.
- **There is no promised review turnaround.** Reviewed when the maintainer gets to it.
