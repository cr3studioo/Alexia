// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that asks core for the model and stops waiting after a second (D160).
//
// It stands in for the personality adapter, which gives up at 110 s and shows a refusal: the
// shape is a `sampling` request with a timeout of its own, and what is under test is what core
// does once the plugin has gone — nothing. Written without `@alexia/sdk`, like its neighbours,
// so the cancel is a wire fact rather than an SDK convenience.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'impatient', version: '0.1.0' }, { capabilities: { tools: {} } })

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/**
 * **Not this process's first request.** The SDK (2.0.0) drops a cancel for request id 0 —
 * `if (!notification.params.requestId) return` — and a plugin numbers its requests from 0, so
 * a cancel on the very first thing a plugin ever asks never reaches core. The personality
 * adapter reads its settings before it samples, so its request is never that one; this does
 * the same with the cheapest request there is.
 */
let warmed = false

/** One `sampling` request that waits `timeout` ms, with or without the tools flag. */
const ask = (meta, timeout) => async () => {
  if (!warmed) {
    await server.server.listRoots()
    warmed = true
  }
  try {
    const answer = await server.server.createMessage(
      {
        messages: [{ role: 'user', content: { type: 'text', text: 'describe her in a paragraph' } }],
        maxTokens: 200,
        ...(meta && { _meta: { 'alexia/tools': true } }),
      },
      { timeout },
    )
    return text(answer.content?.type === 'text' ? answer.content.text : '')
  } catch (error) {
    return text(`gave up: ${error instanceof Error ? error.message : String(error)}`)
  }
}

server.registerTool('briefly', { description: 'Asks, and waits a second.', annotations: { openWorldHint: true } }, ask(false, 1000))
server.registerTool(
  'task_briefly',
  { description: 'Starts a task, and waits a second.', annotations: { openWorldHint: true } },
  ask(true, 1000),
)
server.registerTool(
  'task_patiently',
  { description: 'Starts a task, and waits.', annotations: { openWorldHint: true } },
  ask(true, 30_000),
)

await server.connect(new StdioServerTransport())
console.error('ready')
