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
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(done)
        reject(new Error('cancelled'))
      })
    }),
)

await alexia.start()
log.info('vanisher is ready')
