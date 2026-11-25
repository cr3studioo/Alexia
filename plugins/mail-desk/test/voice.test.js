// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { APPROVAL_MS, CARD_KEY, createReplies, SAMPLE_READ, styleCard, trimSent, WEEK_MS } from '../voice.js'

const NOW = Date.parse('2030-05-06T08:00:00Z')
const DAY = 24 * 60 * 60 * 1000

/** An in-memory stand-in for the plugin's storage: tables and kv, every write recorded. */
function memoryStorage() {
  const tables = new Map()
  const kv = new Map()
  const writes = []
  const rows = (t) => tables.get(t) ?? tables.set(t, []).get(t)
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v)
  return {
    tables,
    kv,
    writes,
    insert: async (t, row) => {
      writes.push({ t, row })
      const r = rows(t)
      r.push({ rowid: r.length + 1, ...row })
      return r.length
    },
    select: async (t, { where, limit } = {}) => rows(t).filter((r) => match(r, where)).slice(0, limit ?? 100),
    update: async (t, set, where) => {
      writes.push({ t, set })
      const hit = rows(t).filter((r) => match(r, where))
      for (const r of hit) Object.assign(r, set)
      return hit.length
    },
    get: async (k) => kv.get(k),
    set: async (k, v) => {
      writes.push({ k, v })
      kv.set(k, v)
    },
  }
}

/** Forty sent messages, each with a sentence nobody else wrote and a quoted mail under it. */
const sent = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i}`,
  threadId: `t${i}`,
  from: 'Petr <petr@home.example>',
  to: i % 2 === 0 ? 'Jana <jana@firma.cz>' : 'bob@company.com',
  subject: `Subject ${i}`,
  at: NOW - i * DAY,
}))
const sentText = (i) => `Ahoj,\nsecret-sentence-${i} about the garden.\nPetr\n\nOn Mon, 5 May 2030, Jana wrote:\n> quoted-${i} from someone else`

const CARD = { greeting: 'Ahoj / Hi', signoff: 'Petr', length: 'two or three lines', formality: 'casual', languages: { 'firma.cz': 'Czech', 'company.com': 'English' } }

const incoming = {
  text: 'Hi Petr, does Thursday at noon work for lunch? Jana',
  from: 'Jana Nová <jana@firma.cz>',
  to: 'petr@home.example',
  subject: 'Lunch',
  threadId: 'tin',
}

/**
 * Fake capabilities: the sent sample, one incoming mail (`in1`) and, if given, `send` for
 * `mail.send`. Every call is recorded.
 */
function fakeAccount({ send, mail = incoming } = {}) {
  const calls = []
  const capability = async (cap, args) => {
    calls.push({ cap, args })
    if (cap === 'mail.list') return { content: [], structuredContent: { messages: args.query === 'in:sent' ? sent.slice(0, args.limit) : [] } }
    if (cap === 'mail.read') {
      if (args.id === 'in1') return { content: [], structuredContent: args.headers ? mail : { text: mail.text } }
      const i = Number(String(args.id).slice(1))
      return { content: [], structuredContent: { text: sentText(i) } }
    }
    if (cap === 'mail.send' && send) return send(args)
    throw new Error(`unexpected capability ${cap}`)
  }
  return { calls, capability }
}

/** A sampler that answers from a script, in order, and keeps every prompt. */
function scripted(answers) {
  const prompts = []
  const sample = async (text) => {
    prompts.push(text)
    const next = answers.shift()
    if (next === undefined) throw new Error('the sampler was asked once too often')
    return typeof next === 'function' ? next(text) : next
  }
  return { prompts, sample }
}

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup({ answers = [JSON.stringify(CARD), 'Ahoj Jano,\nčtvrtek ve 12 platí.\nPetr'], ask = async () => 'yes', send, clock, mail } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-desk-voice-'))
  dirs.push(dir)
  const storage = memoryStorage()
  const account = fakeAccount({ send, mail })
  const sampler = scripted(answers)
  const asked = []
  let now = NOW
  const replies = createReplies({
    capability: account.capability,
    sample: sampler.sample,
    storage,
    ask: async (q) => {
      asked.push(q)
      return ask(q)
    },
    dir: async () => dir,
    now: clock ?? (() => now),
  })
  return { replies, storage, account, sampler, asked, dir, advance: (ms) => (now += ms) }
}

describe('voice', () => {
  test('style_card_from_sample_without_keeping_messages', async () => {
    let now = NOW
    const storage = memoryStorage()
    const account = fakeAccount()
    const sampler = scripted([JSON.stringify(CARD), `Sure: ${JSON.stringify({ ...CARD, signoff: 'P.' })}`])
    const card = await styleCard({ capability: account.capability, sample: sampler.sample, storage, now: () => now })
    expect(card).toEqual(CARD)

    // One sampling call, over at most 30 messages, trimmed of what others wrote.
    expect(sampler.prompts.length).toBe(1)
    const [prompt] = sampler.prompts
    expect(account.calls[0]).toEqual({ cap: 'mail.list', args: { query: 'in:sent', limit: 200 } })
    expect(account.calls.filter((c) => c.cap === 'mail.read').length).toBe(SAMPLE_READ)
    expect(prompt).toContain('secret-sentence-0')
    expect(prompt).toContain(`secret-sentence-${SAMPLE_READ - 1}`)
    expect(prompt).not.toContain(`secret-sentence-${SAMPLE_READ}`)
    expect(prompt).not.toContain('quoted-')
    expect(prompt).toContain('firma.cz (20)')
    expect(prompt).toContain('to company.com')

    // Only the card is kept: no message text, subject or id anywhere in storage.
    expect([...storage.kv.keys()]).toEqual([CARD_KEY])
    expect(storage.tables.size).toBe(0)
    const kept = JSON.stringify(storage.writes)
    expect(kept).not.toMatch(/secret-sentence|quoted-|garden|Subject \d|"s\d+"/)
    expect(storage.kv.get(CARD_KEY)).toMatchObject({ card: CARD, built: NOW })

    // Within the week the card is reused; past it, it is built again.
    now = NOW + 6 * DAY
    expect(await styleCard({ capability: account.capability, sample: sampler.sample, storage, now: () => now })).toEqual(CARD)
    expect(sampler.prompts.length).toBe(1)
    now = NOW + WEEK_MS + 1
    expect((await styleCard({ capability: account.capability, sample: sampler.sample, storage, now: () => now })).signoff).toBe('P.')
    expect(sampler.prompts.length).toBe(2)

    // An answer that is no card keeps the old one.
    now += WEEK_MS + 1
    const broken = scripted(['I cannot help with that.'])
    expect(await styleCard({ capability: account.capability, sample: broken.sample, storage, now: () => now })).toMatchObject({ signoff: 'P.' })

    expect(trimSent('Thanks!\n\n-----Original Message-----\nFrom: x')).toBe('Thanks!')
    expect(trimSent('Díky\n\nDne 5. 5. 2030 v 10:00 Jana napsal(a):\n> text')).toBe('Díky')
    expect(trimSent('x'.repeat(700))).toHaveLength(601)
  })

  test('draft_saved_locally_not_in_account', async () => {
    const { replies, storage, account, sampler, dir } = setup()
    const draft = await replies.draftReply({ mail_id: 'in1', intent: 'yes, Thursday works' })
    expect(draft).toMatchObject({ to: 'jana@firma.cz', subject: 'Re: Lunch', text: 'Ahoj Jano,\nčtvrtek ve 12 platí.\nPetr' })
    expect(draft.id).toMatch(/^d[0-9a-f]{12}$/)

    // The card and the mail both reached the drafting prompt.
    const prompt = sampler.prompts.at(-1)
    expect(prompt).toContain('yes, Thursday works')
    expect(prompt).toContain('Formality: casual')
    expect(prompt).toContain('firma.cz: Czech')
    expect(prompt).toContain('does Thursday at noon work')

    // Kept here: a file in the desk's own folder, and a row.
    const file = join(dir, 'drafts', `${draft.id}.txt`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(`To: jana@firma.cz\nSubject: Re: Lunch\n\n${draft.text}\n`)
    expect(readdirSync(join(dir, 'drafts'))).toEqual([`${draft.id}.txt`])
    const [row] = storage.tables.get('drafts')
    expect(row).toMatchObject({ id: draft.id, mail_id: 'in1', recipient: 'jana@firma.cz', subject: 'Re: Lunch', text: draft.text, state: 'draft' })

    // Nothing reached the account but reads: no send, no draft in Gmail or Outlook.
    expect([...new Set(account.calls.map((c) => c.cap))].sort()).toEqual(['mail.list', 'mail.read'])
    expect(account.calls.find((c) => c.args.id === 'in1').args).toEqual({ id: 'in1', headers: true })

    // A Reply-To wins over From, and an existing Re: is not doubled.
    const second = setup({
      answers: [JSON.stringify(CARD), '```\nSubject: Re: Lunch\n\nOk.\n```'],
      mail: { ...incoming, subject: 'RE: Lunch', reply_to: 'Office <office@firma.cz>' },
    })
    expect(await second.replies.draftReply({ mail_id: 'in1', intent: 'ok' })).toMatchObject({ to: 'office@firma.cz', subject: 'RE: Lunch', text: 'Ok.' })
    // Bad arguments are refused before anything is read.
    await expect(second.replies.draftReply({ mail_id: 'in1', intent: '' })).rejects.toThrow('intent')
    await expect(second.replies.draftReply({ intent: 'x' })).rejects.toThrow('mail_id')
  })

  test('send_draft_asks_and_sends_on_yes', async () => {
    let replies
    const sends = []
    // The account plugin's side, faked: it asks the desk back, exactly as mail.send does.
    const send = (args) => {
      sends.push(args)
      const approved = replies.approve({ token: args.approved_draft, to: args.to, subject: args.subject, text: args.text, replyTo: args.replyTo })
      return approved ? { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { id: 'x1' } } : { isError: true, content: [{ type: 'text', text: 'Sending needs your yes on the draft first.' }] }
    }
    const ctx = setup({ send })
    replies = ctx.replies
    const draft = await replies.draftReply({ mail_id: 'in1', intent: 'yes' })

    const result = await replies.sendDraft({ draft_id: draft.id })
    expect(result).toEqual({ sent: true, id: draft.id, to: 'jana@firma.cz' })
    // Asked first, with the whole message.
    expect(ctx.asked).toEqual([{ to: 'jana@firma.cz', subject: 'Re: Lunch', text: draft.text }])
    expect(sends.length).toBe(1)
    const [args] = sends
    expect(args).toMatchObject({ to: 'jana@firma.cz', subject: 'Re: Lunch', text: draft.text, replyTo: 'in1' })
    expect(args.approved_draft).toMatch(/^\d{13}\.[A-Za-z0-9_-]{32}$/)
    expect(Number(args.approved_draft.split('.')[0])).toBe(NOW)
    // One time only: the token is spent, and no longer held.
    expect(replies.approve({ token: args.approved_draft, to: args.to, subject: args.subject, text: args.text, replyTo: args.replyTo })).toBe(false)
    expect(replies.pending.size).toBe(0)
    // The token never comes back in a result.
    expect(JSON.stringify(result)).not.toContain(args.approved_draft)
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('sent')
    // Sent once is sent: no second ask, no second send.
    await expect(replies.sendDraft({ draft_id: draft.id })).rejects.toThrow('already sent')
    expect(sends.length).toBe(1)
  })

  test('approval is for that message, for a minute', async () => {
    let replies
    let tamper = (a) => a
    let wait = 0
    const ctx = setup({
      answers: [JSON.stringify(CARD), 'Draft one', 'Draft two'],
      send: (args) => {
        ctx.advance(wait)
        const a = tamper(args)
        return replies.approve({ token: a.approved_draft, to: a.to, subject: a.subject, text: a.text, replyTo: a.replyTo }) ? { content: [] } : { isError: true, content: [{ type: 'text', text: 'Sending needs your yes on the draft first.' }] }
      },
    })
    replies = ctx.replies
    const one = await replies.draftReply({ mail_id: 'in1', intent: 'x' })
    // A different text under the same yes is refused, and the draft stays.
    tamper = (a) => ({ ...a, text: 'Something the owner never saw' })
    expect(await replies.sendDraft({ draft_id: one.id })).toMatchObject({ sent: false, reason: 'failed', why: 'Sending needs your yes on the draft first.' })
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('draft')
    // A yes used after its minute is refused.
    tamper = (a) => a
    wait = APPROVAL_MS + 1
    expect((await replies.sendDraft({ draft_id: one.id })).sent).toBe(false)
    expect(replies.approve({ token: 'nothing' })).toBe(false)
  })

  test('send_draft_no_answer_keeps_draft', async () => {
    for (const ask of [async () => 'unanswered', async () => { throw new Error('This host cannot ask.') }, async () => 'maybe']) {
      const sends = []
      const ctx = setup({ ask, send: (args) => (sends.push(args), { content: [] }) })
      const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
      const result = await ctx.replies.sendDraft({ draft_id: draft.id })
      expect(result).toEqual({ sent: false, reason: 'unanswered', id: draft.id })
      expect(sends).toEqual([])
      expect(ctx.account.calls.some((c) => c.cap === 'mail.send')).toBe(false)
      expect(ctx.replies.pending.size).toBe(0)
      expect(ctx.storage.tables.get('drafts')[0]).toMatchObject({ state: 'draft', text: draft.text })
      expect(existsSync(join(ctx.dir, 'drafts', `${draft.id}.txt`))).toBe(true)
    }
  })

  test('send_draft_no_keeps_draft', async () => {
    const sends = []
    const ctx = setup({ ask: async () => 'no', send: (args) => (sends.push(args), { content: [] }) })
    const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
    expect(await ctx.replies.sendDraft({ draft_id: draft.id })).toEqual({ sent: false, reason: 'no', id: draft.id })
    expect(ctx.asked.length).toBe(1)
    expect(sends).toEqual([])
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('draft')
    await expect(ctx.replies.sendDraft({ draft_id: 'd000000000000' })).rejects.toThrow('no draft')
  })

  test('the tools are marked as the spec says', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
    const annotationsOf = (name) => {
      const at = src.indexOf(`'${name}',`)
      const from = src.indexOf('annotations:', at)
      return src.slice(from, src.indexOf('}', from) + 1)
    }
    expect(annotationsOf('draft_reply')).toContain('readOnlyHint: false, destructiveHint: false')
    expect(annotationsOf('draft_reply')).toContain('openWorldHint: false')
    expect(annotationsOf('send_draft')).toContain('destructiveHint: true')
    expect(annotationsOf('send_draft')).toContain('openWorldHint: true')
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin.json'), 'utf8'))
    expect(manifest.storage.tables).toContain('drafts')
    expect(manifest.requires.map((r) => r.cap)).toEqual(expect.arrayContaining(['mail.send', 'fs.own_dir']))
    expect(manifest.provides).toContain('mail.approval')
  })
})
