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
  },
  async ({ who }) => {
    const { greeting } = await alexia.settings()
    await alexia.storage.insert('greetings', { who, at: Date.now() })
    return { content: [{ type: 'text', text: `${greeting}, ${who}.` }] }
  },
)

alexia.tool('greeted', { description: 'How many people have been greeted so far.' }, async () => {
  const count = await alexia.storage.count('greetings')
  return { content: [{ type: 'text', text: String(count) }] }
})

await alexia.start()
log.info(`${alexia.manifest.name} is ready`)
