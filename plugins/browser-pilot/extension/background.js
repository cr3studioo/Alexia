// SPDX-License-Identifier: AGPL-3.0-only
/* global chrome, navigator, WebSocket */
/**
 * The extension's service worker: one WebSocket to the browser-pilot plugin on this computer
 * (`ws://127.0.0.1:<port>`, nothing else is ever contacted), the plugin's requests carried out in
 * the owner's tabs, one answer each.
 *
 * Settings live in `chrome.storage.local` (`token`, `port`, `act`); the status line the options
 * page shows lives in `chrome.storage.session`. `act` is the owner's switch: off (the default),
 * Alexia may look but not open, click or type.
 */

export const MIN_BACKOFF_MS = 1_000
export const MAX_BACKOFF_MS = 30_000
const PING = 'alexia-ping'
const READ_ONLY = 'Alexia may only read in this browser. The owner can allow her to act in the extension’s options.'
const STORE_HOSTS = ['chromewebstore.google.com', 'microsoftedge.microsoft.com']

/**
 * Why Alexia may not touch this page, as a sentence; undefined when she may. Only web pages:
 * not the browser's own (`chrome://`, `edge://`, `about:`), not an extension's, not the Web Store.
 */
export function refusal(address) {
  let url
  try {
    url = new URL(address)
  } catch {
    return 'Alexia can only work in web pages, and this tab has none.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Alexia does not work in the browser’s own pages or in extensions.'
  if (STORE_HOSTS.includes(url.hostname) || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) {
    return 'Alexia does not work in the browser’s extension store.'
  }
  return undefined
}

/** Wait before reconnect attempt `n` (0-based): 1 s, 2 s, 4 s … never more than 30 s. */
export const backoff = (n) => Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** n)

export const browserName = () =>
  navigator.userAgentData?.brands?.some((b) => b.brand === 'Microsoft Edge') || / Edg\//.test(navigator.userAgent ?? '') ? 'edge' : 'chrome'

export const hello = (token) => ({ hello: 1, token, browser: browserName(), version: chrome.runtime.getManifest().version })

const tabOf = (t) => ({ tabId: t.id, title: t.title ?? '', url: t.url ?? '', active: t.active === true })

async function tabFor(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId)
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) throw new Error('No tab is open.')
  return tab
}

/** Runs `request` in the page through `content.js`, after the page passed `refusal`. */
async function inPage(tab, request) {
  const refused = refusal(tab.url ?? '')
  if (refused) throw new Error(refused)
  const target = { tabId: tab.id }
  await chrome.scripting.executeScript({ target, files: ['content.js'] })
  const [frame] = await chrome.scripting.executeScript({ target, func: (r) => globalThis.__alexiaPilot.run(r), args: [request] })
  const answer = frame?.result
  if (!answer?.ok) throw new Error(answer?.error ?? 'The page did not answer.')
  return answer.result
}

const ACTS = new Set(['open', 'click', 'fill'])

/** What each request does. Each returns the answer's `result` or throws a sentence. */
const DO = {
  tabs: async () => (await chrome.tabs.query({})).map(tabOf),
  read: async ({ tabId }) => {
    const tab = await tabFor(tabId)
    const page = await inPage(tab, { do: 'read', args: {} })
    return { title: page.title || tab.title || '', url: page.url || tab.url || '', text: page.text ?? '', controls: page.controls ?? [] }
  },
  open: async ({ url, newTab }) => {
    let address
    try {
      address = new URL(url)
    } catch {
      throw new Error('That is not a web address.')
    }
    if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error('Only http and https addresses can be opened.')
    if (refusal(address.href)) throw new Error(refusal(address.href))
    const current = newTab === true ? undefined : await tabFor(undefined).catch(() => undefined)
    // The tab in front is replaced only when it is a web page Alexia could act on anyway.
    const tab = current && !refusal(current.url ?? '') ? await chrome.tabs.update(current.id, { url: address.href }) : await chrome.tabs.create({ url: address.href })
    return { tabId: tab.id, title: tab.title ?? '', url: tab.pendingUrl || tab.url || address.href }
  },
  click: async ({ tabId, ref, text }) => inPage(await tabFor(tabId), { do: 'click', args: ref !== undefined ? { ref } : { text } }),
  fill: async ({ tabId, ref, label, value }) => {
    await inPage(await tabFor(tabId), { do: 'fill', args: { ...(ref !== undefined ? { ref } : { label }), value } })
    return {}
  },
  focus: async ({ tabId }) => {
    const tab = await chrome.tabs.update(tabId, { active: true })
    await chrome.windows?.update(tab.windowId, { focused: true })
    return {}
  },
}

/**
 * One request from the plugin, `{ id, do, args }`, to its answer: `{ id, ok: true, result }` or
 * `{ id, ok: false, error: "<sentence>" }`. `act` is the owner's switch, read fresh each time.
 */
export async function answer(request, act) {
  const id = request?.id
  const what = request?.do
  try {
    if (!Object.hasOwn(DO, what)) throw new Error('The browser extension does not know how to do that.')
    if (ACTS.has(what) && act !== true) throw new Error(READ_ONLY)
    return { id, ok: true, result: await DO[what](request.args ?? {}) }
  } catch (error) {
    return { id, ok: false, error: String(error?.message || error) }
  }
}

// --- The connection ---------------------------------------------------------------------------

let ws
let attempts = 0
let retry
/** Set when Alexia refused the code or the extension: retrying would only be refused again. */
let parked = false

const status = (text) => chrome.storage.session.set({ status: text })

export async function connect() {
  clearTimeout(retry)
  retry = undefined
  if (ws && ws.readyState <= 1) return
  const { token, port } = await chrome.storage.local.get(['token', 'port'])
  if (!token || !Number.isInteger(port)) return status('Not set up: paste the code and the port from Alexia’s Browser settings.')
  status('Connecting…')
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  ws = socket
  let welcomed = false
  socket.onopen = () => socket.send(JSON.stringify(hello(token)))
  socket.onmessage = async (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!welcomed) {
      if (message?.ok !== true) return
      welcomed = true
      attempts = 0
      return status('Connected to Alexia.')
    }
    if (typeof message?.id !== 'number' || typeof message.do !== 'string') return
    const { act } = await chrome.storage.local.get('act')
    const reply = await answer(message, act)
    if (socket.readyState === 1) socket.send(JSON.stringify(reply))
  }
  socket.onclose = (event) => {
    if (ws !== socket) return
    ws = undefined
    // A refused code or a different extension will be refused again: wait for new settings.
    parked = event.code === 4001 || event.code === 4003
    if (event.code === 4001) return status('Alexia did not accept that code. Paste the code again from Alexia’s Browser settings.')
    if (event.code === 4003) return status('Alexia is already paired with another copy of this extension.')
    const wait = backoff(attempts++)
    status(`Alexia isn’t reachable. Trying again in ${Math.round(wait / 1000)} s.`)
    retry = setTimeout(connect, wait)
  }
}

/** New settings: drop the old connection and start again straight away. */
function restart() {
  attempts = 0
  parked = false
  const old = ws
  ws = undefined
  old?.close()
  return connect()
}

// Listeners at the top level, so Chrome finds them when it wakes the worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('token' in changes || 'port' in changes)) void restart()
})
// Every 25 s: a ping keeps the worker (and so the socket) alive; a worker that lost it reconnects.
chrome.alarms.create(PING, { periodInMinutes: 25 / 60 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PING) return
  if (ws?.readyState === 1) ws.send(JSON.stringify({ ping: 1 }))
  else if (!retry && !parked) void connect()
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.action?.onClicked.addListener(() => chrome.runtime.openOptionsPage())
void connect()
