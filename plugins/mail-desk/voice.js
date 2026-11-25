// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * **Replies in the owner's voice, and sending them — always with the owner's yes.**
 *
 * - The *style card*: from a sample of the owner's own sent mail (`mail.list` with
 *   `in:sent`, at most {@link SAMPLE_LIST}), one model call over at most {@link SAMPLE_READ}
 *   trimmed messages writes a short card — greeting and sign-off habits, typical length,
 *   formality, language per recipient domain. Only the card is kept (the kv key
 *   {@link CARD_KEY}), rebuilt when it is a week old. The messages themselves are never stored.
 * - `draft_reply`: reads the mail, writes a reply with the card, and keeps it **here**: a file in
 *   the desk's own folder and a row in `drafts`. Nothing goes into Gmail's or Outlook's drafts.
 * - `send_draft`: asks the owner ("Send this to …?") and only on an explicit yes calls
 *   `mail.send` with a one-time `approved_draft` token, good for {@link APPROVAL_MS}. The account
 *   plugin checks the token, then asks back (`mail.approval`, `approve` below) whether it
 *   is the yes for that exact message. No yes — no, no answer, or no way to ask — sends nothing
 *   and the draft stays.
 *
 * Nothing here logs; mail text never reaches a log line.
 */

export const CARD_KEY = 'voice_card'
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** Sent messages listed for the sample. */
export const SAMPLE_LIST = 200
/** Of those, the most recent read and shown to the model. */
export const SAMPLE_READ = 30
/** Characters of each sample message the model sees. */
export const TRIM = 600
/** How long a yes is good for. The account plugins refuse a token older than this too. */
export const APPROVAL_MS = 60_000
/** Characters of the mail being answered the model sees. */
const ORIGINAL_MAX = 4_000

const FIELD_MAX = 80

const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/

/** The bare address in `Name <address>` or `address`, or '' when there is none. */
export function addressIn(text) {
  const s = String(text ?? '').split(',')[0].trim()
  const angled = /<([^<>]*)>\s*$/.exec(s)
  const address = (angled ? angled[1] : s).trim()
  return ADDRESS.test(address) ? address : ''
}

/** The domain of an address, lower case. */
export const domainOf = (address) => (addressIn(address).split('@')[1] ?? '').toLowerCase()

/**
 * **One sent message, cut to what is the owner's own writing**: the quoted mail under it goes
 * (`>` lines, "On … wrote:", "Dne … napsal(a):", an Outlook "-----Original Message-----" or
 * `From:` block), then at most {@link TRIM} characters.
 */
export function trimSent(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (/^(On\s.+\swrote:|Dne\s.+\snapsal(\(a\))?:|-{2,}\s*(Original Message|Původní zpráva)\s*-{2,}|_{10,})$/i.test(t)) break
    if (/^(From|Od):\s/i.test(t) && out.length > 0) break
    if (t.startsWith('>')) continue
    out.push(line.trimEnd())
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return body.length > TRIM ? `${body.slice(0, TRIM)}…` : body
}

/** The one question that writes the card. Each sample is labelled with its recipient's domain. */
export function cardPrompt(samples, domains) {
  const counted = Object.entries(domains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([d, n]) => `${d} (${n})`)
    .join(', ')
  const shown = samples.map((s, i) => `--- ${i + 1}, to ${s.domain || 'unknown'} ---\n${s.text}`).join('\n')
  return (
    'Here are emails the owner wrote. Describe how they write, so a reply can sound like them.\n' +
    'Answer with one JSON object only, every value a short phrase (at most 12 words), never a sentence copied from a message:\n' +
    '{"greeting": how they open, "signoff": how they close and sign, "length": typical length, "formality": how formal, ' +
    '"languages": {recipient domain: language they write in to it}}\n\n' +
    `Recipient domains, most written to first: ${counted || 'none'}\n\n${shown}`
  )
}

const short = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX) : '')

/** The model's card, checked: short strings only, real-looking domains only. `undefined` if not a card. */
export function parseCard(answer) {
  const text = String(answer ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let json
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
  const languages = {}
  if (json.languages && typeof json.languages === 'object' && !Array.isArray(json.languages)) {
    for (const [domain, language] of Object.entries(json.languages).slice(0, 20)) {
      const d = domain.trim().toLowerCase()
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && short(language) !== '') languages[d] = short(language).slice(0, 30)
    }
  }
  const card = { greeting: short(json.greeting), signoff: short(json.signoff), length: short(json.length), formality: short(json.formality), languages }
  return card.greeting || card.signoff || card.length || card.formality || Object.keys(languages).length > 0 ? card : undefined
}

/** The card as the lines a drafting prompt carries. */
export function cardText(card) {
  if (!card) return ''
  const lines = [
    card.greeting && `Greeting: ${card.greeting}`,
    card.signoff && `Sign-off: ${card.signoff}`,
    card.length && `Length: ${card.length}`,
    card.formality && `Formality: ${card.formality}`,
    Object.keys(card.languages ?? {}).length > 0 && `Language by recipient: ${Object.entries(card.languages).map(([d, l]) => `${d}: ${l}`).join('; ')}`,
  ]
  return lines.filter(Boolean).join('\n')
}

const structured = (result) => (result && !result.isError && result.structuredContent) || undefined

/**
 * **The style card**, from the kv when it is under a week old, otherwise built again from the
 * sent sample. A sample that cannot be read, or an answer that is not a card, keeps the old card
 * (or none): a draft without a card is still a draft.
 */
export async function styleCard({ capability, sample, storage, now = Date.now }) {
  const stored = await storage.get(CARD_KEY)
  if (stored && typeof stored === 'object' && Number(stored.built) > 0 && now() - Number(stored.built) < WEEK_MS && stored.card) return stored.card

  const listed = structured(await capability('mail.list', { query: 'in:sent', limit: SAMPLE_LIST }))
  const messages = (Array.isArray(listed?.messages) ? listed.messages : []).filter((m) => typeof m?.id === 'string').slice(0, SAMPLE_LIST)
  if (messages.length === 0) return stored?.card
  const domains = {}
  for (const m of messages) {
    for (const part of String(m.to ?? '').split(',')) {
      const d = domainOf(part)
      if (d) domains[d] = (domains[d] ?? 0) + 1
    }
  }
  const recent = [...messages].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, SAMPLE_READ)
  const samples = []
  for (const m of recent) {
    try {
      const read = structured(await capability('mail.read', { id: m.id }))
      const text = trimSent(read?.text)
      if (text !== '') samples.push({ domain: domainOf(m.to), text })
    } catch {
      // One unreadable message is one sample fewer.
    }
  }
  if (samples.length === 0) return stored?.card
  const card = parseCard(await sample(cardPrompt(samples, domains), 'You describe writing style and answer with one JSON object only.'))
  if (!card) return stored?.card
  await storage.set(CARD_KEY, { card, built: now(), sampled: samples.length })
  return card
}

/** `Re: ` once, whatever the original's subject already starts with. */
export const replySubject = (subject) => {
  const s = String(subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  return /^(re|odp|aw|sv):/i.test(s) ? s : `Re: ${s || '(no subject)'}`
}

/** The prompt that writes one reply. */
export function draftPrompt({ card, from, subject, original, intent, domain }) {
  const style = cardText(card)
  return (
    'Write the owner’s reply to the email below, as the owner, in their own voice.\n' +
    `What the reply should say: ${intent}\n\n` +
    (style ? `How the owner writes:\n${style}\n\n` : '') +
    `Write in the language the owner uses with ${domain || 'this sender'} if the style says one, otherwise in the email’s language. ` +
    'Answer with the reply’s text only: no subject line, no quotes of the email, no notes.\n\n' +
    `From: ${from}\nSubject: ${subject}\n\n${original}`
  )
}

/** A model answer as a plain reply text: code fences and a stray `Subject:` line go. */
export function cleanDraft(answer) {
  return String(answer ?? '')
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\s*Subject:[^\n]*\n+/i, '')
    .trim()
}

const fail = (message) => {
  const error = new Error(message)
  error.forOwner = true
  return error
}

/**
 * The two tools' work and the approval check, with everything outside passed in.
 *
 * - `capability(cap, args)` — `mail.list`, `mail.read`, `mail.send`.
 * - `sample(text, system)` — one model call.
 * - `storage` — the plugin's tables and kv.
 * - `ask({ to, subject, text })` — asks the owner; resolves `'yes'` only on an explicit yes,
 *   otherwise `'no'` or `'unanswered'`. It must never throw (a throw is taken as no answer).
 * - `dir()` — the plugin's own folder.
 * - `now()`, `random(n)` — the clock and `n` random bytes, for tests.
 */
export function createReplies({ capability, sample, storage, ask, dir, now = Date.now, random = randomBytes }) {
  /** One-time tokens: token → the exact message the owner said yes to, and when it runs out. */
  const pending = new Map()

  const forget = () => {
    for (const [token, entry] of pending) if (now() > entry.expires) pending.delete(token)
  }

  return {
    pending,

    /** Writes a reply and keeps it on this computer only. */
    async draftReply({ mail_id, intent } = {}) {
      const id = typeof mail_id === 'string' ? mail_id.trim() : ''
      if (id === '') throw fail('Which mail? `mail_id` is the id from the inbox.')
      const want = typeof intent === 'string' ? intent.trim().slice(0, 1_000) : ''
      if (want === '') throw fail('What should the reply say? `intent` is empty.')

      const read = await capability('mail.read', { id, headers: true })
      const mail = structured(read)
      if (!mail) throw fail('That mail could not be read.')
      const to = addressIn(mail.reply_to) || addressIn(mail.from)
      if (to === '') throw fail('Alexia could not tell who to answer: the mail has no sender address.')
      const subject = replySubject(mail.subject)

      let card
      try {
        card = await styleCard({ capability, sample, storage, now })
      } catch {
        card = undefined
      }
      const original = String(mail.text ?? '').slice(0, ORIGINAL_MAX)
      const text = cleanDraft(await sample(draftPrompt({ card, from: String(mail.from ?? ''), subject: String(mail.subject ?? ''), original, intent: want, domain: domainOf(to) }), 'You write email replies in the owner’s own voice.'))
      if (text === '') throw fail('No draft came back. Try again.')

      const draftId = `d${random(6).toString('hex')}`
      const folder = join(await dir(), 'drafts')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, `${draftId}.txt`), `To: ${to}\nSubject: ${subject}\n\n${text}\n`, 'utf8')
      await storage.insert('drafts', { id: draftId, mail_id: id, recipient: to, subject, text, state: 'draft', at: now() })
      return { id: draftId, to, subject, text }
    },

    /**
     * Asks the owner, and sends only on an explicit yes. Returns `{ sent, reason?, id? }`;
     * whatever happens short of a send, the draft stays as it was.
     */
    async sendDraft({ draft_id } = {}) {
      const id = typeof draft_id === 'string' ? draft_id.trim() : ''
      const [draft] = id === '' ? [] : await storage.select('drafts', { where: { id }, limit: 1 })
      if (!draft) throw fail('There is no draft with that id.')
      if (draft.state === 'sent') throw fail('That draft was already sent.')

      let answer
      try {
        answer = await ask({ to: draft.recipient, subject: draft.subject, text: draft.text })
      } catch {
        answer = 'unanswered'
      }
      if (answer !== 'yes') return { sent: false, reason: answer === 'no' ? 'no' : 'unanswered', id }

      forget()
      const token = `${now()}.${random(24).toString('base64url')}`
      const message = { to: draft.recipient, subject: draft.subject, text: draft.text, replyTo: draft.mail_id }
      pending.set(token, { ...message, expires: now() + APPROVAL_MS })
      let result
      try {
        result = await capability('mail.send', { ...message, approved_draft: token })
      } catch {
        result = { isError: true, content: [{ type: 'text', text: 'Nothing that can send mail answered.' }] }
      } finally {
        pending.delete(token)
      }
      if (result?.isError) {
        const why = result.content?.find((c) => c.type === 'text')?.text
        return { sent: false, reason: 'failed', id, ...(typeof why === 'string' && { why }) }
      }
      await storage.update('drafts', { state: 'sent', sent_at: now() }, { id })
      return { sent: true, id, to: draft.recipient }
    },

    /**
     * **Is this the owner's yes for this exact message?** Asked by the account plugin a send
     * goes through. A token is good once, for a minute, and only for the message it was made for.
     */
    approve({ token, to, subject, text, replyTo } = {}) {
      const entry = typeof token === 'string' ? pending.get(token) : undefined
      if (!entry) return false
      pending.delete(token)
      if (now() > entry.expires) return false
      return entry.to === to && entry.subject === subject && entry.text === text && entry.replyTo === replyTo
    },
  }
}
