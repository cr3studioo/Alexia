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
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const server = new McpServer(
  { name: 'asker', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } },
)

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const made = join(tmpdir(), 'alexia-asker-made')
mkdirSync(made, { recursive: true })

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

// A tool that writes a file and hands it back (D122). `readOnlyHint` so the gate does not
// stop it — this is about a file reaching the channel, and `wipe` already exercises the gate.
server.registerTool(
  'paint',
  { description: 'Writes a picture and hands it back.', annotations: { readOnlyHint: true, openWorldHint: false } },
  () => {
    const to = join(made, 'sunset.png')
    writeFileSync(to, Buffer.from('PNGSUN'))
    return {
      content: [
        { type: 'text', text: 'Painted a sunset.' },
        { type: 'resource_link', uri: pathToFileURL(to).href, name: 'sunset.png', mimeType: 'image/png' },
      ],
    }
  },
)

// `go`, but it reports what came back on the result's `_meta` — which is how a channel
// plugin that cannot reach `/api/file` gets the bytes.
server.registerTool(
  'go_paint',
  { description: 'Starts a task that makes a file, and reports what came back.', annotations: { openWorldHint: true } },
  async () => {
    const answer = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'paint a sunset' } }],
      maxTokens: 200,
      _meta: { 'alexia/tools': true },
    })
    return text(JSON.stringify(answer._meta?.['alexia/files'] ?? 'none'))
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

/**
 * A slash command typed where there is no window — the shape a message from a phone has.
 *
 * The same `sampling` call `go` makes, carrying a line beginning with a slash rather than a
 * sentence: a command has to reach core through the path a plugin already has, or it is a
 * command that exists on one screen only.
 */
const typed = (line) => async () => {
  const answer = await server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: line } }],
    maxTokens: 200,
    _meta: { 'alexia/tools': true },
  })
  return text(answer.content?.type === 'text' ? answer.content.text : '')
}

server.registerTool('slash_new', { description: 'Types /new.', annotations: { openWorldHint: true } }, typed('/new'))
server.registerTool('slash_cheap', { description: 'Types /cheap.', annotations: { openWorldHint: true } }, typed('/cheap'))
server.registerTool('slash_help', { description: 'Types /help.', annotations: { openWorldHint: true } }, typed('/help'))

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
