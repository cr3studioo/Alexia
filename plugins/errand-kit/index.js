// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { fillForm, listFields, NO_FIELDS, Refused, scoped } from './forms.js'
import { closeByKey, day, docsOf, items, line, localDay } from './paperwork.js'

/**
 * Errands: three skills (travel, bookings, forms) and the tools behind the forms one.
 *
 * There is no tool here that pays, books or submits anything. A filled PDF is a local copy
 * beside the original; sending it anywhere is the owner's step. Form contents are never logged.
 */

const alexia = plugin()

const text = (value, extra = {}) => ({ content: [{ type: 'text', text: value }], ...extra })
const refuse = (value) => ({ isError: true, content: [{ type: 'text', text: value }] })
const num = (value, fallback) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)

const roots = async () => (await alexia.server.server.listRoots()).roots

/** Resolve a path through the folders the owner opened, or say why not. */
async function inScope(path) {
  try {
    return { path: await scoped(path, await roots()) }
  } catch (error) {
    if (error instanceof Refused) return { refusal: refuse(error.message) }
    throw error
  }
}

const all = () => alexia.storage.select('items', { order: [['rowid', 'asc']], limit: 2000 })

/** The words of a form that has no fields, through whatever provides `document.extract`. */
async function flatText(path) {
  try {
    const answered = await alexia.capability('document.extract', { file: path })
    if (answered.isError === true) return ''
    return (answered.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim()
  } catch {
    return ''
  }
}

alexia.tool(
  'form_fields',
  {
    description:
      'List the fillable fields of a PDF form: name, type, options and current value. Takes the path of a PDF ' +
      'inside a folder the user has opened. For a flat PDF with no fields it says so, and gives its text when something can read it.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { path: { type: 'string', description: 'The path of the PDF form.' } },
      required: ['path'],
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ path } = {}) => {
    const found = await inScope(path)
    if (found.refusal) return found.refusal
    let fields
    try {
      fields = await listFields(found.path)
    } catch {
      return refuse('That PDF could not be opened as a form.')
    }
    if (fields.length === 0) {
      const words = await flatText(found.path)
      return text(words === '' ? NO_FIELDS : `${NO_FIELDS}\n\n${words}`, { structuredContent: { fields: [] } })
    }
    return text(fields.map((one) => `- ${one.name} (${one.type})`).join('\n'), { structuredContent: { fields } })
  },
)

alexia.tool(
  'fill_form',
  {
    description:
      'Fill a PDF form from `values` ({ field name: value }) and save the result as "<name> (filled).pdf" beside the original. ' +
      'The original is never changed and an existing copy is never overwritten. Returns the new path and the fields still empty. ' +
      'This only fills a local copy; it never sends or submits the form anywhere.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path of the PDF form.' },
        values: { type: 'object', description: 'Field name to value. Use form_fields for the names.', additionalProperties: true },
      },
      required: ['path', 'values'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ path, values } = {}) => {
    const found = await inScope(path)
    if (found.refusal) return found.refusal
    let result
    try {
      result = await fillForm(found.path, values && typeof values === 'object' ? values : {})
    } catch (error) {
      if (error instanceof Refused) return refuse(error.message)
      return refuse('That PDF could not be filled in.')
    }
    if (!result.fillable) return text(NO_FIELDS)
    const notes = [
      `Saved a filled copy: ${result.path}`,
      result.unknown.length > 0 ? `No such field: ${result.unknown.join(', ')}.` : '',
      result.empty.length > 0 ? `Left empty: ${result.empty.join(', ')}.` : 'Every field has a value.',
      'Nothing was sent anywhere.',
    ]
    return text(notes.filter((one) => one !== '').join('\n'), {
      structuredContent: { path: result.path, empty: result.empty, unknown: result.unknown },
    })
  },
)

alexia.tool(
  'paperwork_add',
  {
    description:
      'Add something to the paperwork checklist. `what` is the task, `due` an optional day (YYYY-MM-DD), `docs` an optional list of papers it needs.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        what: { type: 'string', description: 'What has to be filed, renewed or handed in.' },
        due: { type: 'string', description: 'The deadline as YYYY-MM-DD. Omit if there is none.' },
        docs: { type: 'array', items: { type: 'string' }, description: 'The papers it needs.' },
      },
      required: ['what'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ what, due, docs } = {}) => {
    const task = String(what ?? '').trim()
    if (task === '') return refuse('There was nothing to add.')
    const when = day(due)
    const note = due !== undefined && when === undefined ? ` I did not understand "${String(due)}" as a date, so it has no deadline.` : ''
    const id = await alexia.storage.insert('items', {
      what: task,
      ...(when !== undefined && { due: when }),
      state: 'open',
      docs: JSON.stringify(docsOf(docs)),
    })
    return text(`Added ${String(id)}: ${task}.${note}`, { structuredContent: { id: String(id) } })
  },
)

alexia.tool(
  'paperwork_done',
  {
    description: 'Tick one paperwork item off. Takes its id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which item.' } },
      required: ['id'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id } = {}) => {
    const rowid = Number(id)
    const [row] = await alexia.storage.select('items', { where: { rowid }, limit: 1 })
    if (!row) return refuse('There is no paperwork item with that id.')
    if (row.state !== 'open') return text('That one is already done.')
    await alexia.storage.update('items', { state: 'done' }, { rowid })
    return text(`Done: ${String(row.what)}`)
  },
)

alexia.tool(
  'paperwork',
  {
    description: 'The paperwork checklist: every item with its deadline, state and the papers it needs. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const rows = await all()
    if (rows.length === 0) return text('No paperwork on the list.', { structuredContent: { items: [] } })
    const today = localDay(Date.now(), 0)
    return text(rows.map((row) => line(row, today)).join('\n'), {
      structuredContent: {
        items: rows.map((row) => ({
          id: String(row.rowid),
          what: String(row.what),
          due: typeof row.due === 'string' && row.due !== '' ? row.due : null,
          state: row.state,
          docs: docsOf(row.docs),
        })),
      },
    })
  },
)

alexia.tool(
  'notice_items',
  {
    description:
      'Open paperwork with a deadline, for the scheduler. Takes `now` (epoch ms) and `tz_offset_min` (minutes east of UTC).',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'Not used: every dated open item is offered.' },
        tz_offset_min: { type: 'number', description: 'Minutes east of UTC. Defaults to 0.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  async ({ now, tz_offset_min } = {}) => {
    const found = items(await all(), num(now, Date.now()), num(tz_offset_min, 0))
    return text(found.map((item) => `- ${item.text}`).join('\n'), { structuredContent: { items: found } })
  },
)

alexia.tool(
  'notice_done',
  {
    description: 'Close the paperwork item a notice was about, when its key is `errands:<id>`. Any other key does nothing.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { key: { type: 'string', description: 'The notice key.' } },
      required: ['key'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.done'] },
  },
  async ({ key } = {}) => {
    const result = await closeByKey(alexia.storage, key)
    return text(result.closed ? 'Closed.' : 'Nothing to close.', { structuredContent: result })
  },
)

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
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
