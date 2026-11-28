// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { MAX_TEXT, NOT_CONNECTED, REQUEST_MS, browserTools, clip, createPilot } from '../pilot.js'
import { assert, test } from './harness.js'

/**
 * A fake extension: records every request the plugin sends and answers it with `answer(request)`.
 * `answer` returning undefined leaves the request unanswered.
 */
function fakeExtension(answer) {
  const ext = new EventEmitter()
  ext.requests = []
  ext.send = (request) => {
    ext.requests.push(request)
    const reply = answer(request)
    if (reply !== undefined) void Promise.resolve().then(() => ext.emit('message', { id: request.id, ...reply }))
    return true
  }
  return ext
}

/** A pilot with that extension attached, and its tools by name. */
function setup(answer, options) {
  const pilot = createPilot(options)
  const ext = fakeExtension(answer)
  pilot.attach(ext)
  const tools = Object.fromEntries(browserTools(pilot).map((t) => [t.name, t]))
  return { pilot, ext, tools }
}

const text = (result) => result.content.map((c) => c.text).join('\n')

test('tabs: request shape and result mapping', async () => {
  const { ext, tools } = setup(() => ({
    ok: true,
    result: [
      { tabId: 3, title: 'Mail', url: 'https://mail.example/', active: true, cookies: 'sid=1' },
      { tabId: 4, title: 'News', url: 'https://news.example/', active: false },
    ],
  }))
  const result = await tools.browser_tabs.run()
  assert.deepEqual(ext.requests, [{ id: 1, do: 'tabs', args: {} }])
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent.tabs, [
    { tabId: 3, title: 'Mail', url: 'https://mail.example/', active: true },
    { tabId: 4, title: 'News', url: 'https://news.example/', active: false },
  ])
  assert.match(text(result), /3 \(active\): Mail — https:\/\/mail\.example\//)
})

test('read: request shape, active tab by default, text clipped to 200 KB, controls kept to ref/role/name', async () => {
  const long = 'é'.repeat(MAX_TEXT) // two bytes each, so twice the limit
  const { ext, tools } = setup(() => ({
    ok: true,
    result: { title: 'Form', url: 'https://x.example/f', text: long, controls: [{ ref: 'c1', role: 'button', name: 'Send' }] },
  }))
  const active = await tools.browser_read.run({})
  assert.deepEqual(ext.requests[0], { id: 1, do: 'read', args: {} })
  assert.equal(Buffer.byteLength(active.structuredContent.text), MAX_TEXT)
  assert.deepEqual(active.structuredContent.controls, [{ ref: 'c1', role: 'button', name: 'Send' }])
  assert.match(text(active), /\[c1\] button "Send"/)

  await tools.browser_read.run({ tabId: 7 })
  assert.deepEqual(ext.requests[1], { id: 2, do: 'read', args: { tabId: 7 } })
  // A cut never leaves half a character.
  assert.equal(clip('a' + 'é'.repeat(MAX_TEXT)).endsWith('é'), true)
  assert.equal(clip('short'), 'short')
})

test('open: request shape, only http and https', async () => {
  const { ext, tools } = setup((r) => ({ ok: true, result: { tabId: 9, url: r.args.url, title: 'Hi' } }))
  const result = await tools.browser_open.run({ url: 'https://example.com/a', newTab: true })
  assert.deepEqual(ext.requests[0], { id: 1, do: 'open', args: { url: 'https://example.com/a', newTab: true } })
  assert.deepEqual(result.structuredContent, { tabId: 9, title: 'Hi', url: 'https://example.com/a' })

  await tools.browser_open.run({ url: 'http://example.com/' })
  assert.deepEqual(ext.requests[1].args, { url: 'http://example.com/' })

  for (const url of ['javascript:alert(1)', 'file:///C:/secret.txt', 'chrome://settings', 'not a url']) {
    const refused = await tools.browser_open.run({ url })
    assert.equal(refused.isError, true, url)
  }
  assert.equal(ext.requests.length, 2)
})

test('click: by ref or by text, tab passed through', async () => {
  const { ext, tools } = setup(() => ({ ok: true, result: { url: 'https://x.example/next', title: 'Next' } }))
  const byRef = await tools.browser_click.run({ ref: 'c4', tabId: 2 })
  assert.deepEqual(ext.requests[0], { id: 1, do: 'click', args: { tabId: 2, ref: 'c4' } })
  assert.deepEqual(byRef.structuredContent, { clicked: true, title: 'Next', url: 'https://x.example/next' })
  await tools.browser_click.run({ text: 'Sign in' })
  assert.deepEqual(ext.requests[1], { id: 2, do: 'click', args: { text: 'Sign in' } })
  assert.equal((await tools.browser_click.run({})).isError, true)
  assert.equal(ext.requests.length, 2)
})

test('fill: by ref or label, value sent, result only acknowledges', async () => {
  const { ext, tools } = setup((r) => ({ ok: true, result: { value: r.args.value } }))
  const result = await tools.browser_fill.run({ label: 'Email', value: 'me@example.com' })
  assert.deepEqual(ext.requests[0], { id: 1, do: 'fill', args: { label: 'Email', value: 'me@example.com' } })
  assert.deepEqual(result.structuredContent, { filled: true })
  await tools.browser_fill.run({ ref: 'c2', value: 'x', tabId: 5 })
  assert.deepEqual(ext.requests[1], { id: 2, do: 'fill', args: { tabId: 5, ref: 'c2', value: 'x' } })
  assert.equal((await tools.browser_fill.run({ value: 'x' })).isError, true)
  assert.equal((await tools.browser_fill.run({ ref: 'c2' })).isError, true)
})

test('focus: request shape', async () => {
  const { ext, tools } = setup(() => ({ ok: true, result: {} }))
  const result = await tools.browser_focus.run({ tabId: 3 })
  assert.deepEqual(ext.requests[0], { id: 1, do: 'focus', args: { tabId: 3 } })
  assert.deepEqual(result.structuredContent, { focused: true })
  assert.equal((await tools.browser_focus.run({})).isError, true)
})

test('an extension error is the sentence, as isError', async () => {
  const { tools } = setup(() => ({ ok: false, error: 'No control says “Buy”.' }))
  const result = await tools.browser_click.run({ text: 'Buy' })
  assert.equal(result.isError, true)
  assert.equal(text(result), 'No control says “Buy”.')
})

test('password_values_never_returned', async () => {
  // Built at runtime so no file holds it whole.
  const secret = ['hunter', '2-', 'pw'].join('')
  const cookie = ['sid=', 'abc', '123'].join('')
  const { tools } = setup((r) => {
    if (r.do === 'read') {
      return {
        ok: true,
        result: {
          title: 'Login',
          url: 'https://bank.example/',
          text: 'Sign in',
          cookies: cookie,
          controls: [
            { ref: 'p1', role: 'textbox', name: 'Password', type: 'password', value: secret },
            { ref: 'u1', role: 'textbox', name: 'User', value: 'me' },
          ],
        },
      }
    }
    if (r.do === 'tabs') return { ok: true, result: [{ tabId: 1, title: 'Login', url: 'https://bank.example/', active: true, cookie }] }
    return { ok: true, result: { value: secret, cookie } }
  })
  const results = [
    await tools.browser_read.run({}),
    await tools.browser_tabs.run(),
    await tools.browser_fill.run({ ref: 'p1', value: secret }),
    await tools.browser_click.run({ ref: 'p1' }),
  ]
  for (const result of results) {
    const all = JSON.stringify(result)
    assert.ok(!all.includes(secret), all)
    assert.ok(!all.includes(cookie), all)
  }
  assert.deepEqual(results[0].structuredContent.controls[0], { ref: 'p1', role: 'textbox', name: 'Password' })
})

test('no_extension_sentence', async () => {
  const tools = Object.fromEntries(browserTools(createPilot()).map((t) => [t.name, t]))
  const calls = {
    browser_tabs: {},
    browser_read: {},
    browser_open: { url: 'https://example.com' },
    browser_click: { ref: 'c1' },
    browser_fill: { ref: 'c1', value: 'x' },
    browser_focus: { tabId: 1 },
  }
  for (const [name, args] of Object.entries(calls)) {
    const result = await tools[name].run(args)
    assert.equal(result.isError, true, name)
    assert.equal(text(result), NOT_CONNECTED)
  }
  assert.equal(
    NOT_CONNECTED,
    "Alexia's browser extension isn't connected. Open the extension and paste the code from Alexia's Browser settings.",
  )
})

test('a disconnect fails what was waiting, and later calls say it is not connected', async () => {
  const { ext, tools } = setup(() => undefined)
  const waiting = tools.browser_tabs.run()
  await Promise.resolve()
  ext.emit('close', { code: 1006, reason: '' })
  assert.match(text(await waiting), /disconnected/)
  assert.equal(text(await tools.browser_tabs.run()), NOT_CONNECTED)
})

test('request_timeout_15s', async () => {
  assert.equal(REQUEST_MS, 15_000)
  const timers = []
  const cleared = []
  const { ext, tools } = setup(() => undefined, {
    setTimer: (fire, ms) => (timers.push({ fire, ms }), timers.length),
    clearTimer: (t) => cleared.push(t),
  })
  const waiting = tools.browser_read.run({})
  await Promise.resolve()
  assert.equal(ext.requests.length, 1)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 15_000)
  timers[0].fire()
  const result = await waiting
  assert.equal(result.isError, true)
  assert.equal(text(result), "The browser didn't answer within 15 seconds.")
  // A late answer after the timeout is dropped, not delivered to anyone.
  ext.emit('message', { id: 1, ok: true, result: {} })

  // An answer in time clears its timer.
  const quick = setup(() => ({ ok: true, result: [] }), {
    setTimer: () => 42,
    clearTimer: (t) => cleared.push(t),
  })
  await quick.tools.browser_tabs.run()
  assert.ok(cleared.includes(42))
})
