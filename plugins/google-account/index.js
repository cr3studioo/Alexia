// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { ArgumentError, calendarIds, createRequest, eventLine, eventsRequest, localDay, mapEvents, merge, noticeItems } from './calendar.js'
import { contactLine, findRequest, mapResults, warmupRequest } from './contacts.js'
import { listedIds, listRequest, mapMessage, messageLine, messageText, metadataRequest, readRequest } from './mail.js'
import { authUrl, call, exchangeCode, GoogleError, listen, LISTEN_MS, pkce, newState, REFUSED, Tokens } from './oauth.js'

/**
 * Google — the owner's calendar, mail and contacts, behind the P3 capabilities.
 *
 * The day planner, the mail desk, memory and the scheduler ask for `calendar.events`,
 * `mail.list`, `contacts.find` and the rest; none of them learns it is Google. Everything is
 * read only except `calendar.create`, which writes to Google and so is open-world: a proactive
 * run always asks first (D214). Mail is never marked read — there is no `modify` anywhere.
 *
 * Signing in is `oauth.js`. The access token lives in this process; the refresh token is a
 * `password` setting. Neither appears in a result, a log or an error.
 */

const DAY_MS = 24 * 60 * 60 * 1000

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
      text: error instanceof GoogleError || error instanceof ArgumentError ? error.message : 'Something went wrong talking to Google.',
    },
  ],
})

const num = (value, fallback) =>
  value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback

/**
 * Everything the tools do, with the host passed in so tests can stand in for it.
 *
 * - `settings()` — the current settings.
 * - `keep(key, value)` — write a `password` setting (the refresh token).
 * - `status(text)` — the `status` line on the settings screen.
 * - `open(url)` — ask the host to open a link; true if it did.
 * - `fetch` — the network; `clock` — now, in ms; `listenMs` — how long the sign-in waits.
 */
export function service({ settings, keep, status = async () => {}, open = async () => false, fetch: fetchImpl = fetch, clock = Date.now, listenMs = LISTEN_MS }) {
  // A refresh token from a sign-in this run, kept in memory in case the host would not store it.
  let signedIn
  const read = async () => {
    const s = await settings()
    return { ...s, refresh_token: s.refresh_token || signedIn }
  }
  const tokens = new Tokens({ read, fetch: fetchImpl, clock })
  const google = (req) => call(tokens, req, fetchImpl)
  let pending
  let warmed = false

  const say = (line) => status(line).catch(() => {})

  /** Runs a tool body; a refused sign-in also shows on the settings screen. */
  const guarded = async (body) => {
    try {
      return await body()
    } catch (error) {
      if (error instanceof GoogleError && error.message === REFUSED) await say(`▲ ${REFUSED}`)
      if (!(error instanceof GoogleError || error instanceof ArgumentError)) log.warn('a Google call failed', error?.name ?? 'error')
      return failure(error)
    }
  }

  /** Every configured calendar's events in a window, merged. */
  async function events(from, to) {
    const s = await settings()
    const lists = []
    for (const id of calendarIds(s.calendars)) {
      let page
      for (let i = 0; i < 4; i++) {
        const json = await google(eventsRequest(id, { from, to }, page))
        lists.push(mapEvents(json, id))
        page = json?.nextPageToken
        if (!page) break
      }
    }
    return merge(lists)
  }

  return {
    tokens,

    async report() {
      await say((await tokens.connected()) ? '● Connected' : '■ Not connected')
    },

    forget() {
      tokens.forget()
    },

    calendarEvents: (args = {}) =>
      guarded(async () => {
        const found = await events(args.from, args.to)
        return text(found.length === 0 ? 'Nothing on the calendar then.' : found.map(eventLine).join('\n'), { events: found })
      }),

    calendarCreate: (args = {}) =>
      guarded(async () => {
        const s = await settings()
        const req = createRequest(args, calendarIds(s.calendars)[0])
        const made = await google(req)
        const id = String(made?.id ?? '')
        return text(`Added “${req.body.summary}” to the calendar.`, { id })
      }),

    mailList: (args = {}) =>
      guarded(async () => {
        const req = listRequest(args)
        const ids = listedIds(await google(req)).slice(0, req.limit)
        const messages = []
        for (const id of ids) {
          try {
            messages.push(mapMessage(await google(metadataRequest(id))))
          } catch (error) {
            // Gone between the list and the fetch: skip it. Anything else is the whole answer.
            if (!(error instanceof GoogleError && error.status === 404)) throw error
          }
        }
        return text(messages.length === 0 ? 'No mail matches.' : messages.map(messageLine).join('\n'), { messages })
      }),

    mailRead: (args = {}) =>
      guarded(async () => {
        const body = messageText(await google(readRequest(args.id)))
        return text(body, { text: body })
      }),

    contactsFind: (args = {}) =>
      guarded(async () => {
        const req = findRequest(args.query)
        if (!warmed) {
          // Google's contact search answers from a cache an empty search warms. Its failure
          // is not this search's failure: the real one says what went wrong.
          await google(warmupRequest()).catch(() => {})
          warmed = true
        }
        const contacts = mapResults(await google(req))
        return text(contacts.length === 0 ? 'No contact matches.' : contacts.map(contactLine).join('\n'), { contacts })
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
     * The Connect button. Starts the one-shot listener, opens Google's page through the host,
     * and returns at once; the rest happens when the browser comes back.
     */
    async connect() {
      const s = await settings()
      if (!s.client_id) {
        return failure(new GoogleError('Put your Google client ID (and secret) in first. The README says how to make them.'))
      }
      pending?.close()
      const state = newState()
      const pair = pkce()
      let listener
      try {
        listener = await listen({ state, timeoutMs: listenMs })
      } catch {
        return failure(new GoogleError('Alexia could not open a local port for the sign-in. Try again.'))
      }
      pending = listener
      const url = authUrl({ clientId: s.client_id, redirectUri: listener.redirectUri, challenge: pair.challenge, state })
      await say('▲ Waiting for you to sign in to Google in the browser')

      const finished = listener.result
        .then(({ code }) =>
          exchangeCode({
            fetch: fetchImpl,
            clientId: s.client_id,
            clientSecret: s.client_secret,
            code,
            verifier: pair.verifier,
            redirectUri: listener.redirectUri,
            now: clock(),
          }),
        )
        .then(async (got) => {
          signedIn = got.refreshToken
          tokens.hold(got.accessToken, got.expiresAt)
          let kept = true
          try {
            await keep('refresh_token', got.refreshToken)
          } catch {
            kept = false
          }
          await say(kept ? '● Connected' : '▲ Connected until Alexia restarts: the sign-in could not be saved in the keychain')
          return true
        })
        .catch(async (error) => {
          await say(`▲ ${error instanceof GoogleError ? error.message : REFUSED}`)
          return false
        })
        .finally(() => {
          if (pending === listener) pending = undefined
        })

      const opened = await open(url).catch(() => false)
      const result = opened ?
          text('Google’s sign-in page is open in your browser. When it says you can close the tab, Google is connected.')
        : {
            ...text(`Open this link to sign in to Google. It works for the next ${Math.round(listenMs / 60000)} minutes, on this computer only:\n${url}`),
            _meta: { 'alexia/card': { title: 'Sign in to Google', fields: [], url } },
          }
      // For tests and for a caller that wants to wait; never part of what a tool returns.
      Object.defineProperty(result, 'finished', { value: finished, enumerable: false })
      return result
    },
  }
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

/** The tools, as `[name, config, handler]`, so a test can read their annotations. */
export function tools(svc) {
  return [
    [
      'calendar_events',
      {
        description:
          'Events on the owner’s Google calendars between `from` and `to` (ISO date-times or epoch ms), recurring ones expanded.',
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
          'Add an event to the owner’s Google calendar. `start`/`end` are ISO date-times, or YYYY-MM-DD for an all-day event. ' +
          'Anyone in `attendees` is sent an invitation by Google.',
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
        // It writes to Google, so it is open-world, and a proactive run always asks (D214).
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
          'Recent Gmail messages: sender, subject, snippet, labels and whether unread. Never marks anything read. ' +
          '`query` is Gmail search syntax; `since` an ISO date-time or epoch ms; `limit` at most 50 (default 20).',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            since: { type: ['string', 'number'], description: 'Only mail after this: ISO date-time or epoch ms.' },
            query: { type: 'string', description: 'Gmail search, e.g. "is:unread from:school".' },
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
        description: 'The text of one Gmail message, by the `id` from mail_list. Plain text; HTML is stripped. Never marks it read.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: { id: { type: 'string', description: 'The message id from mail_list.' } },
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
        description: 'Find people in the owner’s Google contacts by name, email or phone: their emails, phones and birthday.',
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
          'Calendar deadlines worth raising now (events titled Deadline, Due, Odevzdat or Termín in the next `horizon_days`), ' +
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
        description: 'Connect the owner’s Google account: opens Google’s sign-in page and waits for it to come back.',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      () => svc.connect(),
    ],
  ]
}

const alexia = plugin()

/** Ask the host to open a link: MCP's URL-mode elicitation. False when the host cannot. */
async function openLink(url) {
  try {
    const answer = await alexia.server.server.elicitInput(
      { mode: 'url', message: 'Sign in to Google to connect it to Alexia.', url, elicitationId: randomUUID() },
      { timeout: 60_000 },
    )
    return answer?.action === 'accept'
  } catch {
    return false
  }
}

const svc = service({
  settings: () => alexia.settings(),
  keep: (key, value) => alexia.call('alexia/settings/set', { key, value }),
  status: (line) => alexia.status('status', line),
  open: openLink,
})

for (const [name, config, handler] of tools(svc)) alexia.tool(name, config, handler)

alexia.onSettingsChanged(() => {
  // A new client or a cleared sign-in: the token in memory may belong to the old one.
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
