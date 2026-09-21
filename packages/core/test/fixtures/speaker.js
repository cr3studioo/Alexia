// SPDX-License-Identifier: AGPL-3.0-only
// Promises the chip and *That wasn't her* in its manifest, and binds them only while
// something is "in use" — the shape `plugins/persona` has, without any of its storage.
//
// `use` and `stop` flip that, the way Use and Forget do on the real one. Each is a tool-list
// change on the wire, which is the one signal core has that who is answering moved. `marks`
// says how many *That wasn't her* calls arrived and what the last one carried.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'speaker', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const text = (t) => ({ content: [{ type: 'text', text: t }] })

let using = false
const marks = []

const named = server.registerTool(
  'in_use',
  { description: 'The name of the personality in use.', annotations: { readOnlyHint: true } },
  () => text(using ? 'Chief of staff' : ''),
)
const outOf = server.registerTool(
  'not_her',
  {
    description: 'Marks one answer as out of character.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { answer: { type: 'string' }, asked: { type: 'string' }, said: { type: 'string' } },
      required: ['answer'],
    }),
  },
  (args) => {
    marks.push(args)
    return text('Noted.')
  },
)

const bind = () => {
  named.update({ _meta: using ? { 'alexia/provides': ['persona.in_use'] } : {} })
  outOf.update({ _meta: using ? { 'alexia/provides': ['persona.not_her'] } : {} })
}

server.registerTool('use', { description: 'Something is in use now.' }, () => {
  using = true
  bind()
  return text('Using it.')
})
server.registerTool('stop', { description: 'Nothing is in use now.' }, () => {
  using = false
  bind()
  return text('Stopped.')
})
server.registerTool('marks', { description: 'What was marked.', annotations: { readOnlyHint: true } }, () =>
  text(JSON.stringify(marks)),
)

bind()
await server.connect(new StdioServerTransport())
console.error('ready')
