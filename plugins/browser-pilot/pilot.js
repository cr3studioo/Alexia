// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema } from '@alexia/sdk'

/**
 * The plugin's side of the conversation with the extension: numbered requests, one answer each,
 * fifteen seconds to give it. And the tools, which turn the extension's answers into results —
 * keeping only the fields named here, so a cookie, or a value a password field already held,
 * has nowhere to ride along even if the extension sent one.
 */

export const REQUEST_MS = 15_000
export const MAX_TEXT = 200 * 1024
export const NOT_CONNECTED =
  "Alexia's browser extension isn't connected. Open the extension and paste the code from Alexia's Browser settings."
const TIMED_OUT = "The browser didn't answer within 15 seconds."
const DROPPED = 'The browser extension disconnected before it answered.'

/** A sentence out of the extension, kept short and never mistaken for data. */
const sentence = (error) => (typeof error === 'string' && error.trim() !== '' ? error.slice(0, 500) : 'The browser could not do that.')

export function createPilot({ timeoutMs = REQUEST_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let conn
  let next = 1
  const waiting = new Map()

  const settle = (id, outcome) => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    clearTimer(w.timer)
    if (outcome.ok) w.resolve(outcome.result)
    else w.reject(new Error(outcome.error))
  }

  return {
    get connected() {
      return conn !== undefined
    },
    /** A connection that passed the socket's gates. One at a time; the socket sees to that. */
    attach(c) {
      conn = c
      c.on('message', (m) => {
        if (typeof m?.id !== 'number' || typeof m.ok !== 'boolean') return
        settle(m.id, m.ok ? { ok: true, result: m.result ?? {} } : { ok: false, error: sentence(m.error) })
      })
      c.once('close', () => {
        if (conn !== c) return
        conn = undefined
        for (const id of [...waiting.keys()]) settle(id, { ok: false, error: DROPPED })
      })
    },
    /** Ask the extension; the answer's `result`, or an Error whose message is a sentence for the owner. */
    request(what, args = {}) {
      if (!conn) return Promise.reject(new Error(NOT_CONNECTED))
      const id = next++
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => settle(id, { ok: false, error: TIMED_OUT }), timeoutMs)
        waiting.set(id, { resolve, reject, timer })
        conn.send({ id, do: what, args })
      })
    },
  }
}

const str = (v) => (typeof v === 'string' ? v : undefined)
const num = (v) => (Number.isInteger(v) ? v : undefined)
const tabOf = (t) => ({ tabId: num(t?.tabId), title: str(t?.title) ?? '', url: str(t?.url) ?? '', active: t?.active === true })
/** Only what the spec names. A `value`, a `cookie`, anything else the extension adds, is left behind. */
const controlOf = (c) => ({ ref: str(c?.ref) ?? String(c?.ref ?? ''), role: str(c?.role) ?? '', name: str(c?.name) ?? '' })
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** At most `MAX_TEXT` bytes of UTF-8, cut on a character boundary. */
export function clip(text) {
  const b = Buffer.from(text)
  if (b.length <= MAX_TEXT) return text
  // A cut inside a character decodes to U+FFFD; dropping that leaves the whole characters.
  return b.subarray(0, MAX_TEXT).toString('utf8').replace(/�$/, '')
}

const ok = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const schema = (properties, required = []) =>
  fromJsonSchema({ type: 'object', properties, ...(required.length > 0 && { required }) })
const TAB = { type: 'integer', description: 'Which tab, from browser_tabs. The active tab when left out.' }

/**
 * Every tool, as `{ name, config, run(args) }`. `run` never throws: a failure is an `isError`
 * result with a sentence in it. index.js registers these; the tests call `run` directly.
 */
export function browserTools(pilot) {
  const ask = async (what, args, shape) => {
    try {
      return shape(await pilot.request(what, defined(args)))
    } catch (error) {
      return refuse(error.message)
    }
  }
  const bound = (cap, config) => ({ ...config, _meta: { 'alexia/provides': [cap] } })

  return [
    {
      name: 'browser_tabs',
      config: bound('browser.tabs', {
        description: "List the tabs open in the owner's browser: id, title, address, and which is active.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }),
      run: () =>
        ask('tabs', {}, (result) => {
          const tabs = (Array.isArray(result) ? result : Array.isArray(result?.tabs) ? result.tabs : []).map(tabOf)
          const lines = tabs.map((t) => `${t.tabId}${t.active ? ' (active)' : ''}: ${t.title} — ${t.url}`)
          return ok(lines.length > 0 ? lines.join('\n') : 'No tabs are open.', { tabs })
        }),
    },
    {
      name: 'browser_read',
      config: bound('browser.read', {
        description:
          "Read a page in the owner's browser as text, with the controls on it (each with a ref to click or fill by). The active tab unless tabId is given.",
        inputSchema: schema({ tabId: TAB }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      }),
      run: (args = {}) =>
        ask('read', { tabId: num(args.tabId) }, (result) => {
          const page = {
            title: str(result?.title) ?? '',
            url: str(result?.url) ?? '',
            text: clip(str(result?.text) ?? ''),
            controls: (Array.isArray(result?.controls) ? result.controls : []).map(controlOf),
          }
          const controls = page.controls.map((c) => `[${c.ref}] ${c.role} ${JSON.stringify(c.name)}`).join('\n')
          return ok(`${page.title}\n${page.url}\n\n${page.text}${controls ? `\n\nControls:\n${controls}` : ''}`, page)
        }),
    },
    {
      name: 'browser_open',
      config: bound('browser.open', {
        description: "Open a web address in the owner's browser, in the current tab or a new one.",
        inputSchema: schema(
          {
            url: { type: 'string', description: 'An http or https address.' },
            newTab: { type: 'boolean', description: 'Open it in a new tab.' },
          },
          ['url'],
        ),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }),
      run: (args = {}) => {
        // Only the web: a javascript:, file: or chrome: address does something else entirely.
        let url
        try {
          url = new URL(args.url)
        } catch {
          return refuse('That is not a web address.')
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse('Only http and https addresses can be opened.')
        return ask('open', { url: url.href, newTab: args.newTab === true ? true : undefined }, (result) => {
          const tab = defined({ tabId: num(result?.tabId), title: str(result?.title), url: str(result?.url) ?? url.href })
          return ok(`Opened ${tab.url}.`, tab)
        })
      },
    },
    {
      name: 'browser_click',
      config: bound('browser.click', {
        description:
          'Click a control on a page in the owner’s browser, by its ref from browser_read or by the text it shows.',
        inputSchema: schema({
          tabId: TAB,
          ref: { type: 'string', description: 'The control’s ref, from browser_read.' },
          text: { type: 'string', description: 'What the control says, when there is no ref.' },
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }),
      run: (args = {}) => {
        const by = str(args.ref) !== undefined ? { ref: args.ref } : str(args.text) !== undefined ? { text: args.text } : undefined
        if (!by) return refuse('Say which control: its ref from browser_read, or the text it shows.')
        return ask('click', { tabId: num(args.tabId), ...by }, (result) => {
          const after = defined({ clicked: true, title: str(result?.title), url: str(result?.url) })
          return ok(`Clicked${after.url ? `; the page is now ${after.url}` : ''}.`, after)
        })
      },
    },
    {
      name: 'browser_fill',
      config: bound('browser.fill', {
        description: 'Type a value into a field on a page in the owner’s browser, found by its ref from browser_read or by its label.',
        inputSchema: schema(
          {
            tabId: TAB,
            ref: { type: 'string', description: 'The field’s ref, from browser_read.' },
            label: { type: 'string', description: 'The field’s label, when there is no ref.' },
            value: { type: 'string', description: 'What to type.' },
          },
          ['value'],
        ),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }),
      run: (args = {}) => {
        const by = str(args.ref) !== undefined ? { ref: args.ref } : str(args.label) !== undefined ? { label: args.label } : undefined
        if (!by) return refuse('Say which field: its ref from browser_read, or its label.')
        if (typeof args.value !== 'string') return refuse('Say what to type.')
        // The answer is acknowledged, never echoed: what is in the field stays in the page.
        return ask('fill', { tabId: num(args.tabId), ...by, value: args.value }, () => ok('Filled.', { filled: true }))
      },
    },
    {
      name: 'browser_focus',
      config: {
        description: "Bring one of the owner's browser tabs to the front.",
        inputSchema: schema({ tabId: { type: 'integer', description: 'Which tab, from browser_tabs.' } }, ['tabId']),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      run: (args = {}) => {
        if (num(args.tabId) === undefined) return refuse('Say which tab, by its id from browser_tabs.')
        return ask('focus', { tabId: args.tabId }, () => ok('Done.', { focused: true }))
      },
    },
  ]
}
