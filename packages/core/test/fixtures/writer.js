// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that asks for a model good enough to write with (M8-1), the way `plugins/persona`
// does when somebody presses Adapt.
//
// It stands in for the personality adapter without being it: one `sampling/createMessage`,
// carrying MCP's own `modelPreferences` with intelligence first, from a manifest declaring
// `min_tier`. Written without `@alexia/sdk` like its neighbours, so what it proves is a wire
// fact — a plugin author setting a field in the protocol, and core reading it — rather than
// an SDK convenience.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'writer', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** The adapter's own numbers, copied from `plugins/persona/index.js`. */
const CAPABLE = { intelligencePriority: 0.8, speedPriority: 0.3, costPriority: 0.3 }

/** Which model answered, beside the words — so a test can say *which rung wrote it*. */
const answered = (reply) => `${reply.content?.type === 'text' ? reply.content.text : ''} (${reply.model ?? ''})`

server.registerTool(
  'adapt',
  { description: 'Writes a personality, and needs a model that can write.', annotations: { openWorldHint: true } },
  async () => {
    const reply = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'turn these notes into a personality' } }],
      maxTokens: 200,
      modelPreferences: CAPABLE,
    })
    return text(answered(reply))
  },
)

server.registerTool(
  'plainly',
  { description: 'Asks for a completion without saying anything about the model.', annotations: { openWorldHint: true } },
  async () => {
    const reply = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'anything at all' } }],
      maxTokens: 200,
    })
    return text(answered(reply))
  },
)

await server.connect(new StdioServerTransport())
console.error('ready')
