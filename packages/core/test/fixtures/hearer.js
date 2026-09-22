// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that hears a personality at one length (D189), the way `plugins/persona`'s Hear her
// does: one `sampling/createMessage` carrying all three lengths on `_meta['alexia/lengths']`, and
// which to hear. Written without `@alexia/sdk`, so what it proves is a wire fact.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'hearer', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })

/** Three lengths nobody could mistake for one another. */
const LENGTHS = { high: 'FULL VERSION', medium: 'MEDIUM VERSION', small: 'SHORT VERSION' }

for (const hear of ['chat', 'small', 'medium', 'high']) {
  server.registerTool(
    `hear_${hear}`,
    { description: `Hears her at ${hear}.`, annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => {
      const reply = await server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'Who are you?' } }],
        systemPrompt: LENGTHS.high,
        maxTokens: 200,
        _meta: { 'alexia/lengths': { ...LENGTHS, ...(hear !== 'chat' && { hear }) } },
      })
      // What core said about it, as the text, so a test can read it straight back.
      return { content: [{ type: 'text', text: JSON.stringify({ model: reply.model, told: reply._meta?.['alexia/lengths'] ?? null }) }] }
    },
  )
}

await server.connect(new StdioServerTransport())
console.error('ready')
