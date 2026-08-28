# Capabilities: asking for what somebody else provides

A capability is a dotted name standing for *a thing that can be done*, with no plugin
attached. `voice.transcribe`. `weather.forecast`.

## Calling one

Declare it in `requires[]` first — an undeclared capability is refused — then:

```js
const result = await alexia.capability('voice.transcribe', { file: path })
```

**You never learn who answered, and there is no way to ask.** That is not politeness; it is
the invariant, in code. If you could learn which plugin answered, you could depend on it,
and deleting that plugin's folder would stop being safe.

If nothing enabled provides it, you get `-32050 CAPABILITY_NOT_AVAILABLE`. **Handle that
and keep running.** A plugin that exits when a dependency is missing takes Alexia's whole
tool list with it, and the conformance suite fails you for it. The right shape is to say so:

```js
catch {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Nothing installed can turn speech into text right now.' }],
  }
}
```

That sentence is yours, and Alexia shows it verbatim.

## Providing one

Two halves, deliberately separate.

**The promise** is `provides` in the manifest. It is what the library shows and what another
plugin's `requires` resolves against, and it is true while your process is stopped.

**The binding** is on the tool, at runtime:

```js
const heard = alexia.tool('transcribe', { /* … */ }, handler)
// later, once the model has actually finished downloading:
heard.update({ _meta: { 'alexia/provides': ['voice.transcribe'] } })
```

They are separate because a plugin whose model is still downloading *cannot* turn speech
into text, and a caller is better served by an honest `-32050` than by a tool that fails
halfway. Bind when you can actually answer; unbind when you cannot.

## Permissions are the other kind

`fs.own_dir`, `net.download`, `audio.input`, `proc.spawn` and the rest come from a fixed
list Alexia defines — see [`../spec/capabilities.md`](../spec/capabilities.md). They are not
provided by anybody; they are granted, and asking for a name that is not on the list means
you do not install.

Where you may work is MCP's `roots`, unchanged. Ask for it the way MCP says.
