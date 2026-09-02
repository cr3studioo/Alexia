// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that makes a file and hands it back — the whole of what a document, picture or
// report plugin does, with the making taken out.
//
// A fixture rather than `plugins/media`, deliberately: what is being held still is the
// **contract**, and ComfyUI is one caller of it. Written **without `@alexia/sdk`**, like its
// neighbours here and for the same reason — the SDK has a one-line `alexia.file()` helper,
// and a fixture using it would prove core can read what that helper writes rather than
// proving core reads `resource_link`. This emits the block by hand, exactly as MCP defines
// it, so what passes is the standard rather than our own convenience.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const server = new McpServer(
  { name: 'maker', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } },
)

const own = join(tmpdir(), 'alexia-maker-made')
mkdirSync(own, { recursive: true })

server.registerTool(
  'make',
  {
    description: 'Write a file and hand it back. Takes the name to write.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        // So *the tool named a file it never wrote* can be exercised on purpose.
        skip: { type: 'boolean' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  ({ name, skip }) => {
    const called = String(name ?? 'made.txt')
    const to = join(own, called)
    if (skip !== true) writeFileSync(to, `the contents of ${called}`)
    return {
      content: [
        { type: 'text', text: `Wrote ${called}.` },
        // MCP's own block, spelled out. `pathToFileURL` rather than a template, because a
        // Windows path has backslashes, a drive letter and probably a space in it.
        { type: 'resource_link', uri: pathToFileURL(to).href, name: called },
      ],
    }
  },
)

server.registerTool(
  'say_only',
  {
    description: 'Answer with text and no file at all. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  () => ({ content: [{ type: 'text', text: 'Nothing was written.' }] }),
)

await server.connect(new StdioServerTransport())
