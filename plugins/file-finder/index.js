// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Refused } from './files.js'
import { backendFor, createFinder, DEFAULT_LIMIT, KINDS, MOST_LIMIT } from './search.js'
import { createTidy } from './tidy.js'

/**
 * Find and tidy — finds files through the index the system already keeps, and sorts a folder's
 * loose files into subfolders: first as a plan, then, once the owner approved it, for real, with
 * a way back. Both stay inside the folders the owner opened.
 *
 * **File names are private.** Neither they nor what was searched for is ever logged.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const roots = async () => (await alexia.server.server.listRoots()).roots ?? []
const find = backendFor()
const finder = find && createFinder({ roots, find })
const tidy = createTidy({ roots, store: alexia.storage })

/** How many moves are spelled out for the model; the rest are counted. */
const SHOWN = 100

const said = (text, structured) => ({ content: [{ type: 'text', text }], structuredContent: structured })
const failed = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Run one operation; a refusal becomes a sentence, anything unexpected a plain one. */
async function guarded(run) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Refused) return failed(error.message)
    // The code or the type only: a message can quote a path.
    log.warn(`file finder: ${String(error?.code ?? error?.name)}`)
    return failed('Something went wrong with the files on this computer.')
  }
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const files = (n) => `${String(n)} ${n === 1 ? 'file' : 'files'}`

alexia.tool(
  'file.search',
  {
    description:
      'Find files and folders on this computer by words in their name or text, through the system search index, in the folders opened for Alexia. Newest first. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, for example "lease agreement". Leave the kind and date out of it.' },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind of thing.' },
        folder: { type: 'string', description: 'The full path of a folder to search in.' },
        modified_after: { type: 'string', description: 'Only what was changed on or after this date, as 2026-03-01.' },
        limit: { type: 'integer', minimum: 1, maximum: MOST_LIMIT, description: `At most this many results. Defaults to ${String(DEFAULT_LIMIT)}.` },
      },
      required: ['query'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    // Bound only where there is an index to ask, so elsewhere the hub looks further.
    _meta: finder ? { 'alexia/provides': ['file.search'] } : {},
  },
  (args, ctx) =>
    guarded(async () => {
      if (!finder) return failed('I can’t search files on that computer.')
      const out = await finder.search(args, { signal: ctx?.mcpReq?.signal })
      const lines = out.items.map((item) => `${item.path} (changed ${day(item.modified)})`)
      return said(lines.length ? `Found ${String(lines.length)}:\n${lines.join('\n')}` : 'Nothing found.', out)
    }),
)

alexia.tool(
  'folder.tidy',
  {
    description:
      'Tidy the loose files of one folder into subfolders (Documents, Images, Archives, Old installers). Without apply nothing moves: ' +
      'it returns a plan and its plan_id. With apply set to that plan_id, within an hour, it moves exactly those files. Never touches ' +
      'folders, hidden files or anything younger than a day.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'The full path of the folder to tidy.' },
        apply: { type: 'string', description: 'The plan_id of a proposed plan, to carry it out. Leave it out to propose.' },
      },
      required: ['folder'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['folder.tidy'] },
  },
  (args) =>
    guarded(async () => {
      if (args.apply !== undefined) {
        const out = await tidy.apply(args.folder, args.apply)
        const left = out.skipped ? ` ${files(out.skipped)} stayed: changed, in the way or in use.` : ''
        return said(`Moved ${files(out.moved)}.${left} folder.tidy_undo with plan_id ${args.apply} moves them back.`, out)
      }
      const out = await tidy.propose(args.folder)
      if (out.moves.length === 0) return said('Nothing there needs tidying.', out)
      const lines = out.moves.slice(0, SHOWN).map((move) => `${basename(move.from)} → ${basename(dirname(move.to))}/${basename(move.to)} (${move.why})`)
      if (out.moves.length > SHOWN) lines.push(`and ${String(out.moves.length - SHOWN)} more`)
      return said(`A plan to move ${files(out.moves.length)} (plan_id ${out.plan_id}). Nothing has moved yet.\n${lines.join('\n')}`, out)
    }),
)

alexia.tool(
  'folder.tidy_undo',
  {
    description: 'Move back the files that carrying out a tidy plan moved. A file that has since been replaced, or whose old name is taken, stays.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { plan_id: { type: 'string', description: 'The plan_id of the plan that was carried out.' } },
      required: ['plan_id'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  (args) =>
    guarded(async () => {
      const out = await tidy.undo(args.plan_id)
      const left = out.skipped ? ` ${files(out.skipped)} could not go back.` : ''
      return said(`Moved ${files(out.moved)} back.${left}`, out)
    }),
)

if (isEntry()) {
  await alexia.start()
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
