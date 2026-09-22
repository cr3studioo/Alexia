// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that asks for an answer with a progress token, and keeps every frame that came back
// on it (`alexia/stream`).
//
// It stands in for a channel plugin without being one: the shape is `createMessage` with
// `onprogress`, which is all a plugin does to put a `progressToken` on its request, and the
// frames core sends on that token. Written without `@alexia/sdk`, like `asker.js`, so it also
// proves the stream is a wire fact rather than an SDK convenience.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'streamed', version: '0.1.0' }, { capabilities: { tools: {} } })

/** Anything the SDK complained about — a progress notification for a token nobody sent, say. */
const complaints = []
server.server.onerror = (error) => complaints.push(String(error?.message ?? error))

/**
 * One `createMessage`, and what came back: the answer's words, its `_meta`, and every progress
 * notification that arrived before it. `progress: false` sends no token, which is every plugin
 * written before the stream existed.
 */
const ask =
  (text, { tools = false, progress = true } = {}) =>
  async () => {
    const frames = []
    const before = complaints.length
    const answer = await server.server.createMessage(
      {
        messages: [{ role: 'user', content: { type: 'text', text } }],
        maxTokens: 200,
        ...(tools && { _meta: { 'alexia/tools': true } }),
      },
      progress ? { onprogress: (update) => frames.push(update) } : {},
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            text: answer.content?.type === 'text' ? answer.content.text : '',
            meta: answer._meta ?? null,
            frames,
            complaints: complaints.slice(before),
          }),
        },
      ],
    }
  }

const pressable = { annotations: { openWorldHint: true } }
server.registerTool('plain', { description: 'One completion, streamed.', ...pressable }, ask('say it slowly'))
server.registerTool('silent', { description: 'One completion, with no token.', ...pressable }, ask('say it slowly', { progress: false }))
server.registerTool('task', { description: 'A task with tools, streamed.', ...pressable }, ask('look it up', { tools: true }))
server.registerTool('help', { description: 'Types /help.', ...pressable }, ask('/help', { tools: true }))
server.registerTool('status', { description: 'Types /status.', ...pressable }, ask('/status', { tools: true }))

// Something for the task to call, so the loop has a tool stage to say.
server.registerTool(
  'look',
  { description: 'Looks something up.', annotations: { readOnlyHint: true, openWorldHint: false } },
  () => ({ content: [{ type: 'text', text: 'found it' }] }),
)

await server.connect(new StdioServerTransport())
console.error('ready')
