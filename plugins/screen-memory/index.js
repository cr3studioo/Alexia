// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createLoop, createScreenMemory } from './capture.js'

/**
 * Screen memory: the words that were on this computer's screen, kept for a few days so Alexia
 * can answer "what was that error I saw this morning". It ships off.
 *
 * It depends on capabilities and never on who provides them: `computer.screenshot` to look,
 * `image.ocr` for the words, `text.embed` for meaning. It never captures the screen itself, and
 * it deletes each picture as soon as its words are read (capture.js has the order and why).
 *
 * Nothing read off the screen — words, titles, app names — goes into a log.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const memory = createScreenMemory({
  storage: alexia.storage,
  capability: (cap, args) => alexia.capability(cap, args),
  answers: (cap) => alexia.answers(cap),
  settings: () => alexia.settings(),
  unlink: (path) => rm(path),
  status: (line) => void alexia.status('state', line).catch(() => {}),
  warn: (message) => log.warn(message),
})

const loop = createLoop({ memory })

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const object = (properties, required) => fromJsonSchema({ type: 'object', properties, ...(required && { required }) })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const said = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })

const when = (iso) => iso.replace('T', ' ').slice(0, 16)

alexia.tool(
  'screen_recall',
  {
    description:
      'Find what was on this computer’s screen earlier, by meaning: "the error I saw this morning", "the flight price I had open yesterday". ' +
      'Gives when, the app, the window title and the words read off the screen. Only finds anything if the owner turned screen memory on. ' +
      'Times are ISO 8601; work out "this morning" yourself. Read-only.',
    inputSchema: object(
      {
        query: { type: 'string', description: 'What to look for.' },
        from: { type: 'string', description: 'Only moments at or after this time (ISO 8601).' },
        to: { type: 'string', description: 'Only moments at or before this time (ISO 8601).' },
      },
      ['query'],
    ),
    annotations: RO,
  },
  async ({ query, from, to }) => {
    const found = await memory.recall({ query, from, to })
    if (found.error) return refuse(found.error)
    if (found.results.length === 0) {
      const { on } = await memory.settings()
      return said(
        on ? 'Nothing on screen in that time matches that.' : 'Screen memory is off, so nothing was kept. The owner can turn it on in its settings.',
        { results: [] },
      )
    }
    const lines = found.results.map((r) => `- ${when(r.at)} UTC, ${r.app}, “${r.title}”:\n${r.text}`)
    return said(lines.join('\n\n'), { results: found.results, by_meaning: found.byMeaning })
  },
)

alexia.tool(
  'screen_forget',
  {
    description:
      'Delete everything screen memory kept between two times, for good. Both are required (ISO 8601). Use when the owner asks to forget a span.',
    inputSchema: object(
      {
        from: { type: 'string', description: 'The start of the span (ISO 8601).' },
        to: { type: 'string', description: 'The end of the span (ISO 8601).' },
      },
      ['from', 'to'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ from, to }) => {
    const gone = await memory.forget({ from, to })
    if (gone.error) return refuse(gone.error)
    await memory.report()
    return said(`Forgot ${String(gone.deleted)} moment${gone.deleted === 1 ? '' : 's'} from ${when(gone.from)} to ${when(gone.to)} UTC.`, gone)
  },
)

alexia.tool(
  'screen_status',
  { description: 'Whether screen memory is on, how often it looks, how long it keeps, and how many moments it holds. Takes no arguments.', annotations: RO },
  async () => {
    const i = await memory.info()
    const text =
      i.on ?
        `On: looks every ${String(i.every_minutes)} minutes and keeps ${String(i.keep_days)} days. ${String(i.moments)} moments kept.`
      : `Off. ${String(i.moments)} moments kept. Turn it on in this plugin’s settings.`
    return said(text, i)
  },
)

alexia.onSettingsChanged(() => {
  void loop.arm().catch(() => {})
})

if (isEntry()) {
  await alexia.start()
  await loop.arm().catch(() => log.warn('screen memory could not read its settings'))
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
