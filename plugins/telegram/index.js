// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { chunk, me, send, TelegramError, updates } from './api.js'

/**
 * Telegram (M4-1) — the shape the contract had not met yet.
 *
 * Voice was core calling into a plugin. This is the other direction: **a message arrives
 * from outside**, hours after anybody last touched Alexia, and the plugin has to be alive
 * to receive it. That is what broke lazy spawn and produced `lifetime: "resident"` (D77),
 * which is exactly what M4 is for — the contract cracking somewhere a real plugin pushed
 * on it, before anybody else depends on the shape.
 *
 * The other two things it exercises, both deliberately:
 *
 * - **A credential.** The bot token goes to the OS keychain through a `password` setting
 *   and is read back per use. It is never in the database and never in a log.
 * - **Storage it owns.** The conversation per chat is in this plugin's namespace, so
 *   deleting the plugin takes every message with it and invariant 5 can prove it.
 *
 * **The marker is not optional.** Local mode means the model runs on this machine. It has
 * never meant that words stay here, and Telegram is the plugin that makes that concrete —
 * so a conversation carries a visible mark that it crossed Telegram's servers, and the
 * mark is written here rather than left to whoever reads the log.
 */

const alexia = plugin()

/** How long Telegram holds the poll open. Long enough that the loop is nearly always waiting. */
const POLL_SECONDS = 50
/** Say it again after a gap this long. A mark on message one is not a mark on message fifty. */
const REMARK_AFTER = 60 * 60 * 1000

/** Everything the poll loop needs to be stopped and restarted when the token changes. */
let running
let stopping

const settings = () => alexia.settings()

/** The allowlist. Telegram user ids, as strings, so JSON and comparisons agree. */
const allowed = async () => new Set((await alexia.storage.get('allowed')) ?? [])

/**
 * The pairing code.
 *
 * No account system, no OAuth, no callback URL. A short code shown in the desktop UI and
 * sent to the bot from the account that should be allowed — which proves the person at the
 * Telegram end is the person at the Alexia end, and is the whole of the auth story.
 *
 * Six digits: it is typed once, into a chat, by somebody who is looking at it, and the bot
 * is not discoverable unless its owner shares the handle.
 */
async function code() {
  let held = await alexia.storage.get('pairing_code')
  if (typeof held !== 'string' || held.length !== 6) {
    held = String(Math.floor(100000 + Math.random() * 900000))
    await alexia.storage.set('pairing_code', held)
  }
  return held
}

/** One line, on the screen where the token is typed. It is the plugin reporting itself. */
async function report() {
  const { bot_token: bot } = await settings()
  const who = await allowed()
  const state =
    !bot ? '■ No bot token yet'
    : running === undefined ? '▲ Not connected'
    : who.size === 0 ? `▲ Waiting to be paired — send ${await code()} to the bot`
    : `● Listening — ${who.size} account${who.size === 1 ? '' : 's'} allowed`
  await alexia.status('state', state).catch(() => {})
  await alexia.status('pairing_code', who.size === 0 ? await code() : 'paired').catch(() => {})
}

/**
 * The mark, per conversation.
 *
 * Said on the first reply in a chat and again after a gap, rather than on every message —
 * a line repeated fifty times is a line nobody reads, and the point is that it is read.
 * It says what happened; it does not editorialise and it does not promise anything.
 */
async function marked(chatId, text) {
  const last = (await alexia.storage.get('marked')) ?? {}
  const now = Date.now()
  const said = last[chatId]
  if (typeof said === 'number' && now - said < REMARK_AFTER) return text
  await alexia.storage.set('marked', { ...last, [chatId]: now })
  return `${text}\n\n— via Telegram. This conversation goes through Telegram's servers.`
}

/** What has been said in this chat, oldest first, as the model gets it. */
async function history(chatId, limit = 20) {
  const rows = await alexia.storage.select('chats', {
    where: { chat_id: String(chatId) },
    order: [['at', 'desc']],
    limit,
  })
  return rows
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: String(row.text) }))
}

const remember = (chatId, role, text) =>
  alexia.storage.insert('chats', { chat_id: String(chatId), role, text, at: Date.now() })

/**
 * Answer one message.
 *
 * The model comes from Alexia, over MCP's own `sampling/createMessage` — not from a key
 * this plugin holds. A plugin with its own model key would be a second place the user pays
 * from and a second place their words go, and neither of those would show up in the spend
 * panel or the privacy mode.
 */
async function answer(token, chatId, text) {
  await remember(chatId, 'user', text)
  const asked = await history(chatId)
  const result = await alexia.server.server.createMessage({
    messages: asked.map((turn) => ({ role: turn.role, content: { type: 'text', text: turn.content } })),
    systemPrompt:
      'You are Alexia, answering over Telegram. Keep replies short — this is a phone. ' +
      'You have no tools on this path, so answer from what you know or say what you would need.',
    maxTokens: 800,
  })
  const said = result.content?.type === 'text' ? result.content.text : ''
  await remember(chatId, 'assistant', said)
  for (const part of chunk(await marked(chatId, said || 'I had nothing to say to that.'))) {
    await send(token, chatId, part)
  }
}

/** Somebody Alexia has never heard from. One question, and only one. */
async function greet(token, chatId, from, text) {
  const expected = await code()
  if (text.trim() === expected) {
    const who = await allowed()
    who.add(String(from))
    await alexia.storage.set('allowed', [...who])
    // A code that has been used is spent. Leaving it live would mean one screenshot of the
    // settings screen is a permanent way in.
    await alexia.storage.set('pairing_code', String(Math.floor(100000 + Math.random() * 900000)))
    await send(token, chatId, 'Paired. Alexia is listening on this account now.')
    await report()
    return
  }
  await send(
    token,
    chatId,
    'Alexia does not know you yet. Open Alexia, go to Plugins, and send me the six-digit pairing code shown there.',
  )
}

/**
 * The long poll.
 *
 * One request that Telegram holds open until something arrives. No webhook, no port, no
 * firewall dialog — which is why this shape was chosen and why the plugin has to stay
 * alive to hold it.
 *
 * Nothing in here is allowed to end the loop except being told to stop. A network blip, a
 * message that fails to answer, a model that refused — all of them are one iteration going
 * wrong, and the loop that exits on the first of them is a bridge that silently stops
 * working at 3am.
 */
async function poll(token, signal) {
  let offset
  let backoff = 1000
  while (!signal.aborted) {
    try {
      const batch = await updates(token, offset, POLL_SECONDS, signal)
      backoff = 1000
      for (const update of batch) {
        // `last + 1` is the acknowledgement. Advance it even for a message that throws
        // below, or one bad message is replayed forever.
        offset = update.update_id + 1
        const message = update.message
        const text = message?.text
        if (!message || typeof text !== 'string') continue
        const from = message.from?.id
        const chatId = message.chat?.id
        if (from === undefined || chatId === undefined) continue
        try {
          if ((await allowed()).has(String(from))) await answer(token, chatId, text)
          else await greet(token, chatId, from, text)
        } catch (error) {
          log.warn('could not answer', error)
          // The person on the other end is waiting. Silence is the one answer that is
          // certainly wrong, so whatever went wrong is said in their chat.
          await send(token, chatId, `Something went wrong here: ${String(error?.message ?? error)}`).catch(() => {})
        }
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof TelegramError && error.status === 401) {
        // The token is wrong. Retrying cannot fix it and only the user can, so stop and say
        // so on the screen where the token is typed.
        log.error('Telegram refused the bot token')
        running = undefined
        await alexia.status('state', '▲ Telegram refused that bot token').catch(() => {})
        return
      }
      log.warn('poll failed, retrying', error)
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

/** Start, restart, or stop the connection, depending on whether there is a token now. */
async function connect() {
  stopping?.abort()
  stopping = undefined
  running = undefined

  const { bot_token: token } = await settings()
  if (!token) {
    await report()
    return
  }
  try {
    const who = await me(token)
    running = who.username ?? 'bot'
  } catch (error) {
    log.error('could not reach Telegram', error)
    await alexia.status('state', `▲ ${String(error?.message ?? error)}`).catch(() => {})
    return
  }
  stopping = new AbortController()
  void poll(token, stopping.signal)
  await report()
  bind()
}

/**
 * The runtime half of `provides`. `telegram.send` is answerable only when there is a token
 * and somebody paired — before that it is a promise this plugin cannot keep, and a caller
 * is better served by `-32050` than by a tool that fails halfway.
 */
async function bind() {
  const paired = (await allowed()).size > 0
  pushed.update({ _meta: running && paired ? { 'alexia/provides': ['telegram.send'] } : {} })
}

const pushed = alexia.tool(
  'send',
  {
    description:
      'Send a message to the paired Telegram account. Use when the user asks to be told ' +
      'something on their phone, or to be notified once a long job finishes. The message ' +
      'goes through Telegram servers.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to send.' } },
      required: ['text'],
    }),
    // Not read-only: sending somebody a message is a thing that happens in the world, and
    // it leaves this machine. The default mode asks first, which is correct.
    annotations: { openWorldHint: true },
  },
  async ({ text }) => {
    const { bot_token: token } = await settings()
    const chats = await alexia.storage.select('chats', { order: [['at', 'desc']], limit: 1 })
    const chatId = chats[0]?.chat_id
    if (!token || chatId === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Telegram is not paired yet, so there is nowhere to send that.' }],
      }
    }
    for (const part of chunk(String(text))) await send(token, chatId, part)
    return { content: [{ type: 'text', text: 'Sent, through Telegram.' }] }
  },
)

alexia.tool(
  'paired',
  {
    description: 'Say who is allowed to reach Alexia from Telegram, and the pairing code if nobody is yet.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const who = await allowed()
    const text =
      who.size === 0 ?
        `Nobody is paired. Send ${await code()} to the bot from the Telegram account you want to allow.`
      : `${who.size} Telegram account${who.size === 1 ? '' : 's'} can reach Alexia. Messages both ways cross Telegram's servers.`
    return { content: [{ type: 'text', text }] }
  },
)

alexia.tool(
  'unpair',
  {
    description: 'Forget every Telegram account that was allowed, and make a new pairing code.',
    // It removes something a person set up. The gate asks in every mode but Full trust,
    // which is the right answer for a button that revokes access.
    annotations: { destructiveHint: true },
  },
  async () => {
    await alexia.storage.set('allowed', [])
    await alexia.storage.set('pairing_code', String(Math.floor(100000 + Math.random() * 900000)))
    await bind()
    await report()
    return { content: [{ type: 'text', text: `Forgotten. The new pairing code is ${await code()}.` }] }
  },
)

await alexia.start()
await connect()
// A token typed, replaced or cleared means the connection this plugin is holding is the
// wrong one. Reconnect rather than waiting for a restart nobody is going to do.
alexia.onSettingsChanged((changed) => {
  if ('bot_token' in changed) void connect()
})
log.info(`${alexia.manifest.name} is ready`)
