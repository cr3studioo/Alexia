// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Acks } from './acks.js'
import {
  act,
  answered,
  chunk,
  filePath,
  LIMIT,
  me,
  react,
  send,
  sendDocument,
  sendPhoto,
  sendRich,
  sendVoice,
  TelegramError,
  unbutton,
  updates,
} from './api.js'
import { Asking } from './asking.js'
import { forRich, MARKER, RICH_LIMIT, withMarker } from './format.js'
import { bestPhoto, fileTurn, kindOf, photoNote, safeName, tooBig } from './incoming.js'
import { Line } from './line.js'
import { EVERY, Presence } from './presence.js'
import { speaks, voiceMode } from './reply.js'
import { bare, stops } from './slash.js'

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
/**
 * How long an answer may go without a word from core (D192).
 *
 * The SDK's own default is sixty seconds, and every task from the phone that took longer —
 * a permission question, a picture, a slow tool — was cancelled at exactly one minute, which
 * core rightly reads as this plugin giving up. Ten minutes, reset whenever core reports
 * progress: until core sends any, a ceiling; once it does, ten minutes of silence.
 */
const ANSWER_WAIT = 10 * 60_000

/** Everything the poll loop needs to be stopped and restarted when the token changes. */
let running
let stopping
/**
 * The token the loop was started with, for the one caller that is not the loop: the typing
 * heartbeat, which ticks every four seconds and has no business reading the keychain each
 * time. Held exactly as long as `poll` holds the same string, and dropped with it.
 */
let live

/**
 * The messages from paired accounts, answered one at a time in the order they came (D192).
 * The poll loop pushes and goes back to listening — see `line.js` for why it must.
 */
const line = new Line((error) => log.warn('a queued message failed', error))

/**
 * Which updates are finished, and so where a restart should come back to (D194).
 *
 * Not the same number as the loop's own `offset`, and `acks.js` is the whole argument for
 * why: the loop must move past a message the moment it queues it, or the next poll hands it
 * out again while the first answer is still being written. What survives a crash has to be
 * the other number — the oldest update nobody has finished with.
 */
const acks = new Acks()

/** *Typing…* while an answer is being made. Cosmetic: a failure is one log line, once. */
const presence = new Presence(
  (chatId, action) => (live ? act(live, chatId, action) : undefined),
  EVERY,
  (error) => log.warn('could not show typing — answers are unaffected', error),
)

/**
 * The answer being written now, and the way to stop it (D192): `{ controller, chatId }`,
 * or undefined between answers.
 *
 * Out here rather than inside `answer` so that whatever stops it — `/stop`, next — can reach
 * it from the poll loop, without being queued behind the very answer it is stopping. Aborting
 * `controller` cancels the `sampling` request, and core ends the task when a plugin cancels.
 */
let current

/** An answer that was stopped on purpose. Not a failure, and nothing more to say about it. */
class Stopped extends Error {}

/**
 * Was that the stop, or something genuinely going wrong (D194)?
 *
 * The signal is the answer that can be trusted: `/stop` aborts the controller, and whatever
 * the rejection turns out to look like, the abort is why it happened. The other two are what
 * an abort looks like from further away — the platform's own `AbortError`, and the sentence
 * MCP wraps a cancelled request in on its way back across the wire. A stop dressed up as
 * *something went wrong here* would be the plugin reporting a fault the person just asked for.
 */
function wasStopped(signal, error) {
  if (signal.aborted) return true
  if (error?.name === 'AbortError') return true
  return /\b(?:aborted|cancell?ed)\b/i.test(String(error?.message ?? error))
}

/**
 * Whether rich messages have been given up on for the rest of the session (D194).
 *
 * A Bot API old enough not to have `sendRichMessage` answers 404, and it will answer 404 to
 * the next message too — so that is asked once and remembered, rather than a wasted round
 * trip on every reply for as long as the plugin runs. A single message Telegram would not
 * parse is a different thing and does not set this: it falls back on its own and the next
 * message is tried rendered again.
 */
let plainOnly = false

/**
 * The field that makes a message quote the one it answers (D194).
 *
 * `allow_sending_without_reply` is the half worth naming: a message that has been deleted, or
 * is too old for Telegram to quote, would otherwise take the whole reply down with it. An
 * answer that arrives unthreaded is a small loss; an answer that does not arrive is not.
 */
const quoting = (messageId) =>
  messageId === undefined ? undefined : (
    { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
  )

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
 * Is the mark due in this conversation?
 *
 * Said on the first reply in a chat and again after a gap, rather than on every message —
 * a line repeated fifty times is a line nobody reads, and the point is that it is read.
 * It says what happened; it does not editorialise and it does not promise anything.
 *
 * **Whether, not what** (D194). The sentence used to be glued on here, which was fine while
 * there was one way to send it; there are three now — italic inside a rendered message, plain
 * in the fallback, and on its own line after a voice note that cannot carry it. `withMarker`
 * in `format.js` composes it, and asking counts as saying it, so the caller has to be the one
 * that gets it out.
 */
async function marked(chatId) {
  const last = (await alexia.storage.get('marked')) ?? {}
  const now = Date.now()
  const said = last[chatId]
  if (typeof said === 'number' && now - said < REMARK_AFTER) return false
  await alexia.storage.set('marked', { ...last, [chatId]: now })
  return true
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
async function command(token, chatId, text, quote = () => undefined) {
  /**
   * `/status@AlexiaBot` is what the *"/"* menu sends (D194).
   *
   * The suffix is Telegram's own way of saying which bot a command in a group was meant for,
   * and it has done its job by the time the update is read here. Core has never heard of it,
   * so leaving it on turns every command tapped from the menu into one core answers *there is
   * no such thing* to — a menu whose own entries do not work.
   */
  const typed = bare(text)
  if (/^\/new\b/i.test(typed)) await alexia.storage.delete('chats', { chat_id: String(chatId) })
  const result = await alexia.server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: typed } }],
    maxTokens: 400,
    _meta: { 'alexia/tools': true },
  })
  const said = result.content?.type === 'text' ? result.content.text : ''
  for (const part of chunk(said || 'Done.', plainOnly ? LIMIT : RICH_LIMIT)) {
    await say(token, chatId, part, { extra: quote() })
  }
}

/**
 * Answer one message.
 *
 * The model comes from Alexia, over MCP's own `sampling/createMessage` — not from a key
 * this plugin holds. A plugin with its own model key would be a second place the user pays
 * from and a second place their words go, and neither of those would show up in the spend
 * panel or the privacy mode.
 *
 * `turn` is what arrived, already read: `{ text, image?, note?, cameAsVoice }` (D194). The
 * text is what the model is shown, `note` is the shorter thing the conversation keeps, and
 * `messageId` is the message every part of this answer hangs off.
 */
async function answer(token, chatId, turn, messageId) {
  /**
   * **The first thing sent quotes the question** (D194).
   *
   * Messages queue now, so an answer can land several minutes and two other messages after
   * the thing it answers, and a phone screen gives no other clue which is which. Only the
   * first: a threaded answer says *this belongs to that*, and five bubbles all quoting the
   * same line say it four times too often. Whatever goes out first takes it — a file, a
   * voice note or the words — and the rest follow it down the thread.
   */
  let unsent = quoting(messageId)
  const quote = () => {
    const held = unsent
    unsent = undefined
    return held
  }
  // Not remembered and carrying no history: a command is an instruction to Alexia, not a
  // turn in the conversation, and `/new` clears the conversation it would have been in.
  if (turn.image === undefined && turn.text.startsWith('/')) return command(token, chatId, turn.text, quote)
  // What is written down is the short form when there is one: a photo is `[a photo]` and a
  // file is its name, because the bytes and the whole of a document's text are this turn's
  // business and not every turn after it.
  await remember(chatId, 'user', turn.note ?? turn.text)
  const turns = await history(chatId)
  const messages = turns.map((row) => ({ role: row.role, content: { type: 'text', text: row.content } }))
  /**
   * **This turn, in full, and with the picture on it** (D194).
   *
   * The row just written down is the short note; what the model is shown in its place is
   * everything that arrived — a document's text, or the caption with the image block beside
   * it. MCP lets one turn carry an array of blocks (`SamplingMessageSchema`), and core
   * flattens it with `asParts`, which turns an image block into the `data:` URL a provider
   * wants and picks a model that can see. Anything older ignores the array and reads the text,
   * which is the caption — so a photo degrades to a sentence rather than to an error.
   */
  const mine = messages.findLastIndex((message) => message.role === 'user')
  if (mine >= 0) {
    messages[mine].content =
      turn.image ? [{ type: 'text', text: turn.text }, turn.image] : { type: 'text', text: turn.text }
  }
  // Where the permission questions go while this runs. Set before the call, because the
  // question can arrive before the answer does.
  asked = { token, chatId }
  const controller = new AbortController()
  current = { controller, chatId }
  let result
  try {
    result = await alexia.server.server.createMessage({
      messages,
      // Context, not an identity. It used to open *You are Alexia* — a second system line
      // landing after a chosen personality, which is the order in which the plain one wins.
      // Core says who she is; this says only what core cannot know about where she is.
      systemPrompt:
        'This conversation is happening over Telegram. Keep replies short — this is a phone. ' +
        // Only while it is true. Telling a model its Markdown will render, on a Bot API that
        // turned out not to render any, is asking for a reply full of asterisks (D194).
        (plainOnly ? '' : 'Markdown is rendered here, so use it where it earns its place. ') +
        'Anything needing permission will be asked in this chat.',
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
    }, {
      signal: controller.signal,
      // Not the SDK's sixty seconds, which a question waiting on a person outlasts (D192).
      timeout: ANSWER_WAIT,
      resetTimeoutOnProgress: true,
      // Asking for progress is what puts a token on the request for core to report against;
      // the words themselves are for later, so nothing listens yet.
      onprogress: () => {},
    })
  } catch (error) {
    // `/stop` pressed the button on this one. It is not a fault and the loop has already said
    // so in this chat, so it travels as its own kind of error and dies quietly in `handled`.
    if (wasStopped(controller.signal, error)) throw new Stopped('stopped from the phone')
    throw error
  } finally {
    asked = undefined
    // Only while it is still this answer's: the handle belongs to whichever answer is running,
    // and one that finishes late must never take it from the answer after it.
    if (current?.controller === controller) current = undefined
  }
  const said = result.content?.type === 'text' ? result.content.text : ''
  await remember(chatId, 'assistant', said)
  const words = said || 'I had nothing to say to that.'
  const due = await marked(chatId)

  // A file the task made — a picture, a report — first (D122). It is usually the thing that
  // was asked for, and it crosses Telegram's servers like the words next to it, which the
  // marker says.
  await delivered(token, chatId, result, quote)

  // A voice note when the form the question came in asks for one, and words when it does not.
  // The marker line is text either way: a promise about where words went, read out loud, is a
  // promise nobody can scroll back to.
  if (await spoken(token, chatId, said, turn.cameAsVoice, quote)) {
    if (due) await say(token, chatId, MARKER, { rich: false })
    return
  }
  // Rendered, so the limit is Telegram's rich one — eight times the room, which is the whole
  // difference between an answer arriving as one bubble and as eight (D194).
  const whole = due ? withMarker(words, !plainOnly) : words
  for (const part of chunk(whole, plainOnly ? LIMIT : RICH_LIMIT)) {
    await say(token, chatId, part, { extra: quote() })
  }
}

/**
 * The files on `alexia/files`, if core sent any (D122).
 *
 * Core reads the bytes and returns them base64 on the result's `_meta`, because this plugin
 * runs in its own process and cannot reach the `/api/file` route the window uses. A raster
 * image goes as a photo for the inline preview; everything else — a PDF, a zip — goes as a
 * document. A file that fails to send is one line in the log, never a dropped answer.
 */
async function delivered(token, chatId, result, quote = () => undefined) {
  const files = result?._meta?.['alexia/files']
  if (!Array.isArray(files)) return
  for (const file of files) {
    const bytes = Buffer.from(String(file?.data ?? ''), 'base64')
    if (bytes.length === 0) continue
    const asPhoto = /^image\/(png|jpe?g|webp|gif)$/i.test(String(file.mime)) && bytes.length <= 10 * 1024 * 1024
    // *Sending photo…* rather than *typing…* over an upload (D192).
    presence.as(chatId, asPhoto ? 'upload_photo' : 'upload_document')
    // Taken once and used on both attempts: a photo that comes back as a document is the same
    // answer to the same question, and the thread it hangs off should not depend on which.
    const extra = quote()
    try {
      if (asPhoto) await sendPhoto(token, chatId, bytes, file.name, undefined, undefined, extra)
      else await sendDocument(token, chatId, bytes, file.name, undefined, undefined, extra)
    } catch (error) {
      // A photo Telegram would not take (odd dimensions, say) still goes as a document.
      if (asPhoto) {
        try {
          presence.as(chatId, 'upload_document')
          await sendDocument(token, chatId, bytes, file.name, undefined, undefined, extra)
          continue
        } catch {
          /* falls through to the log below */
        }
      }
      log.warn('could not send a file', error)
    }
  }
}

/**
 * The answer as a voice bubble, if anything can make one (M7-5, M7-4).
 *
 * `voice.render` is bound only while a cloned voice is chosen, because that is the only one
 * that returns Ogg/Opus and Telegram plays anything else as a file attachment. Nothing
 * provides it → false → words, which is the ordinary case and not a failure.
 *
 * **In the form the question came in** (D194). The toggle that meant *every answer is spoken*
 * is a three-way choice now, and `mirror` — speak to a voice note, type to typed words — is
 * the default, because a typed question answered out loud is a reply that has to be unmuted
 * on a bus. `reply.js` holds the decision and the migration of the old toggle; this end only
 * asks it.
 */
async function spoken(token, chatId, said, cameAsVoice, quote = () => undefined) {
  if (!said.trim()) return false
  if (!speaks(voiceMode(await settings()), cameAsVoice)) return false
  try {
    // *Recording voice…* while it is made and *sending voice…* while it goes (D192).
    presence.as(chatId, 'record_voice')
    const made = await alexia.capability('voice.render', { text: said })
    const audio = (made.content ?? []).find((block) => block.type === 'audio' && block.mimeType === 'audio/ogg')
    if (!audio) return false
    presence.as(chatId, 'upload_voice')
    await sendVoice(token, chatId, Buffer.from(audio.data, 'base64'), undefined, quote())
    return true
  } catch {
    // Nothing renders, or it failed. Either way the answer still has to arrive.
    return false
  }
}

/**
 * Send it — rendered where Telegram will render it — and if Telegram is unreachable put it
 * somewhere it can still be seen (M7-5, D194).
 *
 * `{ rich }` is what the caller knows and this cannot: an answer is a model's Markdown and is
 * worth rendering, while an error sentence, the pairing question and the ntfy fallback are
 * this plugin's own words, where a stray underscore rendering as italics would be the plugin
 * garbling itself. `{ extra }` is threading and whatever Telegram adds next; `{ buttons }`
 * forces plain, because a question is not prose and is short by construction.
 *
 * **A fallback, and never a replacement.** ntfy has no buttons and no threading, so a
 * permission question does not go down it — there is nothing to press. What it is for is the
 * case where Telegram itself is down and an answer would otherwise vanish: *the message
 * landed somewhere* is worth having and worth not overselling. Off unless somebody has typed
 * a topic, because a fallback nobody configured is a fallback to nowhere.
 */
async function say(token, chatId, text, { rich = true, extra, buttons } = {}) {
  try {
    if (rich && !plainOnly && !buttons) return await rendered(token, chatId, text, extra)
    return await plainly(token, chatId, text, extra, buttons)
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

/**
 * The rendered send, and the two different things Telegram can mean by refusing it (D194).
 *
 * **400 is this message.** Telegram could not parse this particular Markdown — an unclosed
 * fence, a table a model got half right — and the answer still has to arrive, so it goes
 * again as plain text and the next message is tried rendered as usual. **404, or a
 * description saying the method is not there, is this Bot API**: it is old enough not to have
 * `sendRichMessage`, it will be just as old on the next message, and asking again every time
 * is a round trip spent to be told the same thing. That one sets `plainOnly` and is logged
 * once.
 *
 * What goes on the wire has been through `forRich` first, which turns every Markdown image
 * into a link: rendering an image means Telegram's servers fetch its URL, and the Markdown
 * being rendered is a model's, which is not always the model's own idea.
 */
async function rendered(token, chatId, text, extra) {
  try {
    return await sendRich(token, chatId, forRich(text), extra)
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error
    if (error.status === 404 || /method (?:not found|is not)/i.test(String(error.message))) {
      plainOnly = true
      log.warn('this Telegram cannot render messages, so replies are plain from here on', error)
    } else if (error.status !== 400) {
      throw error
    }
    return plainly(token, chatId, text, extra)
  }
}

/**
 * The same words, at the size a plain message is allowed to be.
 *
 * A rendered answer was split at 32768 and a plain one may not be over 4096, so the fallback
 * has to split again rather than hand Telegram a message it will refuse for a second, quite
 * different reason. Only the first piece quotes the question, for the reason `answer` gives.
 */
async function plainly(token, chatId, text, extra, buttons) {
  let last
  let first = extra
  for (const part of chunk(text, LIMIT)) {
    last = await send(token, chatId, part, undefined, buttons, first)
    first = undefined
  }
  return last
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
    // The chat that just paired is the one Alexia speaks into when nothing asked her (D194).
    await alexia.storage.set('home_chat', String(chatId))
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
 * the message is skipped, because a voice note nobody could turn into words is not a question
 * anybody can answer.
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
 * A picture, as the block a model that can see is given (D194).
 *
 * Telegram never hands over the bytes with the message; what arrives is a `file_id`, and the
 * bytes are a second round trip through `getFile`. They go on the turn and nowhere else — the
 * conversation this plugin writes down keeps `[a photo]` and the caption, because a base64
 * image in a history table is a row nobody can read and every later turn has to carry.
 *
 * A failure here throws rather than returning nothing: somebody sent a photo and is waiting to
 * be told what is in it, and silence is the one answer that is certainly wrong.
 */
async function picture(token, fileId, mime) {
  const url = await filePath(token, fileId)
  const response = await fetch(url)
  if (!response.ok) {
    throw new TelegramError(response.status, `Telegram would not hand that picture over (${response.status}).`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  return { type: 'image', data: bytes.toString('base64'), mimeType: mime || 'image/jpeg' }
}

/**
 * A file, as what it says (D194).
 *
 * **Nobody here reads documents.** `document.extract` does, wherever it lives, and this plugin
 * is not allowed to know which plugin that is — so the order is: ask whether anything answers
 * it, and only then spend a download on a file that could not have been read anyway. When
 * nothing does, the reply says what would, because *your PDF was ignored* is not an answer.
 *
 * The bytes are borrowed. They go to `ownDir/incoming/` under a name `safeName` has taken the
 * path out of, and the `finally` removes them whether the reading worked or not.
 */
async function read(token, chatId, message, caption) {
  const file = message.document
  const name = safeName(file.file_name)
  if (tooBig(file.file_size)) {
    await say(token, chatId, `${name} is past the 20 MB a bot is allowed to fetch, so it was not read.`, {
      rich: false,
      extra: quoting(message.message_id),
    })
    return undefined
  }
  const { answers, here } = await alexia.answers('document.extract')
  if (!answers) {
    await say(
      token,
      chatId,
      here ?
        `Something here reads documents, but it is switched off. Turn on Documents in Plugins and send ${name} again.`
      : `Nothing here reads documents yet. Install the Documents plugin and send ${name} again.`,
      { rich: false, extra: quoting(message.message_id) },
    )
    return undefined
  }
  const dir = `${await alexia.host().then((info) => info.ownDir)}/incoming`
  await mkdir(dir, { recursive: true })
  const path = `${dir}/${name}`
  try {
    const url = await filePath(token, file.file_id)
    const response = await fetch(url)
    if (!response.ok) {
      throw new TelegramError(response.status, `Telegram would not hand ${name} over (${response.status}).`)
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const got = await alexia.capability('document.extract', { file: path })
    const text = (got.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n').trim()
    if (got.isError || text === '') {
      // Whatever reads documents refuses with a sentence saying what would read this one.
      // That sentence is more use to the person than anything this end could invent.
      await say(token, chatId, text || `Nothing could be read out of ${name}.`, {
        rich: false,
        extra: quoting(message.message_id),
      })
      return undefined
    }
    return {
      text: fileTurn(caption, name, text),
      // What the conversation keeps. The whole of a document's text replayed on every turn
      // after it is a conversation that gets more expensive the longer it goes on.
      note: caption ? `[the file ${name}] ${caption}` : `[the file ${name}]`,
      cameAsVoice: false,
    }
  } finally {
    await unlink(path).catch(() => {})
  }
}

/**
 * What actually arrived, as the turn a model is given (D194).
 *
 * `{ text, image?, note?, cameAsVoice }`. **`text` is what the model reads and `note` is what
 * the conversation keeps**, and they differ exactly where one turn is much bigger than it is
 * worth remembering. `cameAsVoice` is how the reply decides which form to come back in.
 *
 * `undefined` means there is nothing to answer — an empty message, a voice note nothing could
 * transcribe, or one of the two places above that have already replied on their own account.
 *
 * Every one of these runs inside the queued job, which is to say **after the allowlist**: a
 * stranger's photo is never fetched, because deciding whose a message is has to come before
 * spending this machine's bandwidth on it (D192).
 */
async function turnOf(token, chatId, message, kind) {
  const caption = typeof message.caption === 'string' ? message.caption.trim() : ''
  if (kind === 'text') {
    const text = message.text.trim()
    return text === '' ? undefined : { text, cameAsVoice: false }
  }
  if (kind === 'voice') {
    // A voice note is a message too, and the other direction already existed: this is
    // `voice.transcribe`, which has been in the registry since M2.
    const text = await heard(token, message)
    return typeof text !== 'string' || text === '' ? undefined : { text, cameAsVoice: true }
  }
  if (kind === 'photo') {
    // Telegram stores a photo as a ladder of sizes and re-encodes every one of them as JPEG,
    // whatever was uploaded — so the mime is known without being told.
    const size = bestPhoto(message.photo)
    const image = await picture(token, size.file_id, 'image/jpeg')
    // A caption is the question; without one the text says how it arrived, because a picture
    // beside an empty string is a turn that says nothing at all about itself.
    return { text: caption || photoNote(''), image, note: photoNote(caption), cameAsVoice: false }
  }
  if (kind === 'image_document') {
    // A picture sent as a file — which is what every phone does when *send without
    // compression* is chosen, and what a screenshot dragged in from a desktop arrives as.
    const file = message.document
    if (tooBig(file.file_size)) {
      await say(token, chatId, 'That picture is past the 20 MB a bot is allowed to fetch, so it was not read.', {
        rich: false,
        extra: quoting(message.message_id),
      })
      return undefined
    }
    const image = await picture(token, file.file_id, file.mime_type)
    return { text: caption || photoNote(''), image, note: photoNote(caption), cameAsVoice: false }
  }
  return read(token, chatId, message, caption)
}

/**
 * One message from a paired account, start to finish — the job the line runs (D192).
 *
 * *Typing…* from the moment its turn comes until its last word is sent: through the
 * transcription, the download, the answer, and the sentence that says something went wrong,
 * because the person is waiting through every one of them.
 */
async function handled(token, chatId, message, kind) {
  presence.start(chatId)
  try {
    const turn = await turnOf(token, chatId, message, kind)
    if (turn === undefined) return
    await answer(token, chatId, turn, message.message_id)
  } catch (error) {
    // `/stop` already said *Stopped.* in this chat, and it said it from the poll loop before
    // this ever unwound. *Something went wrong here* would be this plugin reporting a fault
    // for something that went exactly as asked.
    if (error instanceof Stopped) return
    await failed(token, chatId, error)
  } finally {
    presence.stop(chatId)
  }
}

/**
 * The person on the other end is waiting. Silence is the one answer that is certainly wrong,
 * so whatever went wrong is said in their chat.
 */
async function failed(token, chatId, error) {
  log.warn('could not answer', error)
  // Plain: this sentence is the plugin's own, and it ends in whatever an error object had to
  // say for itself — which is the last string on earth to hand to a Markdown renderer.
  await say(token, chatId, `Something went wrong here: ${String(error?.message ?? error)}`, { rich: false }).catch(
    () => {},
  )
}

/**
 * `/stop`, answered where it was heard (D194).
 *
 * **Never queued**, which is the whole point of it: a stop that waits its turn behind the task
 * it is stopping is not a stop. Two halves, because there are two places work can be — the
 * answer being written now, ended by aborting the request core is serving (core ends the task
 * when a plugin cancels, D159/D160), and everything still waiting, which `line.clear()` drops.
 *
 * *Nothing was running* is worth saying rather than a cheerful *Stopped.* over an idle chat:
 * somebody who types `/stop` is checking, and being told *yes, stopped* when nothing was would
 * teach them the command lies.
 */
async function stop(token, chatId, messageId) {
  const was = current !== undefined || line.waiting > 0
  current?.controller.abort()
  line.clear()
  await say(token, chatId, was ? 'Stopped.' : 'Nothing was running.', {
    rich: false,
    extra: quoting(messageId),
  })
}

/**
 * 👀 on a message the moment it is heard (D192).
 *
 * Before it is queued, so one sent while another is being answered says *seen* rather than
 * looking lost. It stays on: swapping it for ✅ later is one more notification on the phone
 * for news the answer is about to deliver anyway. Never waited for, and a failure is one line
 * in the log the first time — a reaction is not worth an answer.
 */
let unseen = false
function seen(token, chatId, messageId) {
  react(token, chatId, messageId, '👀').catch((error) => {
    if (unseen) return
    unseen = true
    log.warn('could not mark a message as seen — answers are unaffected', error)
  })
}

/**
 * Where the last run of this plugin got to (D194).
 *
 * Anything but a whole number is read as *nowhere*: `undefined` asks Telegram for whatever it
 * is holding, which is what a first run wants, and a `0` written by some earlier bug would ask
 * for the entire backlog on every start.
 */
async function restart() {
  const held = await alexia.storage.get('offset').catch(() => undefined)
  return Number.isInteger(held) ? held : undefined
}

/**
 * That update is finished, so the point a restart would come back to may have moved (D194).
 *
 * Written down after every update rather than every batch, because the crash this exists for
 * does not wait for a convenient moment. `Acks` decides what the number is — the oldest
 * update still in flight, or one past the newest when nothing is — and this only saves it.
 */
async function done(id) {
  const mark = acks.done(id)
  if (mark === undefined) return
  await alexia.storage.set('offset', mark).catch((error) => log.warn('could not write down where polling got to', error))
}

/**
 * The chat to speak into when nothing was asked in one (D194).
 *
 * A reminder, a message a task was told to send, a permission question from a task that
 * started at the keyboard: none of them have a chat of their own, and *the most recent row in
 * `chats`* was only ever a guess at one — the newest row is whichever chat was last written
 * to, which includes chats Alexia was the one talking in. `home_chat` is set where the
 * information actually is: when an account pairs, and on every message from a paired one. The
 * old guess stays as the fallback, for an install that paired before any of this was written.
 */
async function home() {
  const held = await alexia.storage.get('home_chat')
  if (typeof held === 'string' && held !== '') return held
  const chats = await alexia.storage.select('chats', { order: [['at', 'desc']], limit: 1 })
  return chats[0]?.chat_id
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
 *
 * **And nothing in here waits for an answer** (D192). It used to, and a permission question
 * asked from the phone could never be answered: the press arrives through this loop, and the
 * loop was waiting on the task that was waiting on the press. Answers go to the `line`.
 *
 * **Two offsets, and they are not the same number** (D194). `offset` is what the next
 * `getUpdates` asks for, and it has to move the moment an update is taken in or the next poll
 * hands the same message out again. What is written down for a restart is `acks`, which does
 * not move past an update until that update is *finished* — so a crash between answering and
 * the next poll no longer answers everything in the batch a second time.
 */
async function poll(token, signal) {
  // Where the last run of this plugin got to, if it got anywhere. Not `0`, which Telegram
  // reads as *give me everything you still have*.
  let offset = await restart()
  let backoff = 1000
  while (!signal.aborted) {
    try {
      const batch = await updates(token, offset, POLL_SECONDS, signal)
      backoff = 1000
      for (const update of batch) {
        const id = update.update_id
        // `last + 1` is the acknowledgement. Advance it even for a message that throws
        // below, or one bad message is replayed forever.
        offset = id + 1
        acks.received(id)

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
            await done(id)
            continue
          }
          const chose = asking.press(press.data)
          await answered(token, press.id, chose ?? 'That question has gone.').catch(() => {})
          if (press.message?.chat?.id !== undefined && press.message.message_id !== undefined) {
            await unbutton(token, press.message.chat.id, press.message.message_id).catch(() => {})
          }
          await done(id)
          continue
        }

        const message = update.message
        const from = message?.from?.id
        const chatId = message?.chat?.id
        /**
         * What kind of message this is, and whether it is one this plugin answers at all
         * (D194). Words, a voice note, a photo, a picture sent as a file, and a document —
         * a sticker or a location is not an answerable question and never was.
         *
         * `web_app_data` is a tap on the control panel, which is Phase 4's. Named here and
         * ignored rather than falling into the same `undefined` as a sticker, because the
         * difference between *not yet* and *never* is worth being able to see.
         */
        const kind = kindOf(message)
        if (!message || from === undefined || chatId === undefined || kind === undefined || kind === 'web_app') {
          await done(id)
          continue
        }

        // Who first, and only then any work (D192). A stranger's voice note used to be
        // downloaded and put through `voice.transcribe` before anything asked whose it was —
        // this machine's time, spent on somebody Alexia does not answer. A stranger gets the
        // one question, and a voice note cannot be the pairing code. Neither can a photo or a
        // file, and neither of those is fetched either (D194).
        if (!(await allowed()).has(String(from))) {
          try {
            await greet(token, chatId, from, kind === 'text' ? message.text : '')
          } catch (error) {
            await failed(token, chatId, error)
          }
          await done(id)
          continue
        }

        // The chat Alexia speaks into when nothing asked her — a reminder, a tool's message
        // — is the one she was last spoken to in (D194).
        await alexia.storage.set('home_chat', String(chatId)).catch(() => {})

        // Seen now, answered in its turn, and never waited for here (D192). The loop has to be
        // back at `getUpdates` while an answer runs, because that is the only way the press on
        // a permission question can reach it.
        seen(token, chatId, message.message_id)

        // Except this one, which is answered on the spot: `/stop` queued behind the answer it
        // is stopping would arrive after the thing it was meant to prevent (D194).
        if (kind === 'text' && stops(message.text)) {
          try {
            await stop(token, chatId, message.message_id)
          } catch (error) {
            await failed(token, chatId, error)
          }
          await done(id)
          continue
        }

        // A queued message is finished when its job has run — or when `/stop` dropped it
        // before it started, which `line.push` settles the same way and which is equally
        // *nobody is coming back to this one*.
        void line.push(() => handled(token, chatId, message, kind)).then(() => done(id))
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof TelegramError && error.status === 401) {
        // The token is wrong. Retrying cannot fix it and only the user can, so stop and say
        // so on the screen where the token is typed.
        log.error('Telegram refused the bot token')
        running = undefined
        live = undefined
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
  live = undefined
  // Nobody is listening for a press any more, so every open question settles as unanswered
  // — which core reads as no. A token that outlived its loop is a button that does nothing.
  asking.close()
  // And *typing…* sent over a connection that is going away is a promise nobody is keeping.
  presence.stopAll()

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
  live = token
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
    // The chat somebody is actually in, rather than the last row written (D194).
    const chatId = await home()
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
    // belongs where the task was asked for. Otherwise the home chat, which is the only other
    // place it could mean anything: a task started at the keyboard still has to ask somebody.
    const chatId = asked?.chatId ?? (await home())
    if (!token || chatId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Telegram is not paired, so there is nobody to ask.' }] }
    }
    const choices = Array.isArray(options) && options.length > 0 ? options.map(String) : ['Yes', 'No']
    const { buttons, answer } = asking.ask(choices)
    // The next move is the person's, and *typing…* under the buttons would say it was
    // Alexia's (D192). Back on the moment the question settles, however it settles.
    presence.pause(chatId)
    try {
      // No ntfy fallback for this one: a question with no way to answer it is worse than a
      // question that did not arrive, because it looks answered to whoever sent it.
      await send(token, chatId, String(question ?? 'Alexia is asking.'), undefined, buttons)
      const chose = await answer
      return { content: [{ type: 'text', text: chose ?? 'No' }] }
    } finally {
      presence.resume(chatId)
    }
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
