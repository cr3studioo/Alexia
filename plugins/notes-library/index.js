// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createLibrary } from './library.js'
import { createTimer } from './timer.js'

/**
 * Notes and documents — reads the documents and notes in the folders the owner chose, keeps a
 * short summary and an embedding per file, and finds them again by meaning.
 *
 * **It only reads.** Every file operation it is handed (`readdir`, `stat`, `readFile`, `realpath`)
 * is a read; there is no write anywhere in this plugin, so a bug cannot change a note.
 *
 * It depends on capabilities and never on who provides them: `text.embed` for meaning,
 * `document.extract` for PDF and Word files. Without the first it finds by words; without the
 * second it reads text and Markdown only, and the status says so.
 *
 * It only starts serving when run as the entry point, so importing it (as the load test does)
 * never attaches to stdio.
 */

const alexia = plugin()

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const said = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** The result of a capability call as text and, if it came with one, its structured body. */
function bodyOf(result) {
  if (result?.isError === true) throw new Error('refused')
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).flatMap((part) => (part?.type === 'text' ? [part.text] : [])).join('\n')
  return { text }
}

const library = createLibrary({
  fs: {
    async readdir(dir) {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
      }))
    },
    stat: (path) => stat(path),
    readFile: (path) => readFile(path),
  },
  real: (path) => realpath(path),
  async roots() {
    const listed = (await alexia.server.server.listRoots()).roots ?? []
    const out = []
    for (const root of listed) {
      const raw = typeof root === 'string' ? root : root?.uri
      if (typeof raw !== 'string') continue
      try {
        const path = raw.startsWith('file:') ? fileURLToPath(raw) : raw
        if (isAbsolute(path)) out.push(path)
      } catch {
        // A URI that is not a path on this machine is not a place a file can be inside.
      }
    }
    return out
  },
  settings: () => alexia.settings(),
  storage: alexia.storage,
  status: (value) => alexia.status('state', value).catch(() => {}),
  async embed(texts) {
    if (!(await alexia.answers('text.embed')).answers) return null
    const body = bodyOf(await alexia.capability('text.embed', { texts }))
    return Array.isArray(body.vectors) ? body.vectors : null
  },
  async sample(prompt) {
    const answer = await alexia.server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 300,
    })
    return answer.content?.type === 'text' ? answer.content.text : ''
  },
  async canExtract() {
    return (await alexia.answers('document.extract')).answers === true
  },
  async extract(path) {
    return String(bodyOf(await alexia.capability('document.extract', { file: path })).text ?? '')
  },
})

alexia.tool(
  'find_document',
  {
    description:
      'Find a document or note by what it is about ("the PDF about the scholarship"), in the folders the owner chose. ' +
      'Gives the title, the path, a short summary and why it matched. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the document is about.' },
        limit: { type: 'number', description: 'How many to return, at most. Defaults to 5.' },
      },
      required: ['query'],
    }),
    annotations: RO,
  },
  async ({ query, limit }) => {
    const found = await library.find(query, limit)
    if (found.empty) return said('Nothing has been read yet. Choose a folder in this plugin’s settings, or ask for a reindex.', { results: [] })
    if (found.results.length === 0) return said('Nothing in those folders matches that.', { results: [] })
    const lines = found.results.map(
      (one, i) => `${String(i + 1)}. ${one.title}\n   ${one.path}\n   ${one.summary}\n   Matched: ${one.why}`,
    )
    const note = found.meaning ? '' : '\n\n(Matched by words only: nothing here can embed text.)'
    return said(lines.join('\n') + note, { results: found.results })
  },
)

alexia.tool(
  'read_document',
  {
    description:
      'Read one document or note the owner has in their chosen folders, as text (at most 20 000 characters). ' +
      'PDF and Word files are read by whatever reads documents. Takes a path find_document gave. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { path: { type: 'string', description: 'The path of the document.' } },
      required: ['path'],
    }),
    annotations: RO,
  },
  async ({ path }) => {
    const got = await library.open(path)
    if (got.error) return refuse(got.error)
    const tail = got.cut ? `\n\n[Cut at 20000 of ${String(got.characters)} characters.]` : ''
    return said(got.text + tail, { characters: got.characters, cut: got.cut })
  },
)

alexia.tool(
  'notes',
  {
    description:
      'List the owner’s notes (Markdown files) with their #tags and [[links]], optionally only those with one tag. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { tag: { type: 'string', description: 'Only notes with this tag, with or without the #.' } },
    }),
    annotations: RO,
  },
  async ({ tag } = {}) => {
    const list = await library.notes(tag)
    if (list.length === 0) return said(tag ? `No notes tagged ${String(tag)}.` : 'No notes read yet.', { notes: [] })
    const lines = list.map(
      (one) =>
        `${one.title} — ${one.path}` +
        (one.tags.length > 0 ? `\n   tags: ${one.tags.map((t) => `#${t}`).join(' ')}` : '') +
        (one.links.length > 0 ? `\n   links: ${one.links.map((t) => `[[${t}]]`).join(' ')}` : ''),
    )
    return said(lines.join('\n'), { notes: list })
  },
)

alexia.tool(
  'reindex',
  {
    description: 'Read the chosen folders again now, instead of waiting for the timer. Only files that changed are read.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    // It changes only this plugin's own index; the owner's files are never written.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const done = await library.reindex()
    return said(
      `Read ${String(done.read)} changed file${done.read === 1 ? '' : 's'}, ${String(done.kept)} unchanged, ${String(done.removed)} gone. ` +
        `${String(done.files)} files in ${String(done.folders)} folder${done.folders === 1 ? '' : 's'}.` +
        (done.refused.length > 0 ? ` ${String(done.refused.length)} folder(s) are outside the folders you opened and were not read.` : '') +
        (done.truncated ? ' Too many files: the rest were left out.' : ''),
      { read: done.read, kept: done.kept, removed: done.removed, files: done.files },
    )
  },
)

// ---- the timer -------------------------------------------------------------------------------

const timer = createTimer({
  every: async () => (await alexia.settings()).every,
  run: () => quietly(),
})
const arm = () => timer.arm()

/** A run that failed is no reason for the plugin to fall over; the next tick tries again. */
async function quietly() {
  try {
    await library.reindex()
  } catch (error) {
    // Never the error's text: it can carry a path.
    log.info(`could not read the folders: ${error?.code ?? 'error'}`)
    await alexia.status('state', '▲ Could not read the folders just now; will try again').catch(() => {})
  }
}

alexia.onSettingsChanged(() => {
  void arm()
  void quietly()
})

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
  await arm()
  void quietly()
}

/** True when run as the entry point. argv[1] is resolved through links (a junction or symlink
 * to the plugins folder, macOS /var), because Node already resolves import.meta.url. */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
