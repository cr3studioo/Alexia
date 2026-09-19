// SPDX-License-Identifier: AGPL-3.0-only
// Answers `persona.personality` **in three lengths** (plan-personality.md §2), and nothing
// else. The neighbour `voice` fixture answers with one document, which is the older contract
// and still has to work; this one is the newer half — `text` is still the long document, and
// `structuredContent` carries all three.
//
// The three are read from files beside it rather than written in here, because the test
// asserts which one reached the model and the two must not be able to drift apart.
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'sized', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

const read = (name) => readFileSync(new URL(`./${name}.txt`, import.meta.url), 'utf8').trim()
const three = { high: read('high'), medium: read('medium'), small: read('small') }

const standing = server.registerTool(
  'personality',
  { description: 'The standing instruction Alexia is currently running with.', annotations: { readOnlyHint: true } },
  () => ({ content: [{ type: 'text', text: three.high }], structuredContent: three }),
)

standing.update({ _meta: { 'alexia/provides': ['persona.personality'] } })

await server.connect(new StdioServerTransport())
console.error('ready')
