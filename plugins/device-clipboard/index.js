// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { clipboardFor } from './clip.js'
import { createHistory } from './history.js'
import { createWatcher } from './watch.js'

/**
 * Clipboard — read it, set it, and keep a short text history of what was copied.
 *
 * The hub uses `clipboard_get` and `clipboard_set` to make the clipboard follow the owner
 * between computers. The history is local to this computer and holds text only, never anything
 * the OS or the copying app marked as a secret.
 *
 * **Clipboard text is private.** It is never logged, here or in the helpers.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const clip = clipboardFor()
const history = createHistory({ storage: alexia.storage })
const watcher = createWatcher({ clip: clip ?? { read: async () => ({ kind: 'none', sensitive: false }) }, history, settings: () => alexia.settings() })

const MAX_SET_BYTES = 1024 * 1024
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const unavailable = () => refuse(`The clipboard is not available on ${process.platform} yet.`)

alexia.tool(
  'clipboard_get',
  {
    description: 'What is on this computer’s clipboard right now: its text, or what kind of thing it is (an image, files). Nothing is shown when an app marked the copy as a secret.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (ctx) => {
    if (!clip) return unavailable()
    try {
      const seen = await clip.read(ctx?.mcpReq?.signal)
      const at = Date.now()
      const text =
        seen.sensitive ? 'The clipboard holds something marked private, so it is not shown.'
        : seen.kind === 'text' ? (seen.text ?? '')
        : seen.kind === 'image' ? 'The clipboard holds an image.'
        : seen.kind === 'files' ? 'The clipboard holds files.'
        : 'The clipboard is empty.'
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ...(!seen.sensitive && seen.kind === 'text' && typeof seen.text === 'string' && { text: seen.text }),
          kind: seen.kind === 'none' ? 'text' : seen.kind,
          at,
          sensitive: seen.sensitive,
        },
      }
    } catch (error) {
      return refuse(error.message)
    }
  },
)

alexia.tool(
  'clipboard_set',
  {
    description: 'Put text on this computer’s clipboard, replacing what is there.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to copy.' } },
      required: ['text'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ text }, ctx) => {
    if (!clip) return unavailable()
    if (typeof text !== 'string') return refuse('Give the text to copy.')
    if (Buffer.byteLength(text, 'utf8') > MAX_SET_BYTES) return refuse('That is too much text for the clipboard (over 1 MB).')
    try {
      await clip.write(text, ctx?.mcpReq?.signal)
      return { content: [{ type: 'text', text: 'Copied.' }], structuredContent: {} }
    } catch (error) {
      return refuse(error.message)
    }
  },
)

alexia.tool(
  'clipboard_history',
  {
    description: 'What was copied on this computer recently, newest first, as text. Empty when the history is turned off. Never holds anything marked private.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many, 1 to 50. Defaults to 20.' },
        query: { type: 'string', description: 'Only copies containing this text, ignoring case.' },
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ limit, query } = {}) => {
    try {
      const on = (await alexia.settings()).history !== false
      const items = on ? await history.list({ limit: Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20))), query }) : []
      const text =
        !on ? 'The clipboard history is turned off.'
        : items.length === 0 ? 'Nothing copied recently.'
        : items.map((item, n) => `${String(n + 1)}. ${item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text}`).join('\n')
      return { content: [{ type: 'text', text }], structuredContent: { items } }
    } catch (error) {
      return refuse(error.message)
    }
  },
)

alexia.tool(
  'clipboard_clear_history',
  {
    description: 'Delete the whole clipboard history on this computer. The clipboard itself is not touched.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const removed = await history.clear()
      return { content: [{ type: 'text', text: `Cleared ${String(removed)} saved ${removed === 1 ? 'copy' : 'copies'}.` }], structuredContent: { removed } }
    } catch (error) {
      return refuse(error.message)
    }
  },
)

/** Watch while the history is on and there is a clipboard to watch. */
async function follow() {
  const on = (await alexia.settings()).history !== false
  if (on && clip) watcher.start()
  else watcher.stop()
}

if (isEntry()) {
  await alexia.start()
  alexia.onSettingsChanged((changed) => {
    if ('history' in changed) void follow().catch((error) => log.warn('could not follow the history setting', error))
  })
  await follow()
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
