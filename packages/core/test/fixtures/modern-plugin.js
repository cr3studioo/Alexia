// SPDX-License-Identifier: AGPL-3.0-only
// An MCP server that speaks only `2026-07-28`, served the way that revision requires over
// stdio: through `serveStdio`, which owns the era decision for the connection. A plain
// `server.connect(new StdioServerTransport())` answers `server/discover` with -32601 and
// the connection falls back to 2025.
//
// It exists to hold one fact still: core connects to it, and on that era a server cannot
// send its host a request — which is why an Alexia plugin is not built on it. See D57.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

serveStdio(() => {
  const server = new McpServer(
    { name: 'modern', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } }, supportedProtocolVersions: ['2026-07-28'] },
  )

  server.registerTool('reach_back', { description: 'Tries to call the host, and reports what happened.' }, async () => {
    try {
      const result = await server.server.request({ method: 'alexia/host/info', params: {} }, fromJsonSchema({ type: 'object' }), {
        timeout: 1500,
      })
      return { content: [{ type: 'text', text: `answered: ${JSON.stringify(result)}` }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `refused: ${error.message}` }] }
    }
  })

  return server
})
console.error('ready, on the newer era')
