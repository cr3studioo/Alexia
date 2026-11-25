// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { APPROVAL_MS, listRequest, NEEDS_YES, sendMailRequest } from '../mail.js'
import { fakeMicrosoft, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { RECONNECT, sendTools, service, tools } = await import('../index.js')

const NOW = Date.parse('2030-03-04T09:00:00Z')

/** A token shaped the way the mail desk's `send_draft` makes one, issued at `at`. */
const tokenAt = (at) => `${at}.${randomBytes(24).toString('base64url')}`

/**
 * The mail desk's half, played by a fake: `approve(token, message)` makes a yes for that exact
 * message, and `mail.approval` confirms it once. Every question it was asked is recorded.
 */
function fakeDesk() {
  const yeses = new Map()
  const asked = []
  const capability = async (cap, args) => {
    asked.push({ cap, args })
    if (cap !== 'mail.approval') throw new Error(`unexpected capability ${cap}`)
    const want = yeses.get(args.token)
    yeses.delete(args.token)
    const approved = want !== undefined && want.to === args.to && want.subject === args.subject && want.text === args.text && want.replyTo === args.replyTo
    return { content: [{ type: 'text', text: approved ? 'yes' : 'no' }], structuredContent: { approved } }
  }
  return { capability, asked, approve: (token, message) => yeses.set(token, message) }
}

/** Graph accepting sends the way it does: `202`, no body. */
const graph = (status = 202) =>
  fakeMicrosoft((url, init) => {
    if (!url.startsWith('https://graph.microsoft.com') || init.method !== 'POST') return undefined
    return status === 202 ? { status: 204 } : { status, json: { error: { code: 'ErrorAccessDenied' } } }
  })

const sends = (ms) => ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com') && c.method === 'POST')

function setup({ clock = () => NOW, status } = {}) {
  const ms = graph(status)
  const desk = fakeDesk()
  const lines = []
  const svc = service({ ...settingsOf(ms), keep: async () => {}, status: async (l) => void lines.push(l), capability: desk.capability, fetch: ms.fetch, clock })
  return { ms, desk, svc, lines }
}

const message = { to: 'Jana Nová <jana@example.cz>, petr@example.com', subject: 'Oběd', text: 'Ahoj,\nve čtvrtek to platí.' }

describe('mail.send', () => {
  test('refuses_without_token', async () => {
    const { ms, desk, svc } = setup()
    for (const approved_draft of [undefined, '', 'yes', `${NOW}.tooshort`, { token: 'x' }]) {
      const result = await svc.mailSend({ ...message, ...(approved_draft !== undefined && { approved_draft }) })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe(NEEDS_YES)
    }
    // Well shaped, but the desk never made it.
    expect((await svc.mailSend({ ...message, approved_draft: tokenAt(NOW) })).content[0].text).toBe(NEEDS_YES)
    // A yes for another recipient does not cover this one.
    const other = tokenAt(NOW)
    desk.approve(other, { ...message, to: 'someone@else.example' })
    expect((await svc.mailSend({ ...message, approved_draft: other })).content[0].text).toBe(NEEDS_YES)
    expect(sends(ms)).toEqual([])
    expect(desk.asked.length).toBe(2)
  })

  test('sends_with_token_once', async () => {
    const { ms, desk, svc } = setup()
    const token = tokenAt(NOW - 2_000)
    desk.approve(token, message)
    const sent = await svc.mailSend({ ...message, approved_draft: token })
    expect(sent.isError).toBeUndefined()
    expect(sent.content[0].text).toBe('Sent to jana@example.cz, petr@example.com.')

    const [post] = sends(ms)
    expect(post.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(JSON.parse(post.body)).toEqual({
      message: {
        subject: 'Oběd',
        body: { contentType: 'Text', content: message.text },
        toRecipients: [{ emailAddress: { address: 'jana@example.cz' } }, { emailAddress: { address: 'petr@example.com' } }],
      },
      saveToSentItems: true,
    })
    // Straight out, never by way of Drafts.
    expect(ms.calls.some((c) => /\/(drafts|createReply|messages)$/i.test(new URL(c.url).pathname) && c.method === 'POST')).toBe(false)

    desk.approve(token, message)
    const again = await svc.mailSend({ ...message, approved_draft: token })
    expect(again.isError).toBe(true)
    expect(again.content[0].text).toContain(NEEDS_YES)
    expect(sends(ms).length).toBe(1)
    expect(desk.asked.length).toBe(1)

    // A reply goes to /reply, so Outlook threads it.
    const reply = tokenAt(NOW)
    const answer = { ...message, replyTo: 'AAMk1=' }
    desk.approve(reply, answer)
    expect((await svc.mailSend({ ...answer, approved_draft: reply })).isError).toBeUndefined()
    const second = sends(ms)[1]
    expect(second.url).toBe(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent('AAMk1=')}/reply`)
    expect(JSON.parse(second.body)).toEqual({ message: { toRecipients: [{ emailAddress: { address: 'jana@example.cz' } }, { emailAddress: { address: 'petr@example.com' } }] }, comment: message.text })
  })

  test('token_expires', async () => {
    let now = NOW
    const { ms, desk, svc } = setup({ clock: () => now })
    const token = tokenAt(NOW)
    desk.approve(token, message)
    now = NOW + APPROVAL_MS + 1
    const late = await svc.mailSend({ ...message, approved_draft: token })
    expect(late.isError).toBe(true)
    expect(late.content[0].text).toContain('ran out')
    expect(late.content[0].text).toContain(NEEDS_YES)
    expect(desk.asked).toEqual([])
    expect(sends(ms)).toEqual([])

    const fresh = tokenAt(now - APPROVAL_MS + 1_000)
    desk.approve(fresh, message)
    expect((await svc.mailSend({ ...message, approved_draft: fresh })).isError).toBeUndefined()
    const ahead = tokenAt(now + 60_000)
    desk.approve(ahead, message)
    expect((await svc.mailSend({ ...message, approved_draft: ahead })).content[0].text).toBe(NEEDS_YES)
    expect(sends(ms).length).toBe(1)
  })

  test('annotations_open_world_and_destructive', () => {
    const svc = service({ settings: async () => ({}), keep: async () => {} })
    const all = [...tools(svc), ...sendTools(svc)]
    const senders = all.filter(([, c]) => c._meta?.['alexia/provides']?.includes('mail.send'))
    expect(senders.map(([name]) => name)).toEqual(['mail_send'])
    const [[, config]] = senders
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    for (const [name, c] of all) if (name !== 'mail_send') expect(c.annotations.destructiveHint, name).toBe(false)
  })

  test('a sign-in without Mail.Send says to reconnect', async () => {
    const { desk, svc, lines } = setup({ status: 403 })
    const token = tokenAt(NOW)
    desk.approve(token, message)
    const result = await svc.mailSend({ ...message, approved_draft: token })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(RECONNECT)
    expect(lines).toContain(`▲ ${RECONNECT}`)
    await svc.report()
    expect(lines.at(-1)).toBe(`▲ ${RECONNECT}`)
  })

  test('the sent sample reads Sent Items, up to 200', async () => {
    const req = listRequest({ query: 'in:sent', limit: 500 })
    const url = new URL(req.url)
    expect(url.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages')
    expect(url.searchParams.get('$top')).toBe('200')
    expect(url.searchParams.has('$search')).toBe(false)
    expect(new URL(listRequest({ query: 'in:sent from:me' }).url).searchParams.get('$search')).toBe('"from:me"')
    expect(new URL(listRequest({ query: 'invoice', limit: 500 }).url).searchParams.get('$top')).toBe('50')

    const ms = fakeMicrosoft((u) =>
      u.includes('/me/messages/m9') ?
        { status: 200, json: { id: 'm9', subject: 'Oběd', conversationId: 'c9', from: { emailAddress: { name: 'Jana', address: 'jana@example.cz' } }, toRecipients: [], replyTo: [], body: { contentType: 'text', content: 'Ahoj' } } }
      : undefined,
    )
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    return Promise.all([svc.mailRead({ id: 'm9' }), svc.mailRead({ id: 'm9', headers: true })]).then(([plain, withHeaders]) => {
      expect(plain.structuredContent).toEqual({ text: 'Ahoj' })
      expect(withHeaders.structuredContent).toEqual({ text: 'Ahoj', from: 'Jana <jana@example.cz>', to: '', subject: 'Oběd', threadId: 'c9' })
    })
  })

  test('headers cannot be smuggled in', () => {
    expect(() => sendMailRequest({ to: 'a@example.com\nb@example.com', subject: 's', text: 't' })).toThrow()
    expect(() => sendMailRequest({ to: 'a@example.com', subject: 's\r\nX: y', text: 't' })).toThrow()
    expect(() => sendMailRequest({ to: '', subject: 's', text: 't' })).toThrow()
  })
})
