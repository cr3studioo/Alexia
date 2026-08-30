// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { answered, chunk, filePath, me, send, sendVoice, TelegramError, unbutton, updates } from './api.js'
import { Asking } from './asking.js'

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

/**
 * The open questions, and the chat they belong in (M7-5).
 *
 * One chat, because there is one task at a time — core says so, and this plugin is one of
 * the two places a task can start. The chat is the one whose message started it, which is
 * the only place an answer would make sense.
 */
const asking = new Asking()
let asked

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
/**
 * A slash command, from the one place that had no way to type one.
 *
 * **Core runs it, not this plugin.** `/local`, `/cheap`, a plugin's own command and `/new`
 * are core's, and a copy of them here would be a second list to keep in step with the first
 * — so what goes over is the line as typed, and what comes back is core's own sentence.
 *
 * The one thing this end must do is `/new`: core rotates the conversation it writes down,
 * and the history the model is *shown* is this plugin's, in its own namespace. Clearing it
 * is what makes a new chat new; without it the words would keep arriving in the next one.
 */
async function command(token, chatId, text) {
  if (/^\/new\b/i.test(text)) await alexia.storage.delete('chats', { chat_id: String(chatId) })
  const result = await alexia.server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text } }],
    maxTokens: 400,
    _meta: { 'alexia/tools': true },
  })
  const said = result.content?.type === 'text' ? result.content.text : ''
  for (const part of chunk(said || 'Done.')) await say(token, chatId, part)
}

async function answer(token, chatId, text) {
  // Not remembered and carrying no history: a command is an instruction to Alexia, not a
  // turn in the conversation, and `/new` clears the conversation it would have been in.
  if (text.startsWith('/')) return command(token, chatId, text)
  await remember(chatId, 'user', text)
  const turns = await history(chatId)
  // Where the permission questions go while this runs. Set before the call, because the
  // question can arrive before the answer does.
  asked = { token, chatId }
  let result
  try {
    result = await alexia.server.server.createMessage({
      messages: turns.map((turn) => ({ role: turn.role, content: { type: 'text', text: turn.content } })),
      systemPrompt:
        'You are Alexia, answering over Telegram. Keep replies short — this is a phone. ' +
        'You have tools, and anything needing permission will be asked in this chat.',
      maxTokens: 800,
      /**
       * *Use my tools, and ask me when you must* (M7-5).
       *
       * This line is the whole of what changed. The sentence it replaced — *you have no
       * tools on this path* — was this plugin being honest about a real limit: there was
       * nowhere to ask a permission question from a phone, so rather than a task hanging on
       * a prompt nobody could see, the path carried no tools at all. `ask.confirm` is the
       * somewhere, and the tools come back with it.
       */
      _meta: { 'alexia/tools': true },
    })
  } finally {
    asked = undefined
  }
  const said = result.content?.type === 'text' ? result.content.text : ''
  await remember(chatId, 'assistant', said)
  const words = await marked(chatId, said || 'I had nothing to say to that.')

  // A voice note when there is a voice that can make one, and words when there is not. The
  // marker line is text either way: a promise about where words went, read out loud, is a
  // promise nobody can scroll back to.
  if (await spoken(token, chatId, said)) return
  for (const part of chunk(words)) await say(token, chatId, part)
}

/**
 * The answer as a voice bubble, if anything can make one (M7-5, M7-4).
 *
 * `voice.render` is bound only while a cloned voice is chosen, because that is the only one
 * that returns Ogg/Opus and Telegram plays anything else as a file attachment. Nothing
 * provides it → false → words, which is the ordinary case and not a failure.
 */
async function spoken(token, chatId, said) {
  if (!said.trim()) return false
  const { voice_notes: wanted } = await settings()
  if (wanted !== true) return false
  try {
    const made = await alexia.capability('voice.render', { text: said })
    const audio = (made.content ?? []).find((block) => block.type === 'audio' && block.mimeType === 'audio/ogg')
    if (!audio) return false
    await sendVoice(token, chatId, Buffer.from(audio.data, 'base64'))
    return true
  } catch {
    // Nothing renders, or it failed. Either way the answer still has to arrive.
    return false
  }
}

/**
 * Send it, and if Telegram is unreachable put it somewhere it can still be seen (M7-5).
 *
 * **A fallback, and never a replacement.** ntfy has no buttons and no threading, so a
 * permission question does not go down it — there is nothing to press. What it is for is the
 * case where Telegram itself is down and an answer would otherwise vanish: *the message
 * landed somewhere* is worth having and worth not overselling. Off unless somebody has typed
 * a topic, because a fallback nobody configured is a fallback to nowhere.
 */
async function say(token, chatId, text, buttons) {
  try {
    return await send(token, chatId, text, undefined, buttons)
  } catch (error) {
    const { ntfy_topic: topic } = await settings()
    if (!topic) throw error
    // Buttons cannot cross, so a message that needed one is not sent at all rather than sent
    // unanswerable — a question with no way to answer it is worse than a question that did
    // not arrive, because it looks answered to whoever sent it.
    if (buttons) throw error
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { title: 'Alexia' },
      body: text.slice(0, 4000),
    }).catch(() => {
      throw error
    })
    log.warn('Telegram was unreachable, so it went to ntfy instead', error)
    return undefined
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
 * A voice note, as words (M7-5).
 *
 * The direction that needed nothing new: `voice.transcribe` has been in the registry since
 * M2, and a Telegram voice message is a file with a path. Nothing provides it → undefined →
 * the message is skipped, which is what happens today for anything that is not text.
 */
async function heard(token, message) {
  const file = message.voice?.file_id ?? message.audio?.file_id
  if (file === undefined) return undefined
  try {
    const url = await filePath(token, file)
    const response = await fetch(url)
    if (!response.ok) return undefined
    const dir = await alexia.host().then((info) => info.ownDir)
    const path = `${dir}/incoming.ogg`
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const said = await alexia.capability('voice.transcribe', { file: path })
    return (said.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('').trim()
  } catch (error) {
    log.warn('could not hear that voice note', error)
    return undefined
  }
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

        /**
         * A button was pressed (M7-5).
         *
         * Answered first and unbuttoned second, in that order: Telegram spins on the button
         * until `answerCallbackQuery` arrives, and a message whose buttons are gone cannot
         * be answered twice by somebody scrolling back.
         */
        const press = update.callback_query
        if (press) {
          const who = press.from?.id
          if (who === undefined || !(await allowed()).has(String(who))) {
            await answered(token, press.id, 'Not for you.').catch(() => {})
            continue
          }
          const chose = asking.press(press.data)
          await answered(token, press.id, chose ?? 'That question has gone.').catch(() => {})
          if (press.message?.chat?.id !== undefined && press.message.message_id !== undefined) {
            await unbutton(token, press.message.chat.id, press.message.message_id).catch(() => {})
          }
          continue
        }

        const message = update.message
        const from = message?.from?.id
        const chatId = message?.chat?.id
        if (!message || from === undefined || chatId === undefined) continue
        // A voice note is a message too, and the other direction already existed: this is
        // `voice.transcribe`, which has been in the registry since M2.
        const text = typeof message.text === 'string' ? message.text : await heard(token, message)
        if (typeof text !== 'string' || text === '') continue
        try {
          if ((await allowed()).has(String(from))) await answer(token, chatId, text)
          else await greet(token, chatId, from, text)
        } catch (error) {
          log.warn('could not answer', error)
          // The person on the other end is waiting. Silence is the one answer that is
          // certainly wrong, so whatever went wrong is said in their chat.
          await say(token, chatId, `Something went wrong here: ${String(error?.message ?? error)}`).catch(() => {})
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
  // Nobody is listening for a press any more, so every open question settles as unanswered
  // — which core reads as no. A token that outlived its loop is a button that does nothing.
  asking.close()

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
  const live = running !== undefined && paired
  pushed.update({ _meta: live ? { 'alexia/provides': ['telegram.send'] } : {} })
  // The same condition, and for the same reason: a question sent to a chat nobody is paired
  // with is a question nobody will ever answer, and core reads *no answer* as no.
  confirmed.update({ _meta: live ? { 'alexia/provides': ['ask.confirm'] } : {} })
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

/**
 * The yes, from the phone (M7-5).
 *
 * **The ruling stays in core.** The permission modes decided that this step needs a person;
 * the consent ladder decided what the answer means. All this does is put the question
 * somewhere it can be seen and hand the answer back — which is the whole of what was
 * missing, and the reason this path carried no tools until now.
 *
 * It waits, and it waits without a timeout on purpose: the thing on the other end is a
 * person, and a permission question that expired after thirty seconds would be a task that
 * failed because somebody was making tea. Core's own stop control is what ends it early.
 */
const confirmed = alexia.tool(
  'confirm',
  {
    description:
      'Ask the paired Telegram account a question with buttons, and wait for one to be ' +
      'pressed. Returns the option that was chosen. Called by Alexia itself.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to ask.' },
        options: { type: 'array', items: { type: 'string' }, description: 'The buttons, in order.' },
      },
      required: ['question'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ question, options }) => {
    const { bot_token: token } = await settings()
    // The chat whose message started the task, when there is one — a question about a task
    // belongs where the task was asked for. Otherwise the most recent chat, which is the
    // only other place it could mean anything.
    const chats = await alexia.storage.select('chats', { order: [['at', 'desc']], limit: 1 })
    const chatId = asked?.chatId ?? chats[0]?.chat_id
    if (!token || chatId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Telegram is not paired, so there is nobody to ask.' }] }
    }
    const choices = Array.isArray(options) && options.length > 0 ? options.map(String) : ['Yes', 'No']
    const { buttons, answer } = asking.ask(choices)
    // No ntfy fallback for this one: a question with no way to answer it is worse than a
    // question that did not arrive, because it looks answered to whoever sent it.
    await send(token, chatId, String(question ?? 'Alexia is asking.'), undefined, buttons)
    const chose = await answer
    return { content: [{ type: 'text', text: chose ?? 'No' }] }
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
