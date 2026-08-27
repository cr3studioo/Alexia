// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'

const alexia = plugin()

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
    const { greeting } = await alexia.settings()
    await alexia.storage.insert('greetings', { who, at: Date.now() })
    return { content: [{ type: 'text', text: `${greeting}, ${who}.` }] }
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
  },
  async () => {
    const count = await alexia.storage.count('greetings')
    return { content: [{ type: 'text', text: String(count) }] }
  },
)

await alexia.start()
log.info(`${alexia.manifest.name} is ready`)
