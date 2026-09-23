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
  sendDraft,
  sendPhoto,
  sendRich,
  sendRichDraft,
  sendVoice,
  setMyCommands,
  TelegramError,
  unbutton,
  updates,
} from './api.js'
import { Asking } from './asking.js'
import { Clock } from './clock.js'
import { Draft } from './draft.js'
import { forRich, RICH_LIMIT } from './format.js'
import { bestPhoto, fileTurn, kindOf, photoNote, safeName, tooBig } from './incoming.js'
import { Line } from './line.js'
import { commandsFrom, helpLines, menu } from './menu.js'
import { action, DEFAULT_PANEL_URL, keyboard, panelUrl, stateOf } from './panel.js'
import { EVERY, Presence } from './presence.js'
import { dayKey, dueNow, morningDue, parseAt, reminderText, sendTo } from './reminders.js'
import { speaks, voiceMode } from './reply.js'
import { frameOf, sampling, Stopped, wasStopped } from './sampling.js'
import { bare, isCommand, panels, stops } from './slash.js'

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
 */

const alexia = plugin()

/** How long Telegram holds the poll open. Long enough that the loop is nearly always waiting. */
const POLL_SECONDS = 50
/**
 * How often the reminders that are due are looked for (D195).
 *
 * Half a minute is the resolution of every reminder this holds, and that is the right trade: a
 * person asking to be nudged at five is not counting the seconds, and a timer that wakes twice
 * a minute to read a handful of rows is a cost nobody can measure. It is `unref`'d, so it is
 * never the reason this process is still alive.
 */
const TICK = 30_000

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
 * The work being done now, and the way to stop it (D192, D195): `{ controller, chatId, draft }`,
 * or undefined between answers.
 *
 * Out here rather than inside `answer` so that whatever stops it — `/stop`, the Stop button on
 * the draft, a token being replaced — can reach it from the poll loop, without being queued
 * behind the very answer it is stopping. Aborting `controller` cancels the `sampling` request,
 * and core ends the task when a plugin cancels.
 *
 * **A command sets it too** (D195). `/new` is instant, but a plugin's own command can be gated,
 * and a gated command asks this plugin's `confirm` and then waits for a person — which is
 * minutes, not milliseconds, and was the one long-running thing on this path that `/stop`
 * could not reach.
 */
let current

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
 * Whether drafts are worth trying, for the rest of the session (D195).
 *
 * One object shared by every `Draft`, because the answer to *can this chat show a draft* does
 * not change between answers: an old client or a chat that does not support them fails the same
 * way on the next message, and retrying per answer is a retry that was never going to work.
 * `draft.js` is the only thing that sets it, and Phase 1's typing indicator is what still
 * covers the chat once it is off.
 */
const drafting = { off: false }

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
async function command(token, chatId, typed, quote = () => undefined) {
  if (/^\/new\b/i.test(typed)) await alexia.storage.delete('chats', { chat_id: String(chatId) })
  const result = await ran(token, chatId, typed)
  const said = result.content?.type === 'text' ? result.content.text : ''
  // The two this plugin answers itself are not in core's list and never will be, so a relayed
  // `/help` says so — and the same list becomes the "/" menu, from the same reply (D195).
  const whole = /^\/help\b/i.test(typed) ? `${said || 'Done.'}\n${helpLines()}` : said || 'Done.'
  for (const part of chunk(whole, plainOnly ? LIMIT : RICH_LIMIT)) {
    await say(token, chatId, part, { extra: quote() })
  }
  if (/^\/help\b/i.test(typed)) await refreshMenu(token, result)
}

/**
 * The command itself, run by core, with everything an answer gets (D195).
 *
 * **The same option bag as `answer`**, which is the fault this was pulled out to fix: a
 * command used to be sent with no options at all, so it carried the SDK's sixty-second
 * default — and a plugin command whose ruling is *ask* sends a question to this very chat and
 * then waits for somebody to read it. A minute is not a person's reply time, so the request
 * was cancelled, core read the cancel as this plugin giving up, and a tap on a menu entry
 * turned into an error about something that had not failed.
 *
 * **And `asked`, for the same question.** `confirm` sends to the chat whose message started
 * the work; a command never set it, so the question fell back to the home chat — usually the
 * right one, and not always, and on a freshly paired account with no home chat yet it was an
 * error core reads as *no*.
 */
async function ran(token, chatId, typed) {
  const controller = new AbortController()
  /**
   * Whether this is the piece of work `/stop` means, and the one a permission question
   * belongs to.
   *
   * Two things that are not: a background `/help` for the menu, which is nobody's message and
   * has no chat to ask in; and anything that arrives **while something else is already
   * running** — a panel tap answered straight off the poll loop while an answer is being
   * written (D196). Taking the handle there would leave the real answer unstoppable and send
   * its permission questions to the wrong place, for the sake of a mode switch that takes a
   * millisecond and that nobody would ever press Stop on.
   */
  const owned = chatId !== undefined && current === undefined
  const question = { token, chatId }
  if (owned) {
    asked = question
    current = { controller, chatId }
  }
  try {
    return await alexia.server.server.createMessage(
      {
        messages: [{ role: 'user', content: { type: 'text', text: typed } }],
        maxTokens: 400,
        _meta: { 'alexia/tools': true },
      },
      // No draft: a command's answer is one line that is already written, so core sends no
      // frames for it (D193) and there would be nothing to stream.
      sampling(controller.signal),
    )
  } catch (error) {
    if (wasStopped(controller.signal, error)) throw new Stopped('stopped from the phone')
    throw error
  } finally {
    /**
     * **Only while they are still this one's.** `current` was already guarded that way; `asked`
     * was not, and the two are set independently — so a panel tap still in flight when the
     * `Line` started a queued answer would clear that answer's `asked` on its way out, and the
     * answer's permission question would go to the home chat rather than to the chat somebody
     * is sitting in waiting for it.
     */
    if (owned) {
      if (asked === question) asked = undefined
      if (current?.controller === controller) current = undefined
    }
  }
}

/**
 * The list behind the *"/"* button, built from core's own (D195, D111).
 *
 * **Asked for rather than kept in step.** Core knows every command every manifest declares —
 * that is what answers `/help` — and a second copy of that list living here is the kind of
 * thing that is right on the day it is written: a plugin ships a command, nobody remembers
 * this file, and the menu quietly lies about what typing `/` will do. So the menu is whatever
 * `/help` just said, plus this plugin's own two, which core has never heard of because `/stop`
 * is intercepted before it reaches core and `/panel` opens a page core does not own.
 *
 * Cosmetic, like every other thing on the chat's furniture: a failure is one line in the log,
 * once, and never costs an answer.
 */
let menuFailed = false
async function refreshMenu(token, known) {
  if (!token) return
  try {
    const result = known ?? (await ran(token, undefined, '/help'))
    const list = menu(commandsFrom(result))
    // An empty list would *clear* the menu rather than leave it alone, which is worse than
    // whatever is up there now.
    if (list.length === 0) return
    await setMyCommands(token, list)
  } catch (error) {
    if (menuFailed) return
    menuFailed = true
    log.warn('could not set the command menu — answers are unaffected', error)
  }
}

/**
 * Where things stand, as `/status` hands it over (D193, D196).
 *
 * The same command anybody can type, run through the same path, and read from
 * `alexia/command` rather than from the sentence — the sentence is for a person and the
 * numbers are for the page. An Alexia that predates that key answers with the sentence and no
 * `_meta`, and `{}` is exactly the right reading of that: the page draws the fields it was
 * given and leaves out the ones it was not.
 */
async function standing(token) {
  try {
    const result = await ran(token, undefined, '/status')
    const facts = result?._meta?.['alexia/command']
    return facts !== null && typeof facts === 'object' ? facts : {}
  } catch (error) {
    log.warn('could not read the state for the panel', error)
    return {}
  }
}

/**
 * The snapshot the panel page draws (D196).
 *
 * Half of it is core's and half is this plugin's own — the queue, the voice mode and how many
 * accounts are paired are things core has never heard of, and `/status` is the only way to
 * learn the rest. `running` prefers core's answer because core is the one that knows whether
 * a task is running; when it did not say, this end's own view of it is better than nothing.
 *
 * Every field is left out rather than sent empty, because the page treats absent as *not
 * known* and a zero as a number somebody could act on.
 */
async function panelState(token) {
  return stateOf(await standing(token), {
    at: Date.now(),
    running: current !== undefined || line.busy,
    waiting: line.waiting,
    voice: voiceMode(await settings()),
    paired: (await allowed()).size,
  })
}

/**
 * The ⚙ Panel button, with this moment's state baked into its link (D196).
 *
 * **The state travels in the fragment**, which is the part of a URL a browser does not send to
 * the host — so the page behind the button is one static file that can be published next to
 * the source, and it still shows today's spend without anybody's server ever seeing it. The
 * cost of that is the one thing the page says out loud: what it shows is a snapshot of the
 * moment the button was made, so every reply that carries a button carries a fresh one.
 *
 * `undefined` when there is no safe link to build — an address that is not `https:`, or a state
 * too long for Telegram's URL. The caller says so in words rather than sending a dead button.
 */
async function panelMarkup(token) {
  const { panel_url: base } = await settings()
  const url = panelUrl(String(base || DEFAULT_PANEL_URL), await panelState(token))
  return url === undefined ? undefined : { reply_markup: keyboard(url) }
}

/** `/panel` — the button, or the reason there is not one. Telegram's own, never core's. */
async function panel(token, chatId, messageId) {
  const markup = await panelMarkup(token)
  if (markup === undefined) {
    await say(
      token,
      chatId,
      'There is no panel to open: the control panel page in Alexia’s settings is not an https address. ' +
        'Clear it to go back to the default one.',
      { rich: false, extra: quoting(messageId) },
    )
    return
  }
  // Sent rather than said: the point of this message is the keyboard under it, and ntfy has
  // no keyboard — a fallback here would deliver the sentence and lose the only thing it is for.
  await send(token, chatId, 'Tap ⚙ Panel below.', undefined, undefined, { ...markup, ...quoting(messageId) })
}

/**
 * A tap on the panel, arriving as an ordinary message (D196).
 *
 * **The tap is untrusted text**, whatever it came from. The page is trusted to send only what
 * its own buttons produce, but anybody who can script `sendData` can hand this plugin any JSON
 * they like — so what arrives is checked against `panel.js`'s allowlist and nothing else ever
 * runs. Something not on the list is ignored in silence rather than answered: a reply naming
 * what was not recognised is a way to ask this plugin what it *does* recognise.
 *
 * What is on the list runs down the paths that already exist — a command through the same
 * `/cheap` core runs for a typed one, a stop through the same stop `/stop` is — and the reply
 * is core's own sentence with a fresh panel under it, so the numbers on it are this moment's.
 */
async function tapped(token, chatId, message) {
  const chosen = action(message.web_app_data?.data)
  if (chosen === undefined) return
  if (chosen.stop) {
    // The same stop, down to the sentence, carrying a button built after it landed.
    await stop(token, chatId, undefined, () => panelMarkup(token))
    return
  }
  let said
  if (chosen.voice) {
    said = await voiceLives()
  } else {
    // `/new` rotates core's conversation; the history the model is *shown* is this plugin's,
    // so clearing it here is what makes a new chat new — exactly as a typed `/new` does.
    if (/^\/new\b/i.test(chosen.command)) await alexia.storage.delete('chats', { chat_id: String(chatId) })
    const result = await ran(token, chatId, chosen.command)
    said = (result.content?.type === 'text' ? result.content.text : '') || 'Done.'
  }
  await send(token, chatId, said, undefined, undefined, await panelMarkup(token))
}

/**
 * **What the panel cannot do, said plainly** (D196).
 *
 * The page offers the three voice-reply modes, and this end cannot set them — by a rule of
 * core's that is right: a plugin may write its own `status` widgets and nothing else, because
 * a plugin that could rewrite a setting could quietly undo a decision somebody made on that
 * screen (`alexia/settings/set` in `host.ts` refuses it in as many words). `voice_replies` is
 * the person's answer, not this plugin's state.
 *
 * So the tap is answered with what it is and where it is changed. The alternative — keeping a
 * second copy of the choice in this plugin's own storage and preferring it — would work, and
 * would mean the settings screen showing one thing while the reply that arrives is another.
 */
async function voiceLives() {
  return (
    `Voice replies are on “${voiceMode(await settings())}”. This panel cannot change that: a plugin may not ` +
    `overwrite a setting you chose yourself, so it lives in Alexia’s own settings, under Telegram.`
  )
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
  /**
   * A command, and **core's own test for what one is** (D195).
   *
   * Not remembered and carrying no history: a command is an instruction to Alexia, not a turn
   * in the conversation, and `/new` clears the conversation it would have been in.
   *
   * This used to be *starts with a slash*, which is looser than core's rule and wrong in the
   * direction that loses words. Core reads `/2fa reset the code` as an ordinary question,
   * because a command's name starts with a letter — so sending it down here meant a question
   * answered with no history behind it, capped at a command's few hundred tokens, and left out
   * of the transcript entirely. `isCommand` is core's pattern, and `bare` runs first because
   * the `@BotName` a menu tap adds is not in it.
   */
  const typed = turn.image === undefined ? bare(turn.text) : turn.text
  if (turn.image === undefined && isCommand(typed)) return command(token, chatId, typed, quote)
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
  const question = { token, chatId }
  asked = question
  const controller = new AbortController()
  /**
   * **The answer, shown while it is written** (D195).
   *
   * A draft is Telegram's own preview of a message being composed: an empty one reads
   * *Thinking…*, and each refresh replaces it with the words so far. Refreshed rather than
   * edited, because an edit per delta is a rate limit and a notification per word, while a
   * draft that is never finished simply disappears — which is the right end for words that
   * were never an answer. `can_stop` puts a Stop button on it, and the final answer, sent as
   * an ordinary message below, is what replaces the draft.
   *
   * Phase 1's *typing…* stays on underneath: it costs one small request every four seconds
   * and it is what the chat still has on a client where drafts do not work.
   */
  const draft = new Draft({
    plain: (id, text) => sendDraft(token, chatId, id, text, true),
    rich: (id, markdown) => sendRichDraft(token, chatId, id, markdown, true),
    session: drafting,
    log: (message, error) => log.warn(message, error),
  })
  current = { controller, chatId, draft }
  draft.open()
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
    }, sampling(controller.signal, (params) => {
      /**
       * The words as core writes them (D193, D195).
       *
       * `delta` is what has been written since the last frame and is appended; `restart` means
       * the model writing them stopped partway and another is starting over, so what is on
       * screen is somebody else's half-sentence and has to go (D155). A `phase` needs nothing
       * drawn — it is the keep-alive, and it has already done its job by resetting the clock
       * on the way in.
       */
      const frame = frameOf(params)
      if (frame?.restart) draft.restart()
      if (typeof frame?.delta === 'string' && frame.delta !== '') draft.add(frame.delta)
    }))
  } catch (error) {
    // `/stop` pressed the button on this one. It is not a fault and the loop has already said
    // so in this chat, so it travels as its own kind of error and dies quietly in `handled`.
    if (wasStopped(controller.signal, error)) throw new Stopped('stopped from the phone')
    throw error
  } finally {
    // Only while they are still this answer's, both of them: whatever finishes last must not
    // take a handle from work that started while it was running.
    if (asked === question) asked = undefined
    // The words are about to arrive as a real message, or they are never going to. Either way
    // nothing more should be refreshing a preview of them.
    draft.close()
    // The handle belongs to whichever answer is running, and one that finishes late must never
    // take it from the answer after it.
    if (current?.controller === controller) current = undefined
  }
  const said = result.content?.type === 'text' ? result.content.text : ''
  await remember(chatId, 'assistant', said)
  const words = said || 'I had nothing to say to that.'

  // A file the task made — a picture, a report — first (D122). It is usually the thing that
  // was asked for.
  await delivered(token, chatId, result, quote)

  // A voice note when the form the question came in asks for one, and words when it does not.
  if (await spoken(token, chatId, said, turn.cameAsVoice, quote)) return
  // Rendered, so the limit is Telegram's rich one — eight times the room, which is the whole
  // difference between an answer arriving as one bubble and as eight (D194).
  for (const part of chunk(words, plainOnly ? LIMIT : RICH_LIMIT)) {
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
async function stop(token, chatId, messageId, more) {
  const was = current !== undefined || line.waiting > 0
  // The preview first, so nothing refreshes a half-written answer after the chat has been
  // told it stopped (D195). The answer's own `finally` closes it too; both are idempotent.
  current?.draft?.close()
  current?.controller.abort()
  line.clear()
  /**
   * `more` is how a stop that came from the panel carries a fresh panel back (D196): one
   * message rather than two.
   *
   * A function rather than a value, and that is the whole reason it is one — a panel built
   * before this line would have been built before the abort, and would come back saying
   * something is still running. Asked for here, it is a snapshot of a stopped Alexia.
   */
  await say(token, chatId, was ? 'Stopped.' : 'Nothing was running.', {
    rich: false,
    extra: { ...quoting(messageId), ...(await more?.()) },
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

        /**
         * The Stop button on the draft was pressed (D195).
         *
         * **The same stop `/stop` is**, and it has to be: the button is on a preview of the
         * answer being written, and the only honest thing a person means by pressing it is
         * *end this*. So it goes through the same path, and the chat gets the same sentence.
         *
         * The draft id is what makes it safe to act on. An update of this kind carries a chat
         * and the id of the draft it belongs to and no `from` at all, so the identity checks
         * are those two: the chat has to be a paired account's — in a private chat the chat id
         * *is* the account's id — and the draft has to be the one being written right now.
         * A press on a draft from a minute ago must not end the answer that replaced it.
         */
        const pressedStop = update.stopped_message_generation
        if (pressedStop) {
          const where = pressedStop.chat?.id
          const mine = current?.draft?.id !== undefined && current.draft.id === pressedStop.draft_id
          if (where !== undefined && mine && (await allowed()).has(String(where))) {
            try {
              await stop(token, where)
            } catch (error) {
              await failed(token, where, error)
            }
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
         * `web_app_data` is a tap on the control panel, which arrives as a message of its own
         * kind on this same poll — no callback, no webhook, and nothing new to listen on.
         */
        const kind = kindOf(message)
        if (!message || from === undefined || chatId === undefined || kind === undefined) {
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

        /**
         * A tap on the panel, from a paired account (D196).
         *
         * Before 👀, because a `web_app_data` message is not one anybody can see in the chat —
         * a reaction on it would be a reaction on nothing. Answered on the spot, like the two
         * commands below: what it carries is a mode switch or a stop, and neither is worth
         * queueing behind an answer, least of all the stop.
         */
        if (kind === 'web_app') {
          try {
            await tapped(token, chatId, message)
          } catch (error) {
            await failed(token, chatId, error)
          }
          await done(id)
          continue
        }

        // Seen now, answered in its turn, and never waited for here (D192). The loop has to be
        // back at `getUpdates` while an answer runs, because that is the only way the press on
        // a permission question can reach it.
        seen(token, chatId, message.message_id)

        // Except these two, which are answered on the spot: `/stop` queued behind the answer it
        // is stopping would arrive after the thing it was meant to prevent (D194), and `/panel`
        // is a button this plugin draws rather than anything core has a word for (D196).
        if (kind === 'text' && stops(message.text)) {
          try {
            await stop(token, chatId, message.message_id)
          } catch (error) {
            await failed(token, chatId, error)
          }
          await done(id)
          continue
        }

        if (kind === 'text' && panels(message.text)) {
          try {
            await panel(token, chatId, message.message_id)
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
  /**
   * **And the queue goes with it** (D195).
   *
   * The loop was stopped and the indicators were, and the work itself carried on: whatever was
   * being answered kept going, and everything queued behind it started in turn. All of it
   * belongs to the bot that is being replaced — so it would put *typing…* into chats through a
   * token that no longer exists, spend the month's allowance on answers, and then fail to
   * deliver a single one of them. A stop that leaves the work running is not a stop.
   */
  current?.draft?.close()
  current?.controller.abort()
  line.clear()

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
  // The "/" menu, from core's own list. Not waited for: it is furniture, and an answer must
  // never be behind it (D195).
  void refreshMenu(token)
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
    /**
     * **The chat the task came from**, and the home chat only when it came from somewhere with
     * no chat of its own — the window, a timer, a plugin.
     *
     * This is a tool a model calls in the middle of somebody's task, and *tell me on my phone
     * when this is done* means the phone of the person who asked. The home chat is whichever
     * paired account messaged most recently, which is the same answer only when one person is
     * paired; with two it is a message about one person's task arriving on the other's phone.
     */
    const chatId = asked?.chatId ?? (await home())
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
    // The draft goes quiet for the same moment and for a second reason: sending a message into
    // a chat takes the draft down anyway, so a refresh arriving after the question would put a
    // half-written answer *below* the thing it is waiting on (D195).
    const held = current?.draft
    held?.pause()
    try {
      // No ntfy fallback for this one: a question with no way to answer it is worse than a
      // question that did not arrive, because it looks answered to whoever sent it.
      await send(token, chatId, String(question ?? 'Alexia is asking.'), undefined, buttons)
      const chose = await answer
      return { content: [{ type: 'text', text: chose ?? 'No' }] }
    } finally {
      presence.resume(chatId)
      held?.resume()
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

/**
 * Reminders, and why they live here (D195).
 *
 * **This is the plugin that is awake and has somewhere to say it.** A reminder is two things:
 * something remembered, and something that arrives at a time nobody is looking at a screen.
 * Core has no timer that outlives a conversation and the window is not open at half past four
 * — but this plugin is `resident`, because a message can arrive from outside at any hour, and
 * it holds a chat on a device that is in somebody's pocket. Everything else about a reminder
 * follows from that and is deliberately small: a row, a 30-second look at the clock, and
 * `say()`, which is the same path an answer takes and therefore has the same ntfy fallback.
 *
 * **The model resolves the time, not this.** *Remind me at five* is a sentence about a person's
 * own day — their timezone, whether five has already gone — and a model reading it in context
 * is better at that than a parser here would be. What comes back is an ISO date-time, and
 * `reminders.js` only checks it is one that could happen.
 */
/** A tool refusing, in the one shape a model can read as *this did not happen*. */
const refused = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * Every reminder still waiting to be sent.
 *
 * **Asked of the database rather than filtered afterwards**, which is the difference between a
 * query and a bug: this used to read the oldest five hundred rows and drop the delivered ones
 * from the result. Delivered rows keep the time they were due, so they sort to the front — and
 * once five hundred of them had accumulated, the window was full of them, every real reminder
 * fell outside it, and the clock quietly went silent forever while `/reminders` said *nothing
 * is waiting*.
 *
 * **And a delivered reminder is deleted, not marked** (the other half of the same fault). It
 * has done the one thing it existed to do; keeping it means a table that only grows, in a
 * namespace deleting the plugin is supposed to empty. The `sent` column stays in the query
 * because it costs nothing and it is what a row left over from an older build looks like.
 *
 * The limit stays too, and is harmless now: five hundred rows ordered by when they are due are
 * the five hundred *soonest*, so the next one to fire is always inside the window, and each one
 * delivered and deleted brings the one behind it into view.
 */
const waiting = () => alexia.storage.select('reminders', { where: { sent: 0 }, order: [['at', 'asc']], limit: 500 })

alexia.tool(
  'remind',
  {
    description:
      'Send the user a reminder on their phone at a given time. Use when they ask to be ' +
      'reminded, nudged or told about something later. `at` is an ISO 8601 date-time — work ' +
      'out what the user means ("at 5pm", "in 20 minutes", "tomorrow morning") in their own ' +
      'local time and pass the result. The reminder goes through Telegram servers.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to remind them about, in their own words.' },
        at: { type: 'string', description: 'When, as an ISO 8601 date-time in their local time.' },
      },
      required: ['text', 'at'],
    }),
    // It puts a message on somebody's phone at a time of its choosing, which is a thing that
    // happens in the world and leaves this machine. The same annotation `send` carries.
    annotations: { openWorldHint: true },
  },
  async ({ text, at }) => {
    const said = String(text ?? '').trim()
    if (said === '') return refused('There was nothing to be reminded about.')
    /**
     * **Whose reminder this is, written down now** — the chat the task asking for it came
     * from, and the home chat only when it came from somewhere with no chat of its own, like
     * the window.
     *
     * It used to be neither: nothing was stored and the clock sent to whatever the home chat
     * was hours later, which is *whichever paired account messaged most recently*. With two
     * accounts paired that is a reminder one person set arriving on the other person's phone.
     */
    const chatId = asked?.chatId ?? (await home())
    // Refused now rather than stored and silently never delivered: a reminder with nowhere to
    // arrive is a promise this plugin cannot keep, and the model can say so while somebody is
    // still listening.
    if (chatId === undefined) return refused('Telegram is not paired, so a reminder has nowhere to go.')
    const when = parseAt(at, Date.now())
    // Said and not understood is worth saying out loud, in the words the model can act on:
    // a time silently dropped is a reminder that will never arrive and nobody would know why.
    if (!when.ok) return refused(`That reminder was not set, because ${when.why}.`)
    await alexia.storage.insert('reminders', {
      text: said,
      at: when.at,
      chat_id: String(chatId),
      sent: 0,
      made: Date.now(),
    })
    return { content: [{ type: 'text', text: `Set: “${said}”, for ${new Date(when.at).toLocaleString()}.` }] }
  },
)

alexia.tool(
  'reminders',
  {
    description: 'List the reminders waiting to be sent to the phone, with when each one is due.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const rows = await waiting()
    if (rows.length === 0) return { content: [{ type: 'text', text: 'Nothing is waiting.' }] }
    const lines = rows
      .sort((a, b) => a.at - b.at)
      .map((row) => `${String(row.rowid)}. ${String(row.text)} — ${new Date(row.at).toLocaleString()}`)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  },
)

alexia.tool(
  'forget_reminder',
  {
    description: 'Drop a reminder that has not been sent yet, by the number the reminders list gives it.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'number', description: 'The number from the reminders list.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const gone = await alexia.storage.delete('reminders', { rowid: Number(id) })
    return {
      content: [{ type: 'text', text: gone > 0 ? 'Dropped.' : 'There is no reminder with that number.' }],
    }
  },
)

/**
 * The clock, every thirty seconds (D195).
 *
 * **Marked sent before it is sent** would be a reminder lost to one failed request, and marked
 * after would be one sent twice if the mark failed — so it is sent first and marked
 * immediately after, which loses at worst a duplicate on a crash between the two. A reminder
 * arriving twice is a nuisance; one that never arrives is the thing somebody trusted this with.
 *
 * A reminder whose time came while the machine was off is still sent, and says how late it is
 * rather than arriving as though it were on time.
 */
const clock = new Clock({
  due: async (now) => dueNow(await waiting(), now),
  send: (row, now) => reminded(row, now),
  // Finished with, and gone: a delivered reminder has done the only thing it was for, and a
  // table that only grows is residue in a namespace that is supposed to empty when the plugin
  // does. `forget_reminder` deletes a row the same way, so there is one meaning of *not here*.
  done: (row) => alexia.storage.delete('reminders', { rowid: row.rowid }),
  retry: (row, tries) => alexia.storage.update('reminders', { tries }, { rowid: row.rowid }),
  summary: (now) => summary(now),
  log: (message, error) => log.warn(message, error),
})

/** One reminder, on the phone it was set from. Throws if it did not arrive — the clock counts. */
async function reminded(row, now) {
  const { bot_token: token } = await settings()
  if (!token) throw new Error('there is no bot token to send a reminder with')
  const chatId = sendTo(row, await home())
  if (chatId === undefined) throw new Error('there is nowhere to send that reminder')
  // Plain: a reminder is the person's own sentence read back to them, and a stray asterisk
  // in it is not Markdown they asked to have rendered.
  await say(token, chatId, reminderText(row, now), { rich: false })
}

/** The tick the interval calls. Nothing to send with is not a failure of any one reminder. */
async function ring() {
  const { bot_token: token } = await settings()
  if (!token) return
  await clock.tick(Date.now())
}

/**
 * What is due, once a morning (D195, D193).
 *
 * **It asks by capability and never learns whose ledger it is.** `commitments.due` is a name in
 * the registry; something answers it or nothing does, and this plugin cannot tell which plugin
 * that was — which is the whole point of the registry and the reason a channel can push a
 * summary without a line of code about commitments in it.
 *
 * The day is written down *before* the summary is sent, so a failure costs one morning rather
 * than retrying every thirty seconds until midnight — and after everything that would make
 * today a day it could not have been sent at all, so a machine with nothing paired does not
 * spend its mornings marking them done.
 */
async function summary(now) {
  const { bot_token: token, morning_summary: at } = await settings()
  if (!token) return
  if (!morningDue(at, await alexia.storage.get('morning_day'), now)) return
  const chatId = await home()
  if (chatId === undefined) return
  await alexia.storage.set('morning_day', dayKey(now))
  const { answers } = await alexia.answers('commitments.due')
  if (!answers) return
  // The day this machine is having, since whatever keeps the ledger may be counting from
  // somewhere else and *due today* is a question about the reader's morning.
  const got = await alexia.capability('commitments.due', { today: dayKey(now) })
  if (got.isError) return
  const text = (got.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n').trim()
  if (text === '') return
  await say(token, chatId, text)
}

await alexia.start()
await connect()
// A token typed, replaced or cleared means the connection this plugin is holding is the
// wrong one. Reconnect rather than waiting for a restart nobody is going to do.
alexia.onSettingsChanged((changed) => {
  if ('bot_token' in changed) void connect()
})
// A reminder that was delivered is deleted now rather than marked, and this is the one-off for
// rows an earlier build marked instead: dead weight in a table nothing else will ever read.
void alexia.storage
  .delete('reminders', { sent: 1 })
  .catch((error) => log.warn('could not clear out delivered reminders', error))
// The reminder clock. `unref`'d, so it is never the reason this process is still running, and
// every tick is wrapped: a database blip at 4am must not be the end of the timer.
const ticking = setInterval(() => {
  void ring().catch((error) => log.warn('could not look for reminders that are due', error))
}, TICK)
ticking.unref?.()
log.info(`${alexia.manifest.name} is ready`)
