# Tools, and the descriptions that decide whether they are ever called

This is the page to read twice. Everything else here is mechanics; this is the part that
decides whether your plugin works in practice.

## Tools are not in the manifest

They come from `tools/list` at runtime, because they can change. A plugin whose model has
not finished downloading cannot answer, and should not claim it can. When your list
changes, say so:

```js
alexia.toolsChanged()
```

Alexia re-reads `tools/list` and the agent loop re-plans around what is actually there.
This is also what makes "a tool vanishes mid-task" a protocol event rather than a crash.

## Registering one

```js
import { fromJsonSchema, plugin } from '@alexia/sdk'

const alexia = plugin()

alexia.tool(
  'transcribe',
  {
    description:
      'Turn a recording into text, using Whisper on this machine. Takes the path of an ' +
      'audio file — wav, mp3, flac or ogg — and returns what was said. Use when the user ' +
      'refers to a recording, a voice note or an audio file.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { file: { type: 'string', description: 'The path of the audio file to read.' } },
      required: ['file'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ file }, ctx) => ({ content: [{ type: 'text', text: await whatWasSaid(file) }] }),
)
```

Note the handler signature. **A tool with an `inputSchema` is called `(args, ctx)`; a tool
without one is called `(ctx)`.** Writing `(_args, ctx)` on a tool that takes no arguments
hands you the context as `_args` and `undefined` as `ctx`, and in plain JavaScript nothing
will tell you.

## Writing the description

The description is what the model reads. It is not documentation and it is not a label.

**Say what it does, and say when to use it.** The second half is the one people leave out,
and it is the half that decides whether the tool is ever selected:

- *"Turn a recording into text."* — the model knows what it is. It does not know when it
  applies.
- *"…Use when the user refers to a recording, a voice note or an audio file."* — now it
  fires on "what did that voicemail say".

**Name the shape of what comes back.** A model planning three steps ahead needs to know
whether step two gets a list or a sentence.

**Say what it costs, if it costs something surprising.** *"Downloads 148 MB the first time."*

**Do not write a description that is a restatement of the name.** `list_files: "Lists
files."` teaches the model nothing it did not have.

Conformance flags a tool with no description as a warning, because it is the author's bug
even though nothing crashes.

## Annotations are the permission model

Alexia's four permission modes read MCP's own annotation hints. Nothing Alexia-specific,
nothing declared twice.

| Annotation | What Alexia does with it |
|---|---|
| `readOnlyHint: true` | runs without asking in the default mode, *Ask before anything risky* |
| `destructiveHint: true` | gates in every mode except Full trust |
| nothing declared | treated as *not read-only* — the safe reading of silence |

So declaring `readOnlyHint: true` is a claim about the user's world, not about your disk.
The voice plugin's `listen` tool reads no files and is **not** marked read-only, because
opening a microphone is something a person wants to be asked about. Getting this right is
the difference between a plugin people trust and one they turn off.

If your plugin was added through MCP compatibility mode rather than the Alexia registry,
none of your annotations are believed until a person says otherwise. That is MCP's own
guidance and it is not personal.

## Progress

Anything over about two seconds should report. Silence is what kills a first run, not time
— a tool downloading 148 MB and saying nothing looks exactly like a tool that has hung.

```js
alexia.progress(ctx, done, total, 'Fetching the speech model')
```

It does nothing when the caller did not ask for progress, so there is no branch to write.

## Cancellation

`ctx.mcpReq.signal` is an `AbortSignal` that fires when the user presses Stop. Pass it to
`fetch`, to `spawn`, to anything that takes one. A plugin that ignores it gets killed after
the call timeout instead, which works and is worse for everyone.

## Failing

Return the failure; do not throw if you can help it.

```js
return { isError: true, content: [{ type: 'text', text: 'There is no file at that path.' }] }
```

That sentence goes back to the model as the answer to its call, and the model plans around
it. *The file is not there* is information. A stack trace is not.
