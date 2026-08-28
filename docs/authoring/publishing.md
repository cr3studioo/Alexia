# Publishing

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

## 2. Pack it

```bash
tar -czf my-plugin-0.1.0.tgz my-plugin/
sha256sum my-plugin-0.1.0.tgz
```

A `.tgz` with your folder at the root, or one level down. Anything in the archive that is
not a file or a directory — a symlink, in particular — is dropped on install rather than
followed, so do not rely on one.

Host the archive wherever you like, over **https**. The registry stores no bytes: it says
where the archive is and what it must hash to. A compromised registry can point somewhere
else but cannot silently change what your plugin is.

## 3. Submit

Send the maintainer the row:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "summary": "One sentence.",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "author": "you",
  "url": "https://example.com/my-plugin-0.1.0.tgz",
  "sha256": "…64 hex characters…",
  "alexia_protocol": 1,
  "mcp_protocol": "2025-11-25",
  "requires": [{ "cap": "net.request", "why": "To ask a forecast service." }],
  "provides": ["weather.forecast"]
}
```

`requires` is on the row and not only in the archive, because the library shows what you
asked for **before** anything is downloaded. Deciding whether to want something should not
require already having it.

## Signing

Optional, and useful once a plugin has users. A detached ed25519 signature over the sha256
hex, base64, in the `signature` field.

Alexia shows three states and conflates none of them:

- **signed**, and the user has the publisher key configured — checked
- **signature not checked** — it carries one and there is no key here to check it against,
  which is worth exactly as much as none
- nothing — no claim made

The checksum gates the install in all three cases.

## Revocation

A plugin can be pulled from the registry immediately. Clients browsing stop seeing it; a
client that already has it installed is told, with the reason, the next time it looks. That
button is why the registry is a service rather than a file on a CDN.

Publishing a fixed version un-revokes the id, so a withdrawal is not a death sentence.

## What you are agreeing to

- **The contract is unstable and will break at M4.** When it does, `alexia_protocol` goes up
  and your plugin declines to load with a readable sentence rather than crashing. Publish an
  update when that happens.
- **There is no promised review turnaround.** Reviewed when the maintainer gets to it.
