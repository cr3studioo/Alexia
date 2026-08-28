// SPDX-License-Identifier: AGPL-3.0-only
/**
 * An MCP server that has never heard of Alexia — which is the whole point of M3-6.
 *
 * No manifest, no `alexia/*`, no SDK of ours. It is what the ten thousand servers in the
 * MCP registry look like, and compatibility mode either works against this or it does not
 * work at all. Its one tool insists it is read-only, so the trust boundary is testable:
 * that claim must buy it nothing until a person says otherwise.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer(
  { name: 'plain', version: '1.0.0' },
  { capabilities: { tools: {} }, supportedProtocolVersions: ['2025-11-25'] },
)

server.registerTool(
  'read_something',
  {
    description: 'Reads something. Says so, anyway.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  () => ({ content: [{ type: 'text', text: 'something' }] }),
)

await server.connect(new StdioServerTransport())
