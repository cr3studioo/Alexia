// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { ArgumentError, createRequest, eventLine, eventsRequest, localDay, mapEvents, merge, nextRequest, noticeItems } from './calendar.js'
import { contactLine, findRequest, mapContacts, SCAN_PAGES } from './contacts.js'
import {
  checkApproval,
  FOLDERS,
  folderRequest,
  listRequest,
  mapMessages,
  messageLine,
  messageText,
  NEEDS_YES,
  pruneUsed,
  readHeaders,
  readRequest,
  recipients,
  replyRequest,
  sendMailRequest,
  subjectOf,
} from './mail.js'
import { AUTHORITY, call, CONSENT_REFUSED, MicrosoftError, pollToken, REFUSED, SCOPES, startDeviceCode, tenantOf, Tokens } from './oauth.js'

/**
 * Microsoft 365 — the owner's Outlook calendar, mail and contacts, behind the P3 capabilities.
 *
 * The day planner, the mail desk, memory and the scheduler ask for `calendar.events`,
 * `mail.list`, `contacts.find` and the rest; none of them learns it is Microsoft. Everything is
 * read only except `calendar.create`, which writes to Outlook and so is open-world: a proactive
 * run always asks first (D214). Mail is never marked read — there is no `PATCH` anywhere.
 *
 * `mail.send` is the one tool that sends, and it asks **every** time, in every mode: it is
 * destructive (so "Ask before risky" asks and a "don't send anything" boundary blocks it), and
 * in Full trust, where core would run it, it still refuses without an `approved_draft` token.
 * Only the mail desk's `send_draft` makes one, after the owner said yes to that exact message;
 * this plugin checks it is fresh and unspent, then asks the desk (`mail.approval`) whether it
 * really is that yes. Nothing goes into Outlook's Drafts.
 *
 * Signing in is the device code flow in `oauth.js`. The access token lives in this process; the
 * refresh token is a `password` setting. Neither, nor the device code, appears in a result, a
 * status line, a log or an error. Only the user code and the page to type it on are shown.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Sending needs one more permission than reading, so a sign-in from before it must be redone. */
export const MAIL_SEND = 'Mail.Send'
export const SEND_SCOPES = [...SCOPES, MAIL_SEND]
export const RECONNECT = 'To send mail, Microsoft needs you to connect once more: Plugins › Microsoft 365 › Connect.'

/** Whether a token answer's `scope` (short or `https://graph.microsoft.com/…` names) allows sending. */
const allowsSend = (scope) => scope.split(/\s+/).some((s) => s.replace(/^.*\//, '').toLowerCase() === MAIL_SEND.toLowerCase())

const text = (body, structuredContent) => ({
  content: [{ type: 'text', text: body }],
  ...(structuredContent !== undefined && { structuredContent }),
})

/** A failure as a sentence. Ours are already sentences; anything else is not shown at all. */
const failure = (error) => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: error instanceof MicrosoftError || error instanceof ArgumentError ? error.message : 'Something went wrong talking to Microsoft.',
    },
  ],
})

const num = (value, fallback) =>
  value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback

/** Sentences worth putting on the settings screen as well as in the answer. */
const STATUS_WORTHY = [REFUSED, CONSENT_REFUSED]

/**
 * Everything the tools do, with the host passed in so tests can stand in for it.
 *
 * - `settings()` — the current settings.
 * - `keep(key, value)` — write a `password` setting (the refresh token).
 * - `status(text)` — the `status` line on the settings screen.
 * - `capability(cap, args)` — another plugin's capability; only `mail.approval` is asked.
 * - `fetch` — the network; `clock` — now, in ms; `sleep(ms)` — the wait between polls.
 */
export function service({
  settings,
  keep,
  status = async () => {},
  capability = async () => {
    throw new Error('no capabilities here')
  },
  fetch: network = fetch,
  clock = Date.now,
  sleep,
}) {
  const say = (line) => status(line).catch(() => {})
  // What Microsoft said a sign-in from before sending allows, read off its refresh answers:
  // `false` once one comes back without Mail.Send, so the status says a reconnect is due before
  // a send fails. A fresh sign-in asked for Mail.Send; if it was not granted, the send's 403
  // says the same.
  let canSend
  const fetchImpl = async (input, init) => {
    const res = await network(input, init)
    const url = String(input)
    const refreshing = typeof init?.body === 'string' && new URLSearchParams(init.body).get('grant_type') === 'refresh_token'
    if (refreshing && url.startsWith(AUTHORITY) && url.endsWith('/oauth2/v2.0/token') && res.ok) {
      try {
        const scope = (await res.clone().json())?.scope
        if (typeof scope === 'string') {
          const before = canSend
          canSend = allowsSend(scope)
          if (canSend === false && before !== false) await say(`▲ ${RECONNECT}`)
        }
      } catch {
        // Not JSON: oauth.js says so to whoever asked.
      }
    }
    return res
  }
  // Graph accepts a send with `202` and no body; to `call` that is the same as a `204`.
  const accepted = async (input, init) => {
    const res = await fetchImpl(input, init)
    return res.status === 202 ? new globalThis.Response(null, { status: 204 }) : res
  }
  // Tokens already spent on a send. A token is spent the moment it passes the local check.
  const used = new Set()
  // A refresh token from a sign-in (or a rotation) this run, kept in memory in case the host
  // would not store it.
  let signedIn
  const read = async () => {
    const s = await settings()
    return { ...s, refresh_token: s.refresh_token || signedIn }
  }
  const store = async (refreshToken) => {
    signedIn = refreshToken
    try {
      await keep('refresh_token', refreshToken)
      return true
    } catch {
      return false
    }
  }
  const tokens = new Tokens({ read, fetch: fetchImpl, clock, rotate: store })
  const graph = (req) => call(tokens, req, fetchImpl)
  let attempt = 0
  let folders

  /** Runs a tool body; a refused sign-in also shows on the settings screen. */
  const guarded = async (body) => {
    try {
      return await body()
    } catch (error) {
      if (error instanceof MicrosoftError && STATUS_WORTHY.includes(error.message)) await say(`▲ ${error.message}`)
      if (!(error instanceof MicrosoftError || error instanceof ArgumentError)) log.warn('a Microsoft call failed', error?.name ?? 'error')
      return failure(error)
    }
  }

  /** The default calendar's events in a window, every page. */
  async function events(from, to) {
    const lists = []
    let req = eventsRequest({ from, to })
    for (let i = 0; i < 10 && req; i++) {
      const json = await graph(req)
      lists.push(mapEvents(json))
      req = nextRequest(json)
    }
    return merge(lists)
  }

  /** Folder id → label, looked up once. A folder Graph will not name is simply not a label. */
  async function folderLabels() {
    if (folders) return folders
    const found = {}
    for (const [name, label] of Object.entries(FOLDERS)) {
      try {
        const json = await graph(folderRequest(name))
        if (typeof json?.id === 'string') found[json.id] = label
      } catch (error) {
        if (error instanceof MicrosoftError && error.status === 401) throw error
      }
    }
    folders = found
    return folders
  }

  return {
    tokens,

    async report() {
      const connected = await tokens.connected()
      await say(!connected ? '■ Not connected' : canSend === false ? `▲ ${RECONNECT}` : '● Connected')
    },

    forget() {
      tokens.forget()
      folders = undefined
    },

    calendarEvents: (args = {}) =>
      guarded(async () => {
        const found = await events(args.from, args.to)
        return text(found.length === 0 ? 'Nothing on the calendar then.' : found.map(eventLine).join('\n'), { events: found })
      }),

    calendarCreate: (args = {}) =>
      guarded(async () => {
        const req = createRequest(args)
        const made = await graph(req)
        const id = String(made?.id ?? '')
        return text(`Added “${req.body.subject}” to the calendar.`, { id })
      }),

    mailList: (args = {}) =>
      guarded(async () => {
        const req = listRequest(args)
        const labels = await folderLabels()
        const messages = mapMessages(await graph(req), labels, req.since).slice(0, req.limit)
        return text(messages.length === 0 ? 'No mail matches.' : messages.map(messageLine).join('\n'), { messages })
      }),

    mailRead: (args = {}) =>
      guarded(async () => {
        const headers = args.headers === true
        const msg = await graph(readRequest(args.id, { headers }))
        const body = messageText(msg)
        // Who it is from and what about, only when asked: the mail desk needs them to answer.
        return text(body, { text: body, ...(headers && readHeaders(msg)) })
      }),

    /**
     * **Send one message — only with the owner's yes.** The order matters: the token is checked
     * here (its shape, the last minute, not spent), spent, then confirmed by the mail desk for
     * this exact message; only then does anything go to Microsoft. Any doubt is a refusal.
     */
    mailSend: (args = {}) =>
      guarded(async () => {
        const now = clock()
        pruneUsed(used, now)
        const token = args.approved_draft
        const refused = checkApproval(token, { now, used })
        if (refused !== undefined) return failure(new MicrosoftError(refused))
        const to = recipients(args.to)
        const subject = subjectOf(args.subject)
        const body = typeof args.text === 'string' ? args.text : ''
        if (body.trim() === '') throw new ArgumentError('There is no text to send.')
        used.add(token)
        let approved
        try {
          const answer = await capability('mail.approval', {
            token,
            to: args.to,
            subject: args.subject,
            text: args.text,
            ...(args.replyTo !== undefined && { replyTo: args.replyTo }),
          })
          approved = !answer?.isError && answer?.structuredContent?.approved === true
        } catch {
          approved = false
        }
        if (!approved) return failure(new MicrosoftError(NEEDS_YES))

        const req =
          typeof args.replyTo === 'string' && args.replyTo !== '' ? replyRequest(args.replyTo, { to, text: body }) : sendMailRequest({ to, subject, text: body })
        try {
          await call(tokens, req, accepted)
        } catch (error) {
          if (error instanceof MicrosoftError && error.status === 403) {
            canSend = false
            await say(`▲ ${RECONNECT}`)
            return failure(new MicrosoftError(RECONNECT))
          }
          throw error
        }
        // Graph answers a send with no message id; there is none to give.
        return text(`Sent to ${to.join(', ')}.`, { id: '' })
      }),

    contactsFind: (args = {}) =>
      guarded(async () => {
        const first = findRequest(args.query)
        const contacts = []
        let req = first
        for (let i = 0; req && i < (first.digits ? SCAN_PAGES : 1); i++) {
          const json = await graph(req)
          contacts.push(...mapContacts(json, first.digits))
          if (contacts.length >= 10) break
          req = nextRequest(json, {})
        }
        const found = contacts.slice(0, 10)
        return text(found.length === 0 ? 'No contact matches.' : found.map(contactLine).join('\n'), { contacts: found })
      }),

    noticeItems: (args = {}) =>
      guarded(async () => {
        // Not connected is not news every few minutes: nothing to say, and the settings
        // screen already says why.
        if (!(await tokens.connected())) return text('', { items: [] })
        const now = num(args.now, clock())
        const tz = num(args.tz_offset_min, 0)
        const horizon = Math.max(1, Math.floor(num(args.horizon_days, 2)))
        const todayStart = Date.parse(`${localDay(now, tz)}T00:00:00Z`) - tz * 60_000
        const found = await events(todayStart, todayStart + horizon * DAY_MS)
        const items = noticeItems(found, { now, horizonDays: horizon, tz })
        return text(items.map((item) => `- ${item.text}`).join('\n'), { items })
      }),

    /**
     * The Connect button. Asks Microsoft for a code, shows the code and the page to enter it
     * on (in the answer and on the settings screen), and returns at once; polling goes on in
     * the background until the owner has signed in, said no, or the code has run out.
     */
    async connect() {
      const s = await settings()
      if (!s.client_id) {
        return failure(new MicrosoftError('Put your app’s client ID in first. The README says how to register one; it is free.'))
      }
      let tenant
      try {
        tenant = tenantOf(s.tenant)
      } catch (error) {
        return failure(error)
      }
      // A second press replaces the first: the old poll stops at its next turn.
      const mine = ++attempt
      let code
      try {
        code = await startDeviceCode({ fetch: fetchImpl, clientId: s.client_id, tenant, scopes: SEND_SCOPES, now: clock() })
      } catch (error) {
        await say(`▲ ${error instanceof MicrosoftError ? error.message : REFUSED}`)
        return failure(error)
      }
      const minutes = Math.max(1, Math.round((code.expiresAt - clock()) / 60_000))
      await say(`▲ Open ${code.verificationUri} and enter the code ${code.userCode}`)

      const finished = pollToken({
        fetch: fetchImpl,
        clientId: s.client_id,
        tenant,
        deviceCode: code.deviceCode,
        interval: code.interval,
        expiresAt: code.expiresAt,
        clock,
        ...(sleep && { sleep }),
        stopped: () => attempt !== mine,
      })
        .then(async (got) => {
          tokens.hold(got.accessToken, got.expiresAt)
          folders = undefined
          // This sign-in asked for sending.
          canSend = true
          const kept = await store(got.refreshToken)
          await say(kept ? '● Connected' : '▲ Connected until Alexia restarts: the sign-in could not be saved in the keychain')
          return true
        })
        .catch(async (error) => {
          if (attempt === mine) await say(`▲ ${error instanceof MicrosoftError ? error.message : REFUSED}`)
          return false
        })

      const result = {
        ...text(
          `To connect Microsoft, open ${code.verificationUri} on any device and enter the code ${code.userCode}. ` +
            `Sign in with the account to connect and allow what it asks. The code works for ${minutes} minutes.`,
        ),
        _meta: { 'alexia/card': { title: 'Connect Microsoft', fields: { Code: code.userCode }, url: code.verificationUri } },
      }
      // For tests and for a caller that wants to wait; never part of what a tool returns.
      Object.defineProperty(result, 'finished', { value: finished, enumerable: false })
      return result
    },
  }
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

/**
 * The tools that read, and `calendar_create`, as `[name, config, handler]`, so a test can read
 * their annotations. The one that sends mail is {@link sendTools}, kept apart so nothing that
 * walks this list mistakes it for one more read.
 */
export function tools(svc) {
  return [
    [
      'calendar_events',
      {
        description:
          'Events on the owner’s Outlook calendar between `from` and `to` (ISO date-times or epoch ms), recurring ones expanded. Times are UTC.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            from: { type: ['string', 'number'], description: 'Start of the window: ISO date or date-time, or epoch ms.' },
            to: { type: ['string', 'number'], description: 'End of the window: ISO date or date-time, or epoch ms.' },
          },
          required: ['from', 'to'],
        }),
        annotations: RO,
        _meta: { 'alexia/provides': ['calendar.events'] },
      },
      (args) => svc.calendarEvents(args),
    ],
    [
      'calendar_create',
      {
        description:
          'Add an event to the owner’s Outlook calendar. `start`/`end` are ISO date-times, or YYYY-MM-DD for an all-day event. ' +
          'Anyone in `attendees` is sent an invitation by Microsoft.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What the event is called.' },
            start: { type: 'string', description: 'ISO date-time with offset, or YYYY-MM-DD for all day.' },
            end: { type: 'string', description: 'ISO date-time with offset, or YYYY-MM-DD. Defaults to an hour (or a day) after the start.' },
            location: { type: 'string', description: 'Where, if anywhere.' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite.' },
          },
          required: ['title', 'start'],
        }),
        // It writes to Outlook, so it is open-world, and a proactive run always asks (D214).
        // Not destructive: it adds and overwrites nothing.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        _meta: { 'alexia/provides': ['calendar.create'] },
      },
      (args) => svc.calendarCreate(args),
    ],
    [
      'mail_list',
      {
        description:
          'Recent Outlook messages, newest first: sender, subject, preview, labels and whether unread. Never marks anything read. ' +
          '`query` is Outlook search (e.g. "from:school", "subject:invoice"); `since` an ISO date-time or epoch ms; `limit` at most 50 (default 20).',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            since: { type: ['string', 'number'], description: 'Only mail received after this: ISO date-time or epoch ms.' },
            query: { type: 'string', description: 'Outlook search words, e.g. "from:school".' },
            limit: { type: 'number', description: 'How many, 1–50. Defaults to 20.' },
          },
        }),
        annotations: RO,
        _meta: { 'alexia/provides': ['mail.list'] },
      },
      (args) => svc.mailList(args),
    ],
    [
      'mail_read',
      {
        description: 'The text of one Outlook message, by the `id` from mail_list. Plain text; HTML is stripped. Never marks it read.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The message id from mail_list.' },
            headers: { type: 'boolean', description: 'Also return from, to, subject, threadId and reply_to.' },
          },
          required: ['id'],
        }),
        annotations: RO,
        _meta: { 'alexia/provides': ['mail.read'] },
      },
      (args) => svc.mailRead(args),
    ],
    [
      'contacts_find',
      {
        description: 'Find people in the owner’s Outlook contacts by the start of a name, an email or a phone number: their emails, phones and birthday.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: { query: { type: 'string', description: 'A name, email or phone number.' } },
          required: ['query'],
        }),
        annotations: RO,
        _meta: { 'alexia/provides': ['contacts.find'] },
      },
      (args) => svc.contactsFind(args),
    ],
    [
      'notice_items',
      {
        description:
          'Outlook calendar deadlines worth raising now (events titled Deadline, Due, Odevzdat or Termín in the next `horizon_days`), ' +
          'and today’s all-day events. Takes `now` (epoch ms), `horizon_days` and `tz_offset_min` (minutes east of UTC).',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            now: { type: 'number', description: 'Now, in epoch milliseconds.' },
            horizon_days: { type: 'number', description: 'How many days ahead, today counting as the first. Defaults to 2.' },
            tz_offset_min: { type: 'number', description: 'The owner’s offset from UTC in minutes, east positive.' },
          },
        }),
        annotations: RO,
        _meta: { 'alexia/provides': ['notice.items'] },
      },
      (args) => svc.noticeItems(args),
    ],
    [
      'connect',
      {
        description: 'Connect the owner’s Microsoft account: shows a code to enter at Microsoft’s sign-in page, then waits for it.',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      () => svc.connect(),
    ],
  ]
}

/** **The one tool that sends mail**, as `[name, config, handler]`. */
export function sendTools(svc) {
  return [
    [
      'mail_send',
      {
        description:
          'Send one plain-text email from the owner’s Outlook. Refused unless `approved_draft` holds the one-time token the mail desk’s ' +
          'send_draft adds after the owner said yes to this exact message: to send, use send_draft, never this directly.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            to: { type: ['string', 'array'], items: { type: 'string' }, description: 'Addresses, separated by commas, or a list.' },
            subject: { type: 'string', description: 'The subject line. A reply keeps the original’s.' },
            text: { type: 'string', description: 'The message, plain text.' },
            replyTo: { type: 'string', description: 'The id (from mail_list) of the message this answers, so it threads.' },
            approved_draft: { type: 'string', description: 'The token send_draft adds after the owner’s yes. Nothing else makes one.' },
          },
          required: ['to', 'subject', 'text'],
        }),
        // Destructive on purpose: then "Ask before risky" asks too, and a spoken "don't send
        // anything" boundary blocks it. Open-world: it leaves the owner's devices (D214).
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        _meta: { 'alexia/provides': ['mail.send'] },
      },
      (args) => svc.mailSend(args),
    ],
  ]
}

const alexia = plugin()

const svc = service({
  settings: () => alexia.settings(),
  keep: (key, value) => alexia.call('alexia/settings/set', { key, value }),
  status: (line) => alexia.status('status', line),
  capability: (cap, args) => alexia.capability(cap, args),
})

for (const [name, config, handler] of [...tools(svc), ...sendTools(svc)]) alexia.tool(name, config, handler)

alexia.onSettingsChanged(() => {
  // A new client or tenant, or a cleared sign-in: the token in memory may belong to the old one.
  svc.forget()
  void svc.report()
})

if (isEntry()) {
  await alexia.start()
  void svc.report()
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
