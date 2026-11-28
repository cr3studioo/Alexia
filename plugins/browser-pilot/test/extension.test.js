// SPDX-License-Identifier: AGPL-3.0-only
/* global Event */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { assert, test } from './harness.js'

/**
 * The extension, without a browser: `content.js` runs in a `vm` context over a tiny fake
 * document, and `background.js` is imported over a fake `chrome` whose `scripting.executeScript`
 * runs that same `content.js` in the tab's own context — so a request goes the whole way through.
 */

const ext = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')
const CONTENT = readFileSync(join(ext, 'content.js'), 'utf8')

// --- A tiny DOM: elements, text nodes, a document with the few lookups content.js makes. ------

class El {
  constructor(tag, attrs = {}, children = [], props = {}) {
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.attrs = new Map(Object.entries(attrs))
    this.childNodes = children.map((c) => (typeof c === 'string' ? { nodeType: 3, nodeValue: c } : c))
    this.hidden = false
    this.clicks = 0
    this.events = []
    Object.assign(this, props)
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value))
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('')
  }
  set textContent(value) {
    this.childNodes = [{ nodeType: 3, nodeValue: value }]
  }
  click() {
    this.clicks++
  }
  dispatchEvent(event) {
    this.events.push(event.type)
  }
  remove() {}
}
const h = (tag, attrs, children, props) => new El(tag, attrs, children, props)
const CONTROL_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'])

function page(children, { title = 'A page', url = 'https://example.com/' } = {}) {
  const body = h('body', {}, children)
  const all = []
  const walk = (n) => {
    if (n.nodeType !== 1) return
    all.push(n)
    n.childNodes.forEach(walk)
  }
  walk(body)
  const appended = []
  return {
    title,
    location: { href: url },
    body,
    appended,
    documentElement: { appendChild: (el) => appended.push(el) },
    createElement: (tag) => h(tag),
    getElementById: (id) => all.find((e) => e.getAttribute('id') === id) ?? null,
    querySelectorAll: () => all.filter((e) => CONTROL_TAGS.has(e.tagName) || e.getAttribute('role')),
    querySelector: (selector) => {
      const m = /^\[data-alexia-ref="(.+)"\]$/.exec(selector)
      return m ? (all.find((e) => e.getAttribute('data-alexia-ref') === m[1]) ?? null) : null
    },
  }
}

/** content.js loaded into its own context over `doc`, as `executeScript({ files })` would. */
function inject(doc, ctx = vm.createContext({ document: doc, Event, setTimeout: () => 0 })) {
  vm.runInContext(CONTENT, ctx)
  return ctx
}
/**
 * The page's pilot, its answers passed through `structuredClone` as Chrome passes them out of the
 * page — which also brings them out of the vm's realm, so `deepEqual` compares them fairly.
 */
function pilotOn(doc) {
  const pilot = inject(doc).__alexiaPilot
  return { run: (request, d) => structuredClone(pilot.run(request, d)) }
}

// --- A fake chrome, then background.js on top of it. ------------------------------------------

const store = { local: {}, session: {} }
const area = (name) => ({
  get: async (keys) => {
    const wanted = keys === undefined ? Object.keys(store[name]) : [keys].flat()
    return Object.fromEntries(wanted.filter((k) => k in store[name]).map((k) => [k, store[name][k]]))
  },
  set: async (values) => void Object.assign(store[name], values),
})
const calls = { executeScript: [], create: [], update: [] }
let tabs = []

function tab(id, url, children = [], { active = false, title = `Tab ${id}` } = {}) {
  const doc = page(children, { title, url })
  return { id, url, title, active, windowId: 1, doc, ctx: vm.createContext({ document: doc, Event, setTimeout: () => 0 }) }
}

const listener = () => ({ addListener() {} })
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.1.0' }), onStartup: listener(), openOptionsPage() {} },
  storage: { local: area('local'), session: area('session'), onChanged: listener() },
  alarms: { create() {}, onAlarm: listener() },
  action: { onClicked: listener() },
  windows: { update: async () => ({}) },
  tabs: {
    query: async (q) => tabs.filter((t) => !q.active || t.active),
    get: async (id) => {
      const t = tabs.find((x) => x.id === id)
      if (!t) throw new Error(`No tab with id: ${id}.`)
      return t
    },
    update: async (id, props) => {
      calls.update.push({ id, ...props })
      return { ...tabs.find((t) => t.id === id), ...props }
    },
    create: async (props) => {
      calls.create.push(props)
      return { id: 99, title: '', url: '', pendingUrl: props.url }
    },
  },
  scripting: {
    executeScript: async ({ target, files, func, args = [] }) => {
      calls.executeScript.push({ tabId: target.tabId, files, func: func !== undefined })
      const t = tabs.find((x) => x.id === target.tabId)
      if (files) {
        assert.deepEqual(files, ['content.js'])
        inject(t.doc, t.ctx)
        return [{ result: undefined }]
      }
      // The function runs in the page's world, where `globalThis.__alexiaPilot` lives.
      return [{ result: structuredClone(vm.runInContext(`(${func})`, t.ctx)(...args)) }]
    },
  },
}
const reset = () => {
  calls.executeScript = []
  calls.create = []
  calls.update = []
}

const bg = await import(pathToFileURL(join(ext, 'background.js')).href)

// --- The tests. ------------------------------------------------------------------------------

test('manifest_is_mv3_minimal', () => {
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  // The four the spec names, and `alarms`, without which the 25-second keep-alive cannot exist.
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'scripting', 'storage', 'tabs'])
  assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
  for (const key of ['content_security_policy', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'optional_permissions', 'update_url']) {
    assert.equal(key in manifest, false, `manifest has ${key}`)
  }
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' })
  const named = [manifest.background.service_worker, manifest.options_ui.page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]
  for (const file of named) assert.ok(existsSync(join(ext, file)), `${file} is missing`)

  // No remote code, no other address than the loopback socket, nothing evaluated from a string.
  const scripts = readdirSync(ext).filter((f) => f.endsWith('.js') || f.endsWith('.html'))
  for (const file of scripts) {
    const text = readFileSync(join(ext, file), 'utf8')
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|importScripts|\beval\(|new Function|sendBeacon/, file)
    for (const address of text.match(/\b(?:https?|wss?):\/\/[^\s'"`]+/g) ?? []) assert.match(address, /^ws:\/\/127\.0\.0\.1:/, `${file} names ${address}`)
  }
  const html = readFileSync(join(ext, 'options.html'), 'utf8')
  for (const tag of html.match(/<script[^>]*>/g) ?? []) assert.match(tag, /src="options\.js"/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /read every page/)
})

test('find_by_text_unique_or_refuse', () => {
  const save = h('button', {}, ['Save'])
  const draft = h('button', {}, ['Save draft'])
  const cancel = h('button', {}, ['Cancel'])
  const deleteAccount = h('button', {}, ['Delete account'])
  const deleteItem = h('a', { href: '/x' }, ['delete item'])
  const hiddenOne = h('button', {}, ['Hidden thing'], { hidden: true })
  const email = h('input', { type: 'email', placeholder: 'Email' }, [], { type: 'email', value: '' })
  const doc = page([save, draft, cancel, deleteAccount, deleteItem, hiddenOne, email])
  const pilot = pilotOn(doc)
  const all = [save, draft, cancel, deleteAccount, deleteItem, hiddenOne]
  const clicked = () => all.filter((b) => b.clicks > 0)

  // Exact wins over "contains": "Save" is the Save button, not "Save draft".
  assert.deepEqual(pilot.run({ do: 'click', args: { text: 'Save' } }, doc), { ok: true, result: { title: 'A page', url: 'https://example.com/' } })
  assert.deepEqual(clicked(), [save])
  assert.equal(doc.appended.length, 1, 'the Alexia badge went up')
  assert.equal(doc.appended[0].textContent, 'Alexia')

  // Then case-insensitive contains, when it is unique.
  assert.equal(pilot.run({ do: 'click', args: { text: 'cancel' } }, doc).ok, true)
  assert.equal(cancel.clicks, 1)

  // Two match: refused, nothing clicked.
  save.clicks = cancel.clicks = 0
  const two = pilot.run({ do: 'click', args: { text: 'DELETE' } }, doc)
  assert.equal(two.ok, false)
  assert.match(two.error, /2 controls .*match "DELETE"/)
  assert.deepEqual(clicked(), [])

  // None match, and a hidden control is not a candidate.
  assert.match(pilot.run({ do: 'click', args: { text: 'Hidden thing' } }, doc).error, /No control/)
  assert.equal(hiddenOne.clicks, 0)

  // By ref, from a read; a ref that is not ours is refused rather than used as a selector.
  const read = pilot.run({ do: 'read', args: {} }, doc)
  const ref = read.result.controls.find((c) => c.name === 'Save draft').ref
  assert.equal(pilot.run({ do: 'click', args: { ref } }, doc).ok, true)
  assert.deepEqual(clicked(), [draft])
  assert.equal(pilot.run({ do: 'read', args: {} }, doc).result.controls.find((c) => c.name === 'Save draft').ref, ref, 'refs stay put')
  assert.match(pilot.run({ do: 'click', args: { ref: '"] , button' } }, doc).error, /no control with ref/)

  // Fill finds by label among fields only: "Email" is the field, not a button.
  const filled = pilot.run({ do: 'fill', args: { label: 'email', value: 'me@example.com' } }, doc)
  assert.deepEqual(filled, { ok: true, result: {} })
  assert.equal(email.value, 'me@example.com')
  assert.deepEqual(email.events, ['input', 'change'])
  assert.match(pilot.run({ do: 'fill', args: { ref, value: 'x' } }, doc).error, /can't be typed into/)
})

test('password_values_skipped', () => {
  const secret = ['hunter', '2-very-secret'].join('')
  const typed = ['typed', '-by-owner'].join('')
  const label = h('label', { for: 'pw' }, ['Password'])
  const pw = h('input', { type: 'password', id: 'pw' }, [], { type: 'password', value: secret, labels: [label] })
  const bare = h('input', { type: 'password', name: 'pin' }, [], { type: 'password', value: secret })
  const user = h('input', { type: 'text', placeholder: 'User name' }, [], { type: 'text', value: typed })
  const notes = h('textarea', { 'aria-label': 'Notes' }, [typed], { value: typed })
  const go = h('input', { type: 'submit' }, [], { type: 'submit', value: 'Sign in' })
  const doc = page([h('h1', {}, ['Welcome back']), h('form', {}, [label, pw, bare, user, notes, go])])

  const read = pilotOn(doc).run({ do: 'read', args: {} }, doc)
  assert.equal(read.ok, true)
  const everything = JSON.stringify(read.result)
  assert.equal(everything.includes(secret), false, 'a password value leaked')
  assert.equal(everything.includes(typed), false, 'a field value leaked')
  assert.match(read.result.text, /Welcome back/)
  assert.deepEqual(
    read.result.controls.map(({ role, name }) => ({ role, name })),
    [
      { role: 'textbox', name: 'Password' },
      { role: 'textbox', name: 'pin' },
      { role: 'textbox', name: 'User name' },
      { role: 'textbox', name: 'Notes' },
      { role: 'button', name: 'Sign in' },
    ],
  )
  for (const c of read.result.controls) assert.deepEqual(Object.keys(c).sort(), ['name', 'ref', 'role'])
})

test('act_switch_off_refuses', async () => {
  const button = h('button', {}, ['Buy now'])
  tabs = [tab(1, 'https://shop.example/', [button], { active: true })]
  for (const request of [
    { id: 1, do: 'click', args: { text: 'Buy now' } },
    { id: 2, do: 'fill', args: { label: 'Card', value: '4' } },
    { id: 3, do: 'open', args: { url: 'https://example.com/' } },
  ]) {
    reset()
    const reply = await bg.answer(request, false)
    assert.equal(reply.id, request.id)
    assert.equal(reply.ok, false)
    assert.match(reply.error, /only read/)
    assert.deepEqual(calls, { executeScript: [], create: [], update: [] }, `${request.do} reached the browser`)
  }
  assert.equal(button.clicks, 0)
  // Undefined (never set) is off too.
  assert.equal((await bg.answer({ id: 4, do: 'click', args: { text: 'Buy now' } }, undefined)).ok, false)

  // Reading is still allowed; switched on, the click goes through to the page.
  assert.equal((await bg.answer({ id: 5, do: 'read', args: {} }, false)).ok, true)
  assert.equal((await bg.answer({ id: 6, do: 'click', args: { text: 'Buy now' } }, true)).ok, true)
  assert.equal(button.clicks, 1)
})

test('protocol_answers_shape', async () => {
  tabs = [
    tab(7, 'https://news.example/', [h('p', {}, ['Hello there']), h('a', { href: '/more' }, ['More'])], { active: true, title: 'News' }),
    tab(8, 'https://mail.example/', [], { title: 'Mail' }),
  ]
  assert.deepEqual(await bg.answer({ id: 1, do: 'tabs', args: {} }, false), {
    id: 1,
    ok: true,
    result: [
      { tabId: 7, title: 'News', url: 'https://news.example/', active: true },
      { tabId: 8, title: 'Mail', url: 'https://mail.example/', active: false },
    ],
  })
  const read = await bg.answer({ id: 2, do: 'read', args: { tabId: 7 } }, false)
  assert.deepEqual(read, {
    id: 2,
    ok: true,
    result: { title: 'News', url: 'https://news.example/', text: 'Hello there\nMore', controls: [{ ref: 'e1', role: 'link', name: 'More' }] },
  })
  reset()
  const opened = await bg.answer({ id: 3, do: 'open', args: { url: 'https://example.org/a', newTab: true } }, true)
  assert.deepEqual(opened, { id: 3, ok: true, result: { tabId: 99, title: '', url: 'https://example.org/a' } })
  assert.deepEqual(calls.create, [{ url: 'https://example.org/a' }])
  assert.deepEqual(await bg.answer({ id: 4, do: 'focus', args: { tabId: 8 } }, false), { id: 4, ok: true, result: {} })
  for (const bad of [{ id: 5, do: 'cookies', args: {} }, { id: 6, do: 'toString', args: {} }, { id: 7, do: 'read', args: { tabId: 404 } }]) {
    const reply = await bg.answer(bad, true)
    assert.deepEqual(Object.keys(reply).sort(), ['error', 'id', 'ok'])
    assert.equal(reply.id, bad.id)
    assert.equal(reply.ok, false)
    assert.equal(typeof reply.error, 'string')
  }

  assert.deepEqual([0, 1, 2, 4, 5, 6, 20].map(bg.backoff), [1000, 2000, 4000, 16000, 30000, 30000, 30000])

  // The socket itself: hello first, then {"ok":true}, then a request answered on the same socket.
  class FakeSocket {
    static all = []
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      FakeSocket.all.push(this)
    }
    send(text) {
      this.sent.push(JSON.parse(text))
    }
    close() {
      this.readyState = 3
    }
  }
  const realSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket
  try {
    const code = ['test', 'code'].join('-')
    store.local = { token: code, port: 4567, act: false }
    await bg.connect()
    const socket = FakeSocket.all.at(-1)
    assert.equal(socket.url, 'ws://127.0.0.1:4567')
    socket.readyState = 1
    socket.onopen()
    assert.deepEqual(socket.sent, [{ hello: 1, token: code, browser: 'chrome', version: '0.1.0' }])
    await socket.onmessage({ data: '{"id":1,"do":"tabs","args":{}}' })
    assert.equal(socket.sent.length, 1, 'a request before the welcome is ignored')
    await socket.onmessage({ data: '{"ok":true}' })
    assert.match(store.session.status, /Connected/)
    await socket.onmessage({ data: '{"id":9,"do":"tabs","args":{}}' })
    assert.deepEqual(socket.sent[1], { id: 9, ok: true, result: (await bg.answer({ id: 9, do: 'tabs' })).result })
    await socket.onmessage({ data: '{"id":10,"do":"click","args":{"text":"More"}}' })
    assert.equal(socket.sent[2].ok, false, 'the stored switch is off')
  } finally {
    globalThis.WebSocket = realSocket
  }
})

test('refuses_chrome_pages', async () => {
  for (const url of [
    'chrome://settings/',
    'edge://extensions/',
    'about:blank',
    'chrome-extension://abcdefghijklmnop/options.html',
    'extension://abcdefghijklmnop/options.html',
    'view-source:https://example.com/',
    'file:///C:/Users/owner/notes.txt',
    'https://chromewebstore.google.com/detail/some-extension/abc',
    'https://chrome.google.com/webstore/detail/abc',
    'https://microsoftedge.microsoft.com/addons/detail/abc',
    '',
  ]) {
    assert.equal(typeof bg.refusal(url), 'string', `${url} was allowed`)
  }
  for (const url of ['https://example.com/', 'http://localhost:3000/', 'https://chrome.google.com/search']) assert.equal(bg.refusal(url), undefined, url)

  const button = h('button', {}, ['Remove'])
  tabs = [tab(1, 'chrome://extensions/', [button], { active: true }), tab(2, 'https://chromewebstore.google.com/detail/x', [button])]
  reset()
  for (const request of [
    { id: 1, do: 'read', args: {} },
    { id: 2, do: 'click', args: { text: 'Remove' } },
    { id: 3, do: 'fill', args: { tabId: 2, label: 'Search', value: 'x' } },
    { id: 4, do: 'open', args: { url: 'https://chromewebstore.google.com/detail/x' } },
  ]) {
    const reply = await bg.answer(request, true)
    assert.equal(reply.ok, false, `${request.do} went through`)
  }
  assert.deepEqual(calls, { executeScript: [], create: [], update: [] })
  assert.equal(button.clicks, 0)

  // Opening a page while a browser page is in front puts it in a new tab, never over that page.
  const opened = await bg.answer({ id: 5, do: 'open', args: { url: 'https://example.com/' } }, true)
  assert.equal(opened.ok, true)
  assert.deepEqual(calls.create, [{ url: 'https://example.com/' }])
  assert.deepEqual(calls.update, [])
})
