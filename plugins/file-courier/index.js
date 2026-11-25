// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createCourier, MOST_CHUNK, Refused } from './courier.js'

/**
 * File courier — hands a file out in 1 MiB pieces and takes one in, checked by SHA-256 at the
 * end. The hub moves a file by reading pieces from one computer's courier and writing them to
 * another's. Reading is limited to the folders the owner opened; writing lands in Downloads or
 * an opened folder and never overwrites.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const LEDGER = 'parts'
const courier = createCourier({
  roots: async () => (await alexia.server.server.listRoots()).roots ?? [],
  downloads: () => join(homedir(), 'Downloads'),
  ledger: {
    get: async () => {
      const value = await alexia.storage.get(LEDGER)
      return Array.isArray(value) ? value.filter((one) => typeof one === 'string') : []
    },
    set: (paths) => alexia.storage.set(LEDGER, paths),
  },
})

const said = (text, structured) => ({ content: [{ type: 'text', text }], structuredContent: structured })
const failed = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Run one operation; a refusal becomes a sentence, anything unexpected a plain one. */
async function guarded(run) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Refused) return failed(error.message)
    log.warn(`file courier: ${String(error)}`)
    return failed('Something went wrong with that file on this computer, and nothing was changed.')
  }
}

alexia.tool(
  'file.stat',
  {
    description: 'Size, SHA-256 and name of one file in the folders opened on this computer. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { path: { type: 'string', description: 'The full path of the file.' } },
      required: ['path'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) =>
    guarded(async () => {
      const out = await courier.stat(args)
      return said(`${out.name}: ${String(out.size)} bytes, SHA-256 ${out.sha256}`, out)
    }),
)

alexia.tool(
  'file.read_chunk',
  {
    description: 'One piece (at most 1 MiB) of a file in the folders opened on this computer, as base64. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The full path of the file.' },
        offset: { type: 'integer', minimum: 0, description: 'Where in the file the piece starts, in bytes.' },
        length: { type: 'integer', minimum: 1, maximum: MOST_CHUNK, description: 'How many bytes, at most 1048576.' },
      },
      required: ['path', 'offset', 'length'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) =>
    guarded(async () => {
      const out = await courier.readChunk(args)
      return said(`Read ${String(Buffer.from(out.data, 'base64').length)} bytes${out.eof ? ', the end of the file' : ''}.`, out)
    }),
)

alexia.tool(
  'file.write_chunk',
  {
    description:
      'Take in one piece of a file, into Downloads or a folder opened on this computer. Pieces go to a .part file until the last; ' +
      'then the SHA-256 is checked (when given) and the file gets its name. It never overwrites: an existing name becomes "name (2)".',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The file name, without folders.' },
        folder: { type: 'string', description: 'A folder opened on this computer. Downloads when left out.' },
        offset: { type: 'integer', minimum: 0, description: 'Where in the file this piece starts, in bytes.' },
        data: { type: 'string', description: 'The piece, base64, at most 1 MiB before encoding.' },
        last: { type: 'boolean', description: 'True for the final piece.' },
        sha256: { type: 'string', description: 'The whole file SHA-256 (hex), checked on the last piece.' },
      },
      required: ['name', 'offset', 'data', 'last'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  (args) =>
    guarded(async () => {
      const out = await courier.writeChunk(args)
      return said(out.done ? `The file arrived: ${out.path}` : 'Piece received.', { path: out.path })
    }),
)

if (isEntry()) {
  await alexia.start()
  await courier.cleanStale().catch(() => 0)
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point (argv[1] resolved through links, as Node resolves import.meta.url). */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
