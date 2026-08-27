// SPDX-License-Identifier: AGPL-3.0-only
// A real MCP server, standing in for a plugin until `plugins/hello` exists at M0-4. It
// misbehaves on demand: the supervisor's whole job is what happens when a plugin does.
//
// stdout is the wire. Everything this file has to say goes to stderr.
import { McpServer, fromJsonSchema, inputRequired, inputResponse } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

if (process.argv.includes('--die-on-start')) {
  console.error('dying on purpose, before anyone can talk to me')
  process.exit(1)
}

const server = new McpServer(
  { name: 'fixture', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } }, instructions: 'A plugin that misbehaves on request.' },
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

server.registerTool('boom', { description: 'Exits mid-call.' }, () => {
  console.error('exiting mid-call')
  process.exit(3)
})

server.registerTool('wedge', { description: 'Blocks its own event loop, so not even ping is answered.' }, () => {
  // A busy plugin is still responsive; a wedged one is not. Blocking the thread is the
  // honest version of "hangs forever" — it stops the heartbeat too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  return text('woke up')
})

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

server.registerTool('grow', { description: 'Gains a new tool, and says so.' }, () => {
  server.registerTool('grown', { description: 'Did not exist a moment ago.' }, () => text('new'))
  server.sendToolListChanged()
  return text('grown')
})

await server.connect(new StdioServerTransport())
console.error('ready')
