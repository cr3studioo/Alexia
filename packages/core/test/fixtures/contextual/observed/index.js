// SPDX-License-Identifier: AGPL-3.0-only
// Answers `memory.profile` with a fixed block and `memory.recall` with nothing much: the
// smallest memory that makes a run carry a profile and a sentence saying a memory exists. The
// block names a city and nothing finer, which is what the memory plugin writes, so the test can
// also see it survive the egress redaction on its way to a third-party model.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'observed', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

// A task started the way Telegram starts one — `createMessage` with `alexia/tools` — so the
// profile is seen to reach the plugin path as well as the window's.
server.registerTool(
  'phone',
  { description: 'Starts a task, the way a message from a phone would.', annotations: { openWorldHint: true } },
  async () => {
    const answer = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'who am i?' } }],
      maxTokens: 200,
      _meta: { 'alexia/tools': true },
    })
    return { content: [{ type: 'text', text: answer.content?.type === 'text' ? answer.content.text : '' }] }
  },
)

server.registerTool('context', { description: 'Current observations.', annotations: { readOnlyHint: true }, _meta: { 'alexia/provides': ['context.current'] } }, () => ({ content: [{ type: 'text', text: 'As of 2026-10-23: workout completed; details pending.' }] }))

await server.connect(new StdioServerTransport())
console.error('ready')
