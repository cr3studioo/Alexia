// SPDX-License-Identifier: AGPL-3.0-only
// Answers `persona.personality` and nothing else: the smallest plugin that makes a run carry
// a personality, so the trace line has something real to count. The document is read from a
// file beside it rather than written in here, because the test asserts its length and the
// two must not be able to drift apart.
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'voice', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const doc = readFileSync(new URL('./doc.txt', import.meta.url), 'utf8')

const standing = server.registerTool(
  'personality',
  {
    description: 'The standing instruction Alexia is currently running with.',
    annotations: { readOnlyHint: true },
  },
  () => ({ content: [{ type: 'text', text: doc }] }),
)

// The binding core actually resolves by. The manifest promises the capability; this says
// which tool answers it, and it goes on afterwards rather than in the registration because
// that is the only place the server takes it — the same shape `plugins/persona` uses.
standing.update({ _meta: { 'alexia/provides': ['persona.personality'] } })

await server.connect(new StdioServerTransport())
console.error('ready')
