// SPDX-License-Identifier: AGPL-3.0-only
// Promises `memory.profile` and fails every time: a memory having a bad day, which must cost
// the prompt its block and nothing else — and whose error text must never reach a model as a
// fact about the user.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'broken', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const profile = server.registerTool(
  'profile',
  { description: 'What the user has asked to be known about them.', annotations: { readOnlyHint: true } },
  () => {
    throw new Error('the memory database is locked')
  },
)
profile.update({ _meta: { 'alexia/provides': ['memory.profile'] } })

await server.connect(new StdioServerTransport())
console.error('ready')
