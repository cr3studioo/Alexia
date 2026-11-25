// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { CARD_KEY, createReplies, SAMPLE_READ, styleCard, trimSent, WEEK_MS } from '../voice.js'

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

function setup({ answers = [JSON.stringify(CARD), 'Ahoj Jano,\nčtvrtek ve 12 platí.\nPetr'], send, clock, mail } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-desk-voice-'))
  dirs.push(dir)
  const storage = memoryStorage()
  const account = fakeAccount({ send, mail })
  const sampler = scripted(answers)
  let now = NOW
  const replies = createReplies({
    capability: account.capability,
    sample: sampler.sample,
    storage,
    dir: async () => dir,
    now: clock ?? (() => now),
  })
  return { replies, storage, account, sampler, dir, advance: (ms) => (now += ms) }
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

  /**
   * The account plugin's `mail.send`, faked the way it really behaves: it asks the owner itself
   * (`owner(message)` plays them) and sends only on their yes. Records every message it got.
   */
  const accountAsking = (owner) => {
    const got = []
    const send = async (args) => {
      got.push(args)
      const answer = await owner(args)
      if (answer === 'yes') return { content: [{ type: 'text', text: `Sent to ${args.to}.` }], structuredContent: { sent: true, id: 'x1' } }
      const words = { no: 'Not sent: you said no.', cancel: 'Not sent: you closed the question without a yes.', timeout: 'Not sent: there was no answer in time.', unavailable: 'Not sent: Alexia could not ask you here, and only your yes sends mail.' }
      return { isError: true, content: [{ type: 'text', text: words[answer] }], structuredContent: { sent: false, reason: answer } }
    }
    return { got, send }
  }

  test('send_draft_asks_and_sends_on_yes', async () => {
    // The yes is the account plugin's to get: the desk hands over the exact draft, once.
    const account = accountAsking(async () => 'yes')
    const ctx = setup({ send: account.send })
    const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })

    const result = await ctx.replies.sendDraft({ draft_id: draft.id })
    expect(result).toEqual({ sent: true, id: draft.id, to: 'jana@firma.cz' })
    // Exactly the draft, and nothing that could stand in for the owner's yes.
    expect(account.got).toEqual([{ to: 'jana@firma.cz', subject: 'Re: Lunch', text: draft.text, replyTo: 'in1' }])
    expect(ctx.account.calls.filter((c) => c.cap === 'mail.send').length).toBe(1)
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('sent')
    // Sent once is sent: no second send.
    await expect(ctx.replies.sendDraft({ draft_id: draft.id })).rejects.toThrow('already sent')
    expect(account.got.length).toBe(1)
  })

  test('send_draft_no_answer_keeps_draft', async () => {
    for (const reason of ['timeout', 'cancel', 'unavailable']) {
      const account = accountAsking(async () => reason)
      const ctx = setup({ send: account.send })
      const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
      const result = await ctx.replies.sendDraft({ draft_id: draft.id })
      expect(result).toMatchObject({ sent: false, reason, id: draft.id })
      expect(result.why).toMatch(/^Not sent: /)
      // Asked once, by the account; the desk did not try again.
      expect(account.got.length).toBe(1)
      expect(ctx.storage.tables.get('drafts')[0]).toMatchObject({ state: 'draft', text: draft.text })
      expect(existsSync(join(ctx.dir, 'drafts', `${draft.id}.txt`))).toBe(true)
    }
    // Nothing that can send at all: the draft stays too.
    const ctx = setup()
    const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
    expect(await ctx.replies.sendDraft({ draft_id: draft.id })).toMatchObject({ sent: false, reason: 'failed', why: 'Nothing that can send mail answered.' })
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('draft')
  })

  test('send_draft_no_keeps_draft', async () => {
    const account = accountAsking(async () => 'no')
    const ctx = setup({ send: account.send })
    const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
    expect(await ctx.replies.sendDraft({ draft_id: draft.id })).toEqual({ sent: false, reason: 'no', id: draft.id, why: 'Not sent: you said no.' })
    expect(account.got.length).toBe(1)
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('draft')
    // A no today does not stop asking again tomorrow: the next try is a new question.
    expect((await ctx.replies.sendDraft({ draft_id: draft.id })).sent).toBe(false)
    expect(account.got.length).toBe(2)
    await expect(ctx.replies.sendDraft({ draft_id: 'd000000000000' })).rejects.toThrow('no draft')
  })

  test('a send the account did not confirm is not counted as sent', async () => {
    // An answer that is neither an error nor a yes, or says sent: false, keeps the draft.
    const ctx = setup({ send: async () => ({ content: [{ type: 'text', text: 'Not sent: you said no.' }], structuredContent: { sent: false, reason: 'no' } }) })
    const draft = await ctx.replies.draftReply({ mail_id: 'in1', intent: 'yes' })
    expect(await ctx.replies.sendDraft({ draft_id: draft.id })).toMatchObject({ sent: false, reason: 'no' })
    expect(ctx.storage.tables.get('drafts')[0].state).toBe('draft')
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
    // The desk cannot approve a send for the owner: there is no such capability any more.
    expect(manifest.provides).not.toContain('mail.approval')
    expect(manifest.requires.map((r) => r.cap)).not.toContain('mail.approval')
    expect(src).not.toContain('approved_draft')
    expect(src).not.toContain('elicitInput')
  })
})
