// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createFetcher } from './fetch.js'
import { createPortal } from './portal.js'
import { createWatcher, lines } from './watch.js'

/**
 * Page watch — reads the pages, feeds and school portal the owner named, and says what changed.
 * It provides `page.text` (what a scheduler watch on a page polls), `notice.items` for the
 * changes it finds itself, and a `brief.section` of new items from what the owner follows.
 *
 * It only starts serving when run as the entry point, so importing it (as the load test does)
 * never attaches to stdio.
 */

const alexia = plugin()

/** The addresses the owner wrote in the settings: only those (and the portal's own site) may be on a private network. */
async function listed(url) {
  const s = (await alexia.settings()) ?? {}
  const exact = new Set([...lines(s.pages), ...lines(s.feeds)].map((u) => safeHref(u)).filter(Boolean))
  if (exact.has(url.href)) return true
  const portalUrl = safeHref(s.portal_url)
  return portalUrl !== undefined && new URL(portalUrl).origin === url.origin
}
const safeHref = (raw) => {
  try {
    return new URL(String(raw ?? '').trim()).href
  } catch {
    return undefined
  }
}

const fetcher = createFetcher({ listed })
const portal = createPortal({
  request: fetcher.request,
  store: {
    get: async () => (await alexia.storage.get('portal_refused')) ?? undefined,
    set: async (value) => (value ? alexia.storage.set('portal_refused', value) : alexia.storage.remove('portal_refused')),
  },
})
const watcher = createWatcher({
  fetcher,
  portal,
  storage: alexia.storage,
  settings: () => alexia.settings(),
  status: (line) => alexia.status('state', line),
})

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

alexia.tool(
  'page_text',
  {
    description: 'The main text of a web page (scripts, menus and footers removed), at most 20,000 characters. Read-only.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { url: { type: 'string', description: 'The page address, http or https.' } },
      required: ['url'],
    }),
    // It reads someone else's website, so it is open-world even though it changes nothing.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { 'alexia/provides': ['page.text'] },
  },
  (args) => watcher.pageText(args),
)

alexia.tool(
  'notice_items',
  {
    description: 'Changes found on the pages, feeds and portal pages being watched, and a failed portal sign-in.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'Not used.' },
        tz_offset_min: { type: 'number', description: 'Not used.' },
      },
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  () => watcher.noticeItems(),
)

alexia.tool(
  'brief_section',
  {
    description: 'New items from the feeds you follow that match your interests: five for the morning, ten for the weekly brief.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        kind: { type: 'string', description: '"morning", "evening" or "weekly".' },
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        tz_offset_min: { type: 'number', description: 'Not used.' },
      },
      required: ['kind'],
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['brief.section'] },
  },
  (args) => watcher.briefSection(args),
)

alexia.tool(
  'check_now',
  {
    description: 'Look at every watched page, feed and portal page now instead of waiting for the next round.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  () => watcher.checkNow(),
)

let timer
async function schedule() {
  const { every } = await alexia.settings()
  const minutes = [30, 60, 180].includes(Number(every)) ? Number(every) : 60
  clearInterval(timer)
  timer = setInterval(() => void watcher.run().catch((e) => log.info(`a round failed: ${String(e?.message ?? e)}`)), minutes * 60_000)
  // Nothing waits on it: a timer that holds the process open is a plugin that cannot be stopped.
  timer.unref?.()
}

if (isEntry()) {
  alexia.onSettingsChanged((changed) => {
    if (Object.keys(changed).some((k) => k.startsWith('portal_'))) void portal.reset().catch(() => {})
    if ('every' in changed) void schedule().catch(() => {})
  })
  await alexia.start()
  await schedule()
  // A first look shortly after start, so the status says something true.
  setTimeout(() => void watcher.run().catch(() => {}), 15_000).unref?.()
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
