# Writing an Alexia plugin

> **The contract is unstable and will break at M4.** It is documented here so you can build
> against it now, not because it has settled. When it breaks, `alexia_protocol` goes up and
> a plugin declaring the old number stops loading with a sentence rather than a crash.
>
> **There is no promised review turnaround.** Plugins are reviewed when the maintainer gets
> to them. That is honest and it is not going to be dressed up as a queue with an SLA.

## Start

```bash
npm create @alexia/plugin
```

Four questions and a folder that runs. Then, in Alexia: **Plugins → Add a plugin**, and
paste that folder's path.

Before you submit it:

```bash
npx @alexia/conformance .
```

That is the same suite review runs. Failures do not get published; warnings are things
worth fixing that will not block you.

## What a plugin is

**An MCP server with a manifest beside it.** Everything the Model Context Protocol defines
is used as MCP defines it — tools, progress, cancellation, sampling, roots, cancellation.
`@alexia/sdk` adds only the two things MCP cannot know about: the `alexia/*` layer, and the
fact that stdout is the wire.

That means two useful things. Your plugin is testable with any MCP tooling, and any MCP
server in the world can be added to Alexia as a tool source without being a plugin at all.

## The three rules

1. **stdout is the wire.** One `console.log` corrupts the JSON-RPC stream and Alexia drops
   your plugin, silently, from the user's point of view. Use `log` from the SDK: every
   level goes to stderr, which Alexia captures, tags with your id, and shows in your log
   panel. You lose nothing.
2. **The folder name is the id.** `plugin.json`'s `id`, the folder, your storage namespace
   and your keychain entries are all one name. Rename one and Alexia will not load it.
3. **A tool description is prompt text.** It is the entire basis on which a model decides
   whether to call you. Say what it does *and when to reach for it*. A one-word description
   is a bug that shows up as "the assistant never uses my plugin".

## The pages

| | |
|---|---|
| [manifest.md](./manifest.md) | `plugin.json`, field by field |
| [tools.md](./tools.md) | Writing tools, and writing their descriptions |
| [lifecycle.md](./lifecycle.md) | Install, enable, disable, delete — and what each one costs |
| [storage.md](./storage.md) | Your namespace, and what purge takes |
| [settings.md](./settings.md) | The ten widgets, and the one you may write yourself |
| [capabilities.md](./capabilities.md) | Asking for what another plugin provides |
| [skills.md](./skills.md) | Shipping know-how alongside capability |
| [publishing.md](./publishing.md) | Conformance, checksums, signing, and the registry |

The specifications these describe are in [`../spec/`](../spec/). Where a page here and a
spec disagree, the spec is right and the page is a bug.
