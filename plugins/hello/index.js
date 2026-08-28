// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'

const alexia = plugin()

/** The settings, applied. Nine of the ten widgets are declared here and all nine are read. */
const dress = (settings, who) => {
  const { greeting = 'Hello', tone = 'warm', exclaim = false, extras = [] } = settings
  const sentence =
    tone === 'formal' ? `${greeting}, ${who}. A pleasure`
    : tone === 'plain' ? `${greeting}, ${who}`
    : `${greeting}, ${who} — good to see you`
  // "how many" is added by the caller, which is the only place the count is known.
  const time = extras.includes('the time') ? ` It is ${new Date().toLocaleTimeString()}.` : ''
  return sentence + (exclaim ? '!' : '.') + time
}

alexia.tool(
  'greet',
  {
    description: 'Greet someone by name. Use when the user introduces themselves or says hello.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { who: { type: 'string', description: 'The name to greet.' } },
      required: ['who'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    // The runtime half of `provides`: this tool is what answers that capability. Whoever
    // calls it learns nothing about who did — that is the invariant, in one line.
    _meta: { 'alexia/provides': ['demo.greet'] },
  },
  async ({ who }) => {
    const settings = await alexia.settings()
    await alexia.storage.insert('greetings', { who, at: Date.now() })
    const count = await alexia.storage.count('greetings')
    const said = dress(settings, who)
    // The `status` widget, driven. Core keeps this while Hello is stopped, which is what
    // makes the settings screen honest before the next spawn.
    await alexia.status('ready', `● Greeted ${count}`)
    return {
      content: [{ type: 'text', text: settings.extras?.includes('how many') ? `${said} That is ${count} so far.` : said }],
    }
  },
)

// A description is prompt text, and it is the only thing the model has to decide whether
// this is the tool it wants. So it says what comes back *and* when to reach for it — the
// standard the first-party plugins are here to set (M15-2).
alexia.tool(
  'greeted',
  {
    description:
      'Count how many people have been greeted so far, and return the number. Use when the user asks how many greetings have happened. Takes no arguments.',
    // Counting rows changes nothing, and saying so is what keeps the default permission
    // mode from stopping to ask about it. Conformance flags a tool that declares nothing.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const count = await alexia.storage.count('greetings')
    return { content: [{ type: 'text', text: String(count) }] }
  },
)

/**
 * What the `action` button on the settings screen calls, and what feeds the `progress` bar
 * above it. It does nothing useful on purpose: the point is that a long job started from that
 * screen reports itself, because a bar that moves is the difference between waiting and
 * quitting.
 */
alexia.tool(
  'warm_up',
  {
    description:
      'Warm up, slowly, reporting progress as it goes. Use only when the user explicitly asks Hello to warm up. Takes no arguments.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  // One argument, not two: a tool with no `inputSchema` is handed the context *first*, and
  // `(_args, ctx)` silently gives you the context as `_args` and `undefined` as `ctx`. In a
  // plain-JavaScript plugin nothing types-checks that for you.
  async (ctx) => {
    const { warm_up_ms: total = 1600 } = await alexia.settings()
    const steps = 8
    await alexia.status('ready', '▲ Warming up')
    for (let step = 1; step <= steps; step++) {
      await new Promise((done) => setTimeout(done, total / steps))
      alexia.progress(ctx, step, steps, step < steps ? 'Warming up' : 'Warm')
    }
    await alexia.status('ready', '● Warm')
    return { content: [{ type: 'text', text: `Warm, after ${total} ms.` }] }
  },
)

await alexia.start()
// Said once, at startup, so the screen is honest the moment somebody opens it.
await alexia.status('ready', '■ Idle').catch(() => {})
log.info(`${alexia.manifest.name} is ready`)
