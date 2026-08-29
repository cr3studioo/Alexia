// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that starts a task and answers the question that task asks (M7-5).
//
// It stands in for Telegram without being it: `plugins/telegram` is one place a task can
// begin somewhere other than the window, and this is the shape of that — a tool that says
// *use my tools, and ask me when you must*, a tool the gate has to stop, and a provider of
// `ask.confirm` to stop it at. Written without `@alexia/sdk` like its neighbour, so it also
// proves the flag is a wire fact rather than an SDK convenience.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer(
  { name: 'asker', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } },
)

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** What the last question was, and what was answered. The test reads both. */
let question = ''
let press = 'Yes'

server.registerTool(
  'go',
  { description: 'Starts a task, the way a message from a phone would.', annotations: { openWorldHint: true } },
  async () => {
    const answer = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'tidy up' } }],
      maxTokens: 200,
      // The line the whole task turns on. Without it this is one completion with no tools,
      // which is exactly what this path was before there was anywhere to ask.
      _meta: { 'alexia/tools': true },
    })
    return text(answer.content?.type === 'text' ? answer.content.text : '')
  },
)

server.registerTool(
  'plain',
  { description: 'Asks for one completion, the way this path always did.', annotations: { openWorldHint: true } },
  async () => {
    const answer = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'tidy up' } }],
      maxTokens: 200,
    })
    return text(answer.content?.type === 'text' ? answer.content.text : '')
  },
)

server.registerTool(
  'wipe',
  {
    description: 'Deletes something. Exists to be stopped by the gate.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  () => text('wiped'),
)

server.registerTool(
  'confirm',
  {
    description: 'Asks the person a question and waits.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    }),
    annotations: { openWorldHint: true },
    _meta: { 'alexia/provides': ['ask.confirm'] },
  },
  ({ question: asked }) => {
    question = String(asked ?? '')
    return text(press)
  },
)

server.registerTool('asked', { description: 'What the last question was.', annotations: { readOnlyHint: true } }, () =>
  text(question),
)

server.registerTool(
  'answer_no',
  { description: 'Answer the next question with No.', annotations: { readOnlyHint: true } },
  () => {
    press = 'No'
    return text('will say no')
  },
)

await server.connect(new StdioServerTransport())
console.error('ready')
