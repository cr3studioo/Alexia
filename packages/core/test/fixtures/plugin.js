// SPDX-License-Identifier: AGPL-3.0-only
// An MCP server written **without** `@alexia/sdk`, which is the point of it: the wire spec
// claims a plugin can be written in any language with no SDK, and this is core's standing
// proof of that claim. It exercises what core offers a plugin — the model, the folder
// scope, a tool list that changes underneath it.
//
// How a plugin *dies* is `plugins/crasher`. stdout is the wire; everything here is stderr.
import { McpServer, fromJsonSchema, inputRequired, inputResponse } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer(
  { name: 'fixture', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } }, instructions: 'A stand-in plugin, for exercising what core offers.' },
)

const text = (t) => ({ content: [{ type: 'text', text: t }] })

server.registerTool(
  'echo',
  {
    description: 'Says back what it was given.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { say: { type: 'string' } },
      required: ['say'],
    }),
    annotations: { readOnlyHint: true },
  },
  ({ say }) => text(say),
)

server.registerTool('ask', { description: 'Asks the host for the model.' }, (ctx) => {
  const answer = inputResponse(ctx.mcpReq.inputResponses, 'model')
  if (answer.kind === 'sampling') return text(answer.result.content.text)
  return inputRequired({
    inputRequests: {
      model: inputRequired.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'are you there' } }],
        maxTokens: 32,
      }),
    },
  })
})

server.registerTool('where', { description: 'Asks the host which folders are in scope.' }, (ctx) => {
  const answer = inputResponse(ctx.mcpReq.inputResponses, 'roots')
  if (answer.kind === 'roots') return text(answer.roots.map((r) => r.uri).join(' '))
  return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } })
})

// The layer core sends *down*. Written out by hand for the same reason as the rest of
// this file: a plugin in a language with no SDK is told about a setting change too.
let changed = null
server.server.setNotificationHandler(
  'alexia/settings/changed',
  { params: fromJsonSchema({ type: 'object', properties: { changed: { type: 'object' } } }) },
  (params) => {
    changed = params.changed
  },
)

server.registerTool('changed', { description: 'What core last said had changed.' }, () =>
  text(JSON.stringify(changed)),
)

server.registerTool('grow', { description: 'Gains a new tool, and says so.' }, () => {
  server.registerTool('grown', { description: 'Did not exist a moment ago.' }, () => text('new'))
  server.sendToolListChanged()
  return text('grown')
})

await server.connect(new StdioServerTransport())
console.error('ready')
