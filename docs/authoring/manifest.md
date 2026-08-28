# `plugin.json`

Read **before your process ever exists**. Everything Alexia needs while you are not running
lives here: what to show in the library, what settings to draw, what you require, what you
provide, what to purge.

```jsonc
{
  "manifest_version": 1,
  "id": "coat-check",             // lowercase, hyphens, and it must equal the folder name
  "name": "Coat Check",
  "summary": "Tells you whether to take a coat.",   // one sentence, under 200 characters
  "version": "0.1.0",             // semantic
  "license": "Apache-2.0",

  "entry": { "run": "node", "args": ["index.js"] },

  "alexia_protocol": 1,           // ours: which Alexia contract you were written against
  "mcp_protocol": "2025-11-25",   // MCP's: which revision you serve

  "requires": [
    { "cap": "net.request", "why": "To ask a forecast service what today looks like." }
  ],
  "provides": ["weather.forecast"],

  "settings": [ /* see settings.md */ ],
  "storage": { "namespace": "coat-check", "tables": ["asked"], "dir": true },
  "commands": [{ "name": "coat", "summary": "Ask about today" }],
  "skills": ["skills/reading-a-forecast"],
  "min_tier": "T0"
}
```

## The fields that catch people

**`id` must equal the folder name.** It is also your storage namespace and your keychain
prefix. One name, learned once — the same rule agentskills.io uses.

**`entry.run` is a command on PATH or a path relative to your folder.** An absolute path is
refused: it is wrong on somebody else's machine. `"node"` means *Alexia's* Node, the one
the user never had to install.

**`why` is not decoration.** It is the sentence a person reads on the screen where they
decide whether to enable you. Alexia never rewrites it and never summarises it. Write a
reason, not a label:

- bad: `{ "cap": "fs.read_scoped", "why": "File access" }`
- good: `{ "cap": "fs.read_scoped", "why": "To open the recording you point it at." }`

Conformance warns about a `why` short enough to be a label.

**The manifest is strict.** An unrecognised key is a load error, not a shrug. A typo'd
`provide` that was silently ignored would be a plugin asking for nothing and failing at
runtime, which is a far worse morning.

**Two versions, doing different jobs.** `mcp_protocol` is upstream's, negotiated by the
handshake and handled by the SDK. `alexia_protocol` is ours, an integer, bumped when the
`alexia/*` layer changes — and checked before you are spawned at all:

```
you say alexia_protocol 1    Alexia speaks 1..3   ->  loads
you say alexia_protocol 4    Alexia speaks 1..3   ->  "Coat Check needs a newer Alexia"
```

That refusal is what makes accepting third-party plugins survivable against a contract that
is still moving.

## `requires`: two kinds, one syntax

- A **permission** is something Alexia grants, from a fixed list. Asking for a name that is
  not on it means you do not install. See [`../spec/capabilities.md`](../spec/capabilities.md).
- A **service** is something another plugin provides, resolved at runtime by capability name.

You must declare a service in `requires[]` before you may call it. See
[capabilities.md](./capabilities.md).
