// SPDX-License-Identifier: AGPL-3.0-only
// Answers `memory.profile` with a fixed block and `memory.recall` with nothing much: the
// smallest memory that makes a run carry a profile and a sentence saying a memory exists. The
// block names a city and nothing finer, which is what the memory plugin writes, so the test can
// also see it survive the egress redaction on its way to a third-party model.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'profiled', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const profile = server.registerTool(
  'profile',
  { description: 'What the user has asked to be known about them.', annotations: { readOnlyHint: true } },
  () => ({ content: [{ type: 'text', text: 'Name: Václav.\nLives in Prague.\nSpeaks Czech and English.\n' }] }),
)
const recall = server.registerTool(
  'recall',
  { description: 'Recall what is remembered.', annotations: { readOnlyHint: true } },
  () => ({ content: [{ type: 'text', text: 'Nothing about that.' }] }),
)

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

profile.update({ _meta: { 'alexia/provides': ['memory.profile'] } })
recall.update({ _meta: { 'alexia/provides': ['memory.recall'] } })

await server.connect(new StdioServerTransport())
console.error('ready')
