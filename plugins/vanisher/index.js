// SPDX-License-Identifier: AGPL-3.0-only
// The plugin that disappears. Its whole job is to be busy for long enough that its folder
// can be deleted mid-call — invariant 4, and the sentence the project is built on.
import { fromJsonSchema, log, plugin } from '@alexia/sdk'

const alexia = plugin()

alexia.tool(
  'slow',
  {
    description: 'Takes a while, on purpose.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { ms: { type: 'number', description: 'How long to take.' } },
      required: ['ms'],
    }),
    annotations: { readOnlyHint: true },
  },
  ({ ms }, ctx) =>
    new Promise((resolve, reject) => {
      const done = setTimeout(() => resolve({ content: [{ type: 'text', text: 'still here' }] }), ms)
      // Stop must always work: free what you allocated and do not answer a cancelled call.
      ctx.mcpReq.signal.addEventListener('abort', () => {
        clearTimeout(done)
        reject(new Error('cancelled'))
      })
    }),
)

alexia.tool(
  'greet_via_alexia',
  {
    description: 'Has something else do the greeting, without knowing what.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
    }),
  },
  async ({ who }) => {
    try {
      // By capability name. Not by plugin id, because there is no way to say one.
      return await alexia.capability('demo.greet', { who })
    } catch {
      // Degrading is the author's job, and this sentence is the author's. Core will not
      // write it, and will not hide the plugin for having nothing to call.
      return {
        content: [{ type: 'text', text: 'Nothing installed can greet anyone right now.' }],
        isError: true,
      }
    }
  },
)

await alexia.start()
log.info('vanisher is ready')
