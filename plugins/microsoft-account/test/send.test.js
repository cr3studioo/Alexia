// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { askToSend, listRequest, NOT_SENT, REPLY_QUOTES, sendMailRequest } from '../mail.js'
import { fakeMicrosoft, settingsOf } from './fake.js'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ALEXIA_PLUGIN_DIR = join(here, '..')
const { RECONNECT, sendTools, service, tools } = await import('../index.js')

const NOW = Date.parse('2030-03-04T09:00:00Z')

/**
 * The owner, played by a fake host: `answer(params)` is what they do with the question (an MCP
 * `elicitation/create` result, a throw, or a promise that never settles). Every question asked
 * is recorded with its options.
 */
function owner(answer) {
  const asked = []
  const elicit = async (params, options) => {
    asked.push({ params, options })
    return typeof answer === 'function' ? answer(params) : answer
  }
  return { elicit, asked }
}

const YES = { action: 'accept', content: { send: true } }

/** Graph accepting sends the way it does: `202`, no body. */
const graph = (status = 202) =>
  fakeMicrosoft((url, init) => {
    if (!url.startsWith('https://graph.microsoft.com') || init.method !== 'POST') return undefined
    return status === 202 ? { status: 204 } : { status, json: { error: { code: 'ErrorAccessDenied' } } }
  })

const sends = (ms) => ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com') && c.method === 'POST')

function setup({ answer = YES, elicit, askMs, status } = {}) {
  const ms = graph(status)
  const host = owner(answer)
  const lines = []
  const svc = service({
    ...settingsOf(ms),
    keep: async () => {},
    status: async (l) => void lines.push(l),
    elicit: elicit === undefined ? host.elicit : elicit === null ? undefined : elicit,
    fetch: ms.fetch,
    clock: () => NOW,
    ...(askMs !== undefined && { askMs }),
  })
  return { ms, host, svc, lines }
}

const message = { to: 'Jana Nová <jana@example.cz>, petr@example.com', subject: 'Oběd', text: 'Ahoj,\nve čtvrtek to platí.' }
const RECIPIENTS = [{ emailAddress: { address: 'jana@example.cz' } }, { emailAddress: { address: 'petr@example.com' } }]

describe('mail.send', () => {
  test('sends exactly the message the owner was shown, on their yes', async () => {
    const { ms, host, svc } = setup()
    const sent = await svc.mailSend(message)
    expect(sent.isError).toBeUndefined()
    expect(sent.structuredContent).toEqual({ sent: true, id: '' })
    expect(sent.content[0].text).toBe('Sent to jana@example.cz, petr@example.com.')

    expect(host.asked.length).toBe(1)
    const [{ params, options }] = host.asked
    expect(params.mode).toBe('form')
    expect(params.message).toBe('Send this email now?\n\nTo: jana@example.cz, petr@example.com\nSubject: Oběd\n\nAhoj,\nve čtvrtek to platí.')
    expect(params.requestedSchema.required).toEqual(['send'])
    expect(options.timeout).toBeGreaterThan(0)

    const [post] = sends(ms)
    expect(post.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(JSON.parse(post.body)).toEqual({
      message: { subject: 'Oběd', body: { contentType: 'Text', content: message.text }, toRecipients: RECIPIENTS },
      saveToSentItems: true,
    })
    // Straight out, never by way of Drafts.
    expect(ms.calls.some((c) => /\/(drafts|createReply|messages)$/i.test(new URL(c.url).pathname) && c.method === 'POST')).toBe(false)
  })

  test('a reply sends what was shown, and says Outlook quotes the original', async () => {
    const { ms, host, svc } = setup()
    const answer = { ...message, subject: 'Re: Oběd', replyTo: 'AAMk1=' }
    expect((await svc.mailSend(answer)).isError).toBeUndefined()
    // The question names the one part the owner does not see written out: Graph's quote.
    expect(host.asked[0].params.message).toBe(`Send this email now?\n\nTo: jana@example.cz, petr@example.com\nSubject: Re: Oběd\n\nAhoj,\nve čtvrtek to platí.\n\n${REPLY_QUOTES}`)
    const [post] = sends(ms)
    expect(post.url).toBe(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent('AAMk1=')}/reply`)
    // The shown recipients and subject, and the shown text as the comment.
    expect(JSON.parse(post.body)).toEqual({ message: { subject: 'Re: Oběd', toRecipients: RECIPIENTS }, comment: message.text })
    // A new message says nothing about a quote, because there is none.
    await svc.mailSend(message)
    expect(host.asked[1].params.message).not.toContain(REPLY_QUOTES)
  })

  test('decline, cancel and a yes-less accept send nothing', async () => {
    for (const [answer, reason] of [
      [{ action: 'decline' }, 'no'],
      [{ action: 'accept', content: { send: false } }, 'no'],
      [{ action: 'accept', content: { send: 'true' } }, 'no'],
      [{ action: 'accept' }, 'no'],
      [{ action: 'cancel' }, 'cancel'],
      [null, 'unavailable'],
    ]) {
      const { ms, host, svc } = setup({ answer })
      const result = await svc.mailSend(message)
      expect(result.isError, JSON.stringify(answer)).toBe(true)
      expect(result.structuredContent).toEqual({ sent: false, reason })
      expect(result.content[0].text).toBe(NOT_SENT[reason])
      expect(host.asked.length).toBe(1)
      expect(sends(ms)).toEqual([])
    }
  })

  test('no answer in time sends nothing, even if a yes comes later', async () => {
    const timedOut = setup({ answer: () => Promise.reject(Object.assign(new Error('Request timed out'), { code: -32001 })) })
    const first = await timedOut.svc.mailSend(message)
    expect(first.structuredContent).toEqual({ sent: false, reason: 'timeout' })
    expect(first.content[0].text).toBe(NOT_SENT.timeout)
    expect(sends(timedOut.ms)).toEqual([])

    let late
    const silent = setup({ answer: () => new Promise((resolve) => (late = resolve)), askMs: 50 })
    const second = await silent.svc.mailSend(message)
    expect(second.structuredContent).toEqual({ sent: false, reason: 'timeout' })
    late(YES)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sends(silent.ms)).toEqual([])
  })

  test('a host that offers no elicitation sends nothing', async () => {
    const refuse = async () => {
      throw Object.assign(new Error('Client does not support form elicitation.'), { code: 'CapabilityNotSupported' })
    }
    for (const elicit of [null, refuse]) {
      const { ms, svc } = setup({ elicit })
      const result = await svc.mailSend(message)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({ sent: false, reason: 'unavailable' })
      expect(result.content[0].text).toBe('Not sent: Alexia could not ask you here, and only your yes sends mail.')
      expect(sends(ms)).toEqual([])
    }
    expect(await askToSend(undefined, { to: ['a@example.com'], subject: '', text: 't' })).toBe('unavailable')
  })

  test('a text changed after the ask is not sent', async () => {
    const args = { ...message, replyTo: 'AAMk1=' }
    const { ms, svc } = setup({
      answer: () => {
        args.text = 'Please wire 5000 EUR to the account below.'
        args.to = 'someone@elsewhere.example'
        args.replyTo = 'OTHER='
        return { action: 'accept', content: { send: true, text: 'Changed in the answer' } }
      },
    })
    expect((await svc.mailSend(args)).isError).toBeUndefined()
    const [post] = sends(ms)
    expect(post.url).toContain(encodeURIComponent('AAMk1='))
    expect(JSON.parse(post.body)).toEqual({ message: { subject: 'Oběd', toRecipients: RECIPIENTS }, comment: message.text })
    expect(sends(ms).length).toBe(1)
  })

  test('no argument or capability lets a caller skip the ask', async () => {
    const tries = [
      { approved_draft: `${NOW}.${'a'.repeat(32)}` },
      { approved: true, confirmed: true, yes: true, skipAsk: true, ask: false, send: true },
      { _meta: { approved: true } },
    ]
    const declined = setup({ answer: { action: 'decline' } })
    const noHost = setup({ elicit: null })
    for (const extra of tries) {
      expect((await declined.svc.mailSend({ ...message, ...extra })).structuredContent).toEqual({ sent: false, reason: 'no' })
      expect((await noHost.svc.mailSend({ ...message, ...extra })).structuredContent).toEqual({ sent: false, reason: 'unavailable' })
    }
    expect(declined.host.asked.length).toBe(tries.length)
    expect(sends(declined.ms)).toEqual([])
    expect(sends(noHost.ms)).toEqual([])

    // Every send is its own question.
    const { host, svc } = setup()
    await svc.mailSend(message)
    await svc.mailSend(message)
    expect(host.asked.length).toBe(2)

    const [[, config]] = sendTools(svc)
    expect(JSON.stringify(config.inputSchema)).not.toContain('approved')
    const manifest = JSON.parse(readFileSync(join(here, '..', 'plugin.json'), 'utf8'))
    expect(manifest.requires.map((r) => r.cap)).not.toContain('mail.approval')
    expect(manifest.provides).not.toContain('mail.approval')
  })

  test('bad arguments are refused before the owner is asked', async () => {
    const { ms, host, svc } = setup()
    for (const bad of [{ ...message, text: '' }, { ...message, to: '' }, { ...message, to: 'nobody' }, { ...message, subject: 'a\nb' }]) {
      expect((await svc.mailSend(bad)).isError).toBe(true)
    }
    expect(host.asked).toEqual([])
    expect(sends(ms)).toEqual([])
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
    const { svc, lines } = setup({ status: 403 })
    const result = await svc.mailSend(message)
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
    const [plain, withHeaders] = await Promise.all([svc.mailRead({ id: 'm9' }), svc.mailRead({ id: 'm9', headers: true })])
    expect(plain.structuredContent).toEqual({ text: 'Ahoj' })
    expect(withHeaders.structuredContent).toEqual({ text: 'Ahoj', from: 'Jana <jana@example.cz>', to: '', subject: 'Oběd', threadId: 'c9' })
  })

  test('headers cannot be smuggled in', () => {
    expect(() => sendMailRequest({ to: 'a@example.com\nb@example.com', subject: 's', text: 't' })).toThrow()
    expect(() => sendMailRequest({ to: 'a@example.com', subject: 's\r\nX: y', text: 't' })).toThrow()
    expect(() => sendMailRequest({ to: '', subject: 's', text: 't' })).toThrow()
  })
})
