// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The chat shell. No Node in here, ever (invariant 6) — at M5 Tauri wraps this page as it
 * stands, and anything that reached for a Node builtin would be a rewrite scheduled for the
 * worst possible moment.
 *
 * It talks to core over loopback, with a token the server injected into the page. Two things
 * are always on screen and neither is decoration: **which model answered**, so you know
 * where your words went, and **what the month has cost**, so nobody is ever surprised by a
 * bill.
 */

import { escapeTakes, mountBoard } from './board.js'
import { copyText, grow, moveIn, nearBottom, shownTurn, slashMatches, type StoredTurn, usedTools, wordsOf } from './chat.js'
import type { Layout } from './layout.js'
import { drawPrice } from './pages.js'
import { genieIn, genieOut, stopGenie } from './genie.js'
import { autostart, controlling, dismiss, planOnEdge, glassSupported, HOTKEY, inApp, installUpdate, onStopKey, setAutostart, tray, updateAvailable } from './desktop.js'
import { mountControl } from './control.js'
import { mountPalette } from './palette.js'
import { isSettingsPage, mountSettings } from './settings.js'
import { mountGlass, mountTheme, type Theme } from './theme.js'
import { CONTROL_EVENT, mountLive, type Stage, type Timing } from './live.js'
import { answerPrompt, modal } from './modal.js'
import { mountRail } from './rail.js'
import { mountLocalModels, type LocalModelsView, type LocalRequest } from './local-models.js'
import { openImageEditor } from './image-editor.js'
import { mountModeTransition, type ModeTransition } from './mode-transition.js'
import type { ComputeState } from './compute.js'
import { keepPlaced, MODES, mountLevelSlider, mountModeSwitch, mountGlassLook, type Around, type Switcher } from './switchers.js'
import { isPhase, mountStatus } from './status.js'
import { dollarsOf, el, MODELS_CHANGED } from './widgets.js'

interface Turn extends StoredTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  model?: string
  /** What Alexia said about this answer — a switch to another model — kept with it (§4 G). */
  notes?: string[]
  /** Somebody pressed *Bad answer* on it (§4 I). Still shown, marked; never sent to a model again. */
  bad?: true
}

/**
 * Which rung of the ladder answered, said as a state rather than a price (§8.4).
 *
 * Core decides this — it is read off the same two keys the router sorts by, so the sentence
 * on screen cannot drift from the cascade it is describing. The shell only paints it.
 */
interface Bubble {
  rung: number
  says: string
  state: 'green' | 'amber' | 'red'
}

interface Provider {
  id: string
  name: string
  terms?: string
  trainsOnYourData: 'yes' | 'no' | 'unknown'
  free: boolean
  /** Whether Alexia can ask it now: a key is stored, or it answers with none and the floor is on. */
  connected: boolean
  /**
   * Whether a key is really stored for it. Never the key — that went to the keychain. Not the
   * same as `connected`: a provider that answers with no key is connected with nothing stored,
   * and a *key stored* badge or a *Remove key* button on it would be about a key nobody gave.
   */
  keyStored: boolean
  /** The published free tier, in whichever unit this one rations. Absent means not published. */
  rpm?: number
  rpd?: number
  callsPerMonth?: number
  /** When somebody last checked the row against the provider's own docs. */
  verified?: string
  /** What getting in costs that is not money, where that is more than an email. */
  friction?: string
  /** It wants a card before it gives a key (D165). */
  card?: true
  /** It answers without a key, which is the tier that makes skipping this screen work. */
  keyless: boolean
  /** Its account id goes in the URL, so what it wants pasted is `account_id:api_token`. */
  account: boolean
}

interface Command {
  name: string
  summary: string
  alias?: string
  plugin?: string
  shadowed?: boolean
}

interface Permissions {
  mode: string
  modes: Record<string, string>
  roots: string[]
  everywhere: boolean
  boundaries: { said: string; blocks: string }[]
}

interface State {
  /** Whether the image editor is installed, and the conversation it opens in. Absent before protocol 14. */
  editor?: { installed: boolean; conversationId: string; private: boolean }
  /** Whether adult content was turned on in Settings (18+ confirmed), and whether /nsfw is on. */
  adult?: { confirmed: boolean; on: boolean }
  modeTransition?: ModeTransition
  /** This computer's role and the computers it is paired with. Absent from a core that predates them. */
  compute?: ComputeState

  setup: { done: boolean; name: string; mode: string; theme: Theme; glass: number; glassLook?: string; updates?: boolean }
  /** What this build is, for the About page — sent with every state read (D121). */
  app?: string
  permissions: Permissions
  /**
   * The two limits on one task (M15-7): most steps, and the estimate above which she asks first
   * — and the monthly budget, absent when there is none.
   */
  ceilings?: Limits
  messages: Turn[]
  spent: number
  cap?: number
  warning?: string
  /** Today's spending against today's allowance — the number that decides whether the router may spend at all. */
  today?: { spent: number; allowance: number }
  /** The paid switch is on: Automatic moves to paid by itself once the free models are done (§4 H). */
  cross?: boolean
  /** The personality in use, by name — the chip in the header. Absent is Alexia's own voice. */
  character?: string
  /** Something will listen to *That wasn't her*, so the button is worth drawing (improvement 10). */
  notHer?: boolean
  providers: Provider[]
  commands: Command[]
  /** The board's arrangement (D204). `null` is the default; absent is a core that predates it. */
  layout?: Layout | null
  /** Other ways in that are connected (D204) — whether taking Chat off the board needs asking. */
  channels?: number
}

const token = document.querySelector<HTMLElement>('[data-token]')?.dataset.token ?? ''

/**
 * The board (D204), placed before anything else is drawn into it: the layout the head script
 * left is read synchronously here, so the first frame is somebody's own arrangement rather
 * than the default with a jump to follow. Core's copy arrives with the first state read.
 */
const board = mountBoard(document.querySelector<HTMLElement>('#board')!, token, {
  // Edit view opens on the board, so a Settings or Activity sheet over it goes first — from the
  // dock's tab as from the palette. Under the sheet it was edit view nobody could see.
  opening: () => {
    if (sheetOpen()) show('chat')
  },
})

/** One of the board's pages, by the name the layout knows it by. */
const page = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-page="${id}"]`)!
const log = document.querySelector<HTMLElement>('#log')!
/** A line only a screen reader hears, saying an answer has finished (respond). */
const answered = document.querySelector<HTMLElement>('#answered')!
const note = document.querySelector<HTMLElement>('#note')!
const modelBadge = document.querySelector<HTMLElement>('#model')!
const rungBadge = document.querySelector<HTMLElement>('#rung')!
const characterChip = document.querySelector<HTMLElement>('#character')!

/**
 * **Who is answering, from the last state read** — the chip's value and whether *That wasn't
 * her* has anywhere to go.
 *
 * Held here because a live answer arrives on the stream rather than out of `paint()`, and the
 * row of actions under it has to be drawn at that moment. Reading the whole state first would
 * put a round trip between the last word and the buttons; using what was last read draws them
 * immediately and the refresh below corrects it if it was stale.
 */
let inCharacter: { name?: string; notHer: boolean } = { notHer: false }

/** The chip, and the two facts kept beside it. Called from every state read. */
function characterFrom(state: State): void {
  inCharacter = { ...(state.character !== undefined && { name: state.character }), notHer: state.notHer === true }
  characterChip.textContent = state.character ?? ''
  characterChip.hidden = state.character === undefined || state.character === ''
}

/**
 * **What Alexia can do right now**, beside the model that just did it.
 *
 * The rule this obeys is §8.4's: the bubble says what the assistant can *do*, not what it
 * costs. *Just chat now* is worth reading; *currently paid* is not — nobody cares that an
 * answer was billed, they care whether the thing can still pick a file up. Money already has
 * its own badge two elements along, and putting a price in this one would be saying the same
 * thing twice in the place reserved for the other thing.
 *
 * Hidden when there is nothing to say, which is every repaint of an old conversation: the
 * stored turns remember which model answered and not what the world looked like at the time,
 * and a stale state is worse than none.
 */
function wearing(bubble?: Bubble): void {
  rungBadge.hidden = bubble === undefined
  if (!bubble) {
    rungBadge.removeAttribute('data-state')
    rungBadge.textContent = ''
    return
  }
  rungBadge.textContent = bubble.says
  rungBadge.dataset.state = bubble.state
}
const form = document.querySelector<HTMLFormElement>('#ask')!
const text = document.querySelector<HTMLTextAreaElement>('#text')!
const button = form.querySelector('button')!
const prompt = document.querySelector<HTMLElement>('#prompt')!
const promptWhy = document.querySelector<HTMLElement>('#prompt-why')!
/**
 * What covers the rail: a sheet, or the palette. Apple's glass on the rail's switches is not
 * part of the page, so it would float over either; it hides while one is open.
 */
const around: Around = {
  covered: () => sheetOpen() || document.querySelector<HTMLElement>('#palette')?.hidden === false,
}
/** The permission control, twice: on Settings > Safety (D205) and the rail's slider. One writer. */
const permissions = document.querySelectorAll<HTMLSelectElement>('select.permission')
const railPermission = mountLevelSlider(document.querySelector<HTMLElement>('#permission-switch')!, around)
const stop = document.querySelector<HTMLButtonElement>('#stop')!

const money = (n: number): string => `$${n.toFixed(2)}`

/**
 * **Whether the log follows new words.** True while somebody is reading the bottom of it, and
 * false the moment they scroll up to reread something — an answer streaming in used to pull
 * them back down on every word, so nothing above the newest line could be read until it was
 * over. Kept from the log's own scroll events, because by the time new words have landed the
 * distance to the bottom has already grown by them.
 */
let pinned = true
const newWords = document.querySelector<HTMLButtonElement>('#new-words')!

/** New things in the log: kept in view for somebody at the bottom, offered to anybody who is not. */
function follow(): void {
  if (pinned) log.scrollTop = log.scrollHeight
  else newWords.hidden = false
}

/** To the bottom, whatever the reader was doing: a conversation just drawn, or a message they just sent. */
function toBottom(): void {
  log.scrollTop = log.scrollHeight
  pinned = true
  newWords.hidden = true
}

log.addEventListener('scroll', () => {
  pinned = nearBottom(log)
  if (pinned) newWords.hidden = true
})
newWords.addEventListener('click', () => {
  toBottom()
  text.focus()
})

/**
 * One turn in the log. `reply` is a command's answer that worked — said plainly, where a
 * `refusal` is drawn as the dashed box that means *this did not happen*.
 */
function bubble(kind: 'user' | 'assistant' | 'refusal' | 'reply', content = ''): HTMLElement {
  const element = document.createElement('div')
  element.className = `turn ${kind}`
  element.textContent = content
  log.append(element)
  // What somebody just sent is theirs, and they want to see it land wherever they were.
  if (kind === 'user') toBottom()
  else follow()
  return element
}

/**
 * **What the note line says when nothing newer has been said**: a standing boundary, which
 * stays on screen while it applies (see `showPermissions`). A new message clears whatever
 * else was there and puts this back.
 */
let standingNote = ''

function say(line?: string): void {
  const shown = line ?? standingNote
  note.textContent = shown
  note.hidden = shown === ''
}

const paidNote = document.querySelector<HTMLElement>('#paid-note')!
const popup = document.querySelector<HTMLElement>('#popup')!

/**
 * **What stands above the message box when the paid switch is on** (§4 H): *Paid models will be
 * used once the free ones are done, up to $1.00 today.* Put back whenever a charge line is cleared.
 */
let standingPaid = ''

/** The line before a charge, where nothing else writes (§4 G). Empty puts the standing warning back. */
function warnPaid(line?: string): void {
  const shown = line ?? standingPaid
  paidNote.textContent = shown
  paidNote.hidden = shown === ''
}

/** **How long a switch is on screen as a pop-up** (D160): long enough to read one sentence. */
const POPUP_MS = 3000
let popupTimer: number | undefined

/** A switch, said for three seconds; a newer one replaces it and starts its own three (§4 G). */
function pop(line: string): void {
  window.clearTimeout(popupTimer)
  popup.textContent = line
  popup.hidden = false
  // The words stay while it fades out (app.css); the next switch writes over them. A hidden
  // element is out of the accessibility tree, so nothing reads them again.
  popupTimer = window.setTimeout(() => {
    popup.hidden = true
  }, POPUP_MS)
}

/**
 * **The row of actions under the latest answer** (§4 I and improvement 10). One row for
 * everything a person can say about an answer, so the two are never two rows competing under
 * one bubble. Only the latest answer has it, because *Bad answer* asks that question again.
 *
 * **The two ask opposite questions about the same words.** *Bad answer* says it was wrong —
 * the answer is thrown away and something else is asked, and the model's record carries it.
 * *That wasn't her* says it was the right answer in the wrong voice — nothing is re-asked and
 * nothing is discarded, and what changes later is the personality.
 *
 * *That wasn't her* is drawn only when something is listening (`state.notHer`), which is the
 * honest version of *there is nothing here this would tell*.
 */
function answerActions(answer: HTMLElement, canSay = false): void {
  for (const old of log.querySelectorAll('.latest-only')) old.remove()
  const row = actionsRow(answer)
  const bad = document.createElement('button')
  bad.type = 'button'
  bad.className = 'quiet-button latest-only'
  bad.textContent = 'Bad answer'
  bad.title = 'Ask again with a different model. Two of these in a month move a model down.'
  bad.addEventListener('click', () => {
    if (!idle()) return
    for (const old of row.querySelectorAll('.latest-only')) old.remove()
    markBad(answer)
    running(() => respond('choosing', undefined, () => Promise.resolve({ again: true, bad: {} })))
  })
  row.append(bad)
  if (canSay) row.append(notHerButton(row, answer))
}

/**
 * **The row under an answer**, with *Copy* in it — made once per answer, and found again when
 * the latest answer's buttons are added to it. Every answer has *Copy*, not only the latest:
 * copying is not a verdict on the answer, so nothing about asking it twice goes wrong.
 */
function actionsRow(answer: HTMLElement): HTMLElement {
  const had = answer.querySelector<HTMLElement>(':scope > .message-actions')
  if (had !== null) return had
  const row = document.createElement('div')
  row.className = 'message-actions'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'quiet-button'
  copy.textContent = 'Copy'
  copy.title = 'Copy this answer'
  let back: number | undefined
  copy.addEventListener('click', () => {
    void copyText(wordsOf(answer)).then((copied) => {
      // Said on the button itself for a moment, which is where the eye already is.
      copy.textContent = copied ? 'Copied' : 'Could not copy'
      window.clearTimeout(back)
      back = window.setTimeout(() => (copy.textContent = 'Copy'), 1500)
    })
  })
  row.append(copy)
  answer.append(row)
  return row
}

/**
 * ***That wasn't her***, and the line that makes it worth more than a tally.
 *
 * **One press, then an optional sentence.** The press on its own is already a usable fact —
 * *this did not sound like her* — so it is sent immediately and the box that opens is a
 * kindness rather than a form: whoever cannot be bothered has already said the useful thing,
 * and whoever can says *she should have just answered, not explained herself* and turns a
 * complaint into an example.
 *
 * Nothing is re-asked and the answer stays on the page. It was the right answer; it was in
 * the wrong voice, and that is a thing about the personality rather than about this reply.
 */
function notHerButton(row: HTMLElement, answer: HTMLElement): HTMLElement {
  const said = document.createElement('button')
  said.type = 'button'
  said.className = 'quiet-button'
  said.textContent = 'That wasn’t her'
  said.title = 'Out of character. The answer stays; the personality is what gets fixed.'
  said.addEventListener('click', () => {
    said.disabled = true
    /**
     * **One box, however the press arrives.** The row above this is redrawn when a state read
     * comes back saying something is listening after all, so there are moments where a press
     * can land on a button whose row is about to be replaced — and two boxes under one answer,
     * each offering to take the line, is a question asked twice.
     */
    if (answer.querySelector('.not-her') !== null) return
    const box = document.createElement('div')
    box.className = 'not-her'
    /**
     * The press goes at once, and what comes back decides what the line under it may say.
     * `heard: false` is nothing having kept it — the plugin switched off since the last state
     * read, or nothing in use — and *Noted* over that would be the button lying.
     */
    const heard = post('/api/not-her', {})
      .then((back) => back.heard !== false)
      .catch(() => false)
    const unheard = (): void => {
      answer.classList.remove('not-her-marked')
      box.replaceChildren(noted('Nothing is keeping these right now, so that was not noted.'))
    }
    void heard.then((kept) => {
      if (!kept) unheard()
    })
    const field = document.createElement('input')
    field.type = 'text'
    field.className = 'not-her-line'
    field.placeholder = 'What should she have said? (optional)'
    field.setAttribute('aria-label', 'What she should have said')
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'quiet-button'
    send.textContent = 'Add'
    let sent = false
    const done = (): void => {
      // Enter and the button are the same press, and a second one is not a second line.
      if (sent) return
      sent = true
      closeNotHer = undefined
      const typed = field.value.trim()
      // The line is about the answer the press was about; core pairs the two, and the plugin
      // files it on the same moment rather than as a second one.
      void heard.then(async (kept) => {
        if (!kept) {
          unheard()
          return
        }
        const added =
          typed === '' ||
          (await post('/api/not-her', { said: typed })
            .then((back) => back.heard !== false)
            .catch(() => false))
        box.replaceChildren(
          noted(
            !added ? 'Marked, but the line did not reach anything that keeps it.'
            : typed === '' ? 'Noted. Refine, in Personality, will use this.'
            : 'Noted, with what she should have said.',
          ),
        )
      })
    }
    send.addEventListener('click', done)
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') done()
    })
    // Escape puts the box away as though nothing more was typed: the press itself was already
    // sent, so this is *no line to add*, not an undo. The window's own Escape asks for this
    // before it would put the window away.
    closeNotHer = () => {
      closeNotHer = undefined
      field.value = ''
      done()
    }
    box.append(field, send)
    row.after(box)
    field.focus()
    answer.classList.add('not-her-marked')
  })
  return said
}

/** How to put the open *That wasn't her* box away, while one is waiting for a line. */
let closeNotHer: (() => void) | undefined

/** The line that replaces the box once something has been said, so a press is never silent. */
function noted(text: string): HTMLElement {
  const line = document.createElement('p')
  line.className = 'bad-line'
  line.textContent = text
  return line
}

/** The names of what came with a question, under it: *📎 lease.pdf, picture*. */
function carriedLine(names: string[]): HTMLElement {
  const carried = document.createElement('small')
  carried.className = 'carried'
  carried.textContent = `📎 ${names.join(', ')}`
  return carried
}

/** *(stopped)*, after an answer that Stop cut short — so a half answer does not pass for a whole one. */
function stoppedMark(): HTMLElement {
  const mark = document.createElement('span')
  mark.className = 'stopped-mark'
  mark.textContent = '(stopped)'
  return mark
}

/** An answer somebody marked bad: dimmed, and saying so, rather than taken off the page. */
function markBad(answer: HTMLElement): void {
  answer.classList.add('bad')
  const line = document.createElement('p')
  line.className = 'bad-line'
  line.textContent = 'You marked this a bad answer. It is not shown to a model again.'
  answer.prepend(line)
}

/** A switch kept on its answer: a small line above the words, drawn again from history (§4 G). */
function switchLine(line: string): HTMLElement {
  const element = document.createElement('p')
  element.className = 'switch-line'
  element.textContent = line
  return element
}

// ---- attachments (D-documents) ------------------------------------------------------------

/**
 * What is coming with the next message.
 *
 * **The composer is core's own surface and this control belongs to it.** A plugin cannot add
 * one and should not be able to; what a plugin adds is the *reading* of what arrives, under a
 * capability name core resolves without knowing who answers. So this half is here, in the
 * shell, and it knows nothing about documents beyond the fact that a file has a name.
 *
 * Three ways in, because people use all three and none of them is the obvious one: drop it on
 * the conversation, paste it, or press Attach. **None of them involves a path** — a webview is
 * handed bytes, which is exactly why the file widget the manifest schema refused three times
 * is not what this is. There is nothing here for a plugin to declare.
 */
const attachedList = document.querySelector<HTMLElement>('#attached')!
const filePicker = document.querySelector<HTMLInputElement>('#file')!
const chatView = document.querySelector<HTMLElement>('#chat')!

/** The files themselves, until the message goes. Nothing is read until then. */
let carrying: File[] = []

function drawAttached(): void {
  attachedList.replaceChildren(
    ...carrying.map((file, at) => {
      const row = document.createElement('li')
      const name = document.createElement('b')
      name.textContent = file.name
      const size = document.createElement('span')
      size.textContent = readable(file.size)
      const off = document.createElement('button')
      off.type = 'button'
      off.textContent = '✕'
      off.title = `Do not send ${file.name}`
      off.setAttribute('aria-label', `Do not send ${file.name}`)
      off.addEventListener('click', () => {
        carrying.splice(at, 1)
        drawAttached()
      })
      row.append(name, size, off)
      return row
    }),
  )
  attachedList.hidden = carrying.length === 0
}

const readable = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B`
  : bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** The ceiling core enforces, said here too so the refusal arrives before the send does. */
const MOST_FILES = 8

function carry(files: Iterable<File>): void {
  for (const file of files) {
    if (carrying.length >= MOST_FILES) {
      say(`${String(MOST_FILES)} files is the most one message can carry.`)
      break
    }
    // A folder dropped on a webview arrives as an entry with no type and no size. There is
    // nothing to send, and saying so beats attaching a zero-byte nothing.
    if (file.size === 0) {
      say(`${file.name} is empty, or is a folder. Nothing was attached.`)
      continue
    }
    carrying.push(file)
  }
  drawAttached()
  text.focus()
}

/**
 * **What was actually read out of each file, foldable, under the turn that carried it.**
 *
 * A chat turn is a sentence somebody typed and knows the contents of. An attached document is
 * a page of things they did not type — and the honest observation about uploads is that
 * nobody reads the extracted text before it goes. This does not change what is sent or what is
 * stripped on the way out; it changes whether the person who attached it can see what they
 * attached, which up to here they could not.
 *
 * Closed by default, because the answer they asked for is what they came for and a wall of
 * their own lease above it is not.
 */
function showRead(turn: HTMLElement, attached: { name: string; text?: string; refusal?: string }[]): void {
  for (const one of attached) {
    const box = document.createElement('details')
    box.className = 'read'
    const summary = document.createElement('summary')
    summary.textContent =
      one.text === undefined ?
        `${one.name} — not read`
      : `${one.name} — ${one.text.length.toLocaleString('en-GB')} characters read`
    const body = document.createElement('pre')
    body.textContent = one.text ?? one.refusal ?? ''
    box.append(summary, body)
    turn.append(box)
  }
}

/**
 * **An answer as a card** (B5): what a task read off the screen, by name, with the page it came
 * from. Every value was copied from the screen by the plugin, so the card says only what was
 * there; the link is a web page or nothing (core checks it before it gets here).
 */
function showCard(turn: HTMLElement, card: { title: string; fields: Record<string, string>; url?: string }): void {
  const box = document.createElement('div')
  box.className = 'answer-card'
  const title = document.createElement('p')
  title.className = 'answer-card-title'
  title.textContent = card.title
  const list = document.createElement('dl')
  for (const [name, value] of Object.entries(card.fields)) {
    const term = document.createElement('dt')
    term.textContent = name
    const said = document.createElement('dd')
    said.textContent = value
    list.append(term, said)
  }
  box.append(title, list)
  if (card.url !== undefined && /^https?:\/\//i.test(card.url)) {
    const link = document.createElement('a')
    link.className = 'tile-link'
    link.href = card.url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = 'Open the page'
    box.append(link)
  }
  turn.append(box)
}

/**
 * A button on a running step (*Take over*, *Continue*), pressed through the same route as the
 * panel's own buttons: the plugin is the one whose tool the step is, and the key must be one of
 * its declared actions, which core checks. The shell names no plugin.
 */
document.addEventListener(CONTROL_EVENT, (event) => {
  const { tool, key } = (event as CustomEvent<{ tool: string; key: string }>).detail
  const cut = tool.indexOf('__')
  if (cut <= 0) return
  void post('/api/action', { plugin: tool.slice(0, cut), key }).catch(() => undefined)
})

/**
 * **A file a tool made, under the answer that made it, with something to press.**
 *
 * The mirror of `showRead` above, and the gap it closes was already costing something before
 * this existed: the picture plugin finished generating an image and returned its *path*, in
 * prose. Correct, and nothing a person could do anything with — the file was on their own
 * disk and the only way to reach it was to read the sentence, select the path out of it, and
 * go and find it in a file manager.
 *
 * **Four things, because people want different ones.** Open it now; save a copy somewhere
 * they choose; find it where it already is; or take the path, which is what you want when
 * the next thing you are doing is typing it into something else.
 *
 * Nothing here is given a path to send back. Every button carries the id core handed over,
 * which is the whole reason the routes behind them cannot be pointed at somebody's keys.
 */
function showFiles(
  turn: HTMLElement,
  files: { id: string; name: string; bytes: number; mime: string; path: string; openable: boolean }[],
): void {
  for (const one of files) {
    const row = document.createElement('div')
    row.className = 'made'

    const line = document.createElement('div')
    line.className = 'made-line'
    const name = document.createElement('span')
    name.className = 'made-name'
    name.textContent = one.name
    const size = document.createElement('small')
    size.textContent = size3(one.bytes)
    line.append(name, size)

    const buttons = document.createElement('div')
    buttons.className = 'made-buttons'

    /** One press, one sentence back if it did not work. */
    const act = (label: string, run: () => Promise<void>): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'quiet-button'
      button.textContent = label
      button.addEventListener('click', () => {
        button.disabled = true
        void run()
          .catch((error: unknown) => say(String(error instanceof Error ? error.message : error)))
          .finally(() => (button.disabled = false))
      })
      return button
    }

    const post = async (action: 'open' | 'reveal'): Promise<void> => {
      const answered = (await (
        await fetch('/api/file', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-alexia-token': token },
          // `confirm` is the contract on the wire (`guard.ts`), and this button's own label
          // is the confirmation — the person pressed *Open*, which is the whole question.
          body: JSON.stringify({ id: one.id, action, confirm: true }),
        })
      ).json()) as { ok: boolean; said?: string }
      if (!answered.ok) say(answered.said ?? 'That did not work.')
    }

    /**
     * Saved through a blob rather than a link straight at the route.
     *
     * The route wants the session token in a header and a browser sends no headers when it
     * follows a download link — so the alternative is the token in the URL, where it would
     * land in history. Fetching it here costs one copy in memory and keeps it out.
     */
    const save = async (): Promise<void> => {
      const answered = await fetch(`/api/file?id=${encodeURIComponent(one.id)}`, {
        headers: { 'x-alexia-token': token },
      })
      if (!answered.ok) {
        const why = (await answered.json()) as { said?: string }
        say(why.said ?? `${one.name} could not be saved.`)
        return
      }
      const href = URL.createObjectURL(await answered.blob())
      const link = document.createElement('a')
      link.href = href
      link.download = one.name
      link.click()
      URL.revokeObjectURL(href)
    }

    if (one.openable) buttons.append(act('Open', () => post('open')))
    buttons.append(
      act('Save', save),
      act('Show in folder', () => post('reveal')),
      act('Copy path', async () => {
        try {
          await navigator.clipboard.writeText(one.path)
          say(`Copied ${one.path}`)
        } catch {
          // A browser that will not give the page the clipboard. Showing the path is the
          // next best thing, because it can at least be selected out of the line.
          say(one.path)
        }
      }),
    )

    row.append(line, buttons)

    // A picture is worth showing rather than naming. Same fetch as Save, so an image that
    // has since been deleted simply does not appear rather than drawing a broken frame.
    if (one.mime.startsWith('image/')) {
      void fetch(`/api/file?id=${encodeURIComponent(one.id)}`, { headers: { 'x-alexia-token': token } })
        .then(async (answered) => (answered.ok ? answered.blob() : undefined))
        .then((blob) => {
          if (!blob) return
          const picture = document.createElement('img')
          picture.className = 'made-preview'
          picture.src = URL.createObjectURL(blob)
          picture.alt = one.name
          row.prepend(picture)
        })
        .catch(() => {
          // Nothing to say. The row and its buttons are already there and all of them work.
        })
    }

    turn.append(row)
  }
}

/** Bytes, as a person would say them. */
const size3 = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B`
  : bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * The bytes, base64, in a JSON body — which is what `plan.md` settled long before there was
 * anything to upload: `node:http` has no multipart parser and adding one for this would buy
 * core a parser it otherwise never needs.
 *
 * Chunked, because `btoa(String.fromCharCode(...bytes))` on a twenty-megabyte file is a
 * stack overflow rather than a string.
 */
/**
 * The long side a vision model actually looks at. Anything past this is tiled away by the
 * model itself, so sending it is paying upload time for pixels nobody reads.
 */
const MOST_PIXELS = 1568

/** Under this, and already small enough, a picture goes exactly as it is. */
const LEAVE_ALONE = 1024 * 1024

/**
 * **A picture, made small enough to be worth sending.**
 *
 * Measured on a real attachment rather than guessed at: a 1672×941 illustration saved as PNG
 * was **3.62 MB**, and the same image at JPEG quality 85 is **394 KB** — nine times smaller,
 * for a picture the model was going to tile down anyway. That difference is most of the wait
 * between pressing send and getting an answer, and all of it is spent uploading detail no
 * model ever sees. It is re-sent with every later turn too, because history goes whole.
 *
 * ponytail: `createImageBitmap` and `OffscreenCanvas`, both of which every browser this runs
 * in already has. No image library, nothing to bundle, and the work happens on the machine
 * that already has the bytes in memory.
 *
 * **Three things it deliberately will not do.** It never touches anything that is not an
 * image. It leaves a small picture exactly as it is — a crisp screenshot somebody wants text
 * read out of stays pixel-for-pixel, because that is the case where lossy re-encoding costs
 * something real. And it keeps the original whenever the re-encode comes out bigger, which
 * happens with flat-coloured graphics that PNG is genuinely good at.
 */
async function smaller(file: File): Promise<{ blob: Blob; type: string; was?: number }> {
  if (!file.type.startsWith('image/')) return { blob: file, type: file.type }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // A format the browser cannot decode. It may still be one the model can read, so it goes
    // as it is rather than being refused by the one part of this that was only an optimisation.
    return { blob: file, type: file.type }
  }
  const longest = Math.max(bitmap.width, bitmap.height)
  if (file.size <= LEAVE_ALONE && longest <= MOST_PIXELS) {
    bitmap.close()
    return { blob: file, type: file.type }
  }

  const scale = Math.min(1, MOST_PIXELS / longest)
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return { blob: file, type: file.type }
  }
  // JPEG has no transparency. Without this, every transparent pixel of a PNG arrives black,
  // which on a logo or a diagram is the whole picture ruined rather than a bit of quality.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return jpeg.size < file.size ?
      { blob: jpeg, type: 'image/jpeg', was: file.size }
    : { blob: file, type: file.type }
}

async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

// Attach is a button, so a keyboard reaches it, and it opens the hidden file input.
document.querySelector<HTMLButtonElement>('#attach')!.addEventListener('click', () => filePicker.click())
filePicker.addEventListener('change', () => {
  carry(filePicker.files ?? [])
  // Cleared, or picking the same file twice in a row fires no event the second time.
  filePicker.value = ''
})

// Paste. A screenshot pasted here is refused by whatever reads documents rather than here —
// the shell does not decide what is readable, and a refusal that names the reason is better
// than one that names a file extension.
text.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  carry(files)
})

// Drop, anywhere on the conversation. Aiming at a strip above the composer is a thing people
// miss, and a target nobody can find is a feature nobody has.
for (const kind of ['dragenter', 'dragover'] as const) {
  chatView.addEventListener(kind, (event) => {
    if (!(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    chatView.classList.add('dropping')
  })
}
for (const kind of ['dragleave', 'drop'] as const) {
  chatView.addEventListener(kind, () => chatView.classList.remove('dropping'))
}
chatView.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  carry(files)
})
// The window's own handler, so a file dropped anywhere else opens nothing. A webview that
// navigates to a PDF because somebody missed the pane has thrown the conversation away.
for (const kind of ['dragover', 'drop'] as const) {
  window.addEventListener(kind, (event) => event.preventDefault())
}

/**
 * First run, steps 2 to 4a: what to call it, where the work happens, and — only if that
 * answer involves somebody else's computer — a key. Nothing else. No account, no tour, no
 * permission questions, because asking which folders an assistant may read before it has
 * been given a single task is a question with no meaning yet.
 */
/**
 * The chosen name, everywhere it is written down. Alexia.md is explicit that whatever gets
 * typed at step 2 "becomes the name they see everywhere" — and the composer, which is the
 * box a renamer looks at most, was the one place still saying "Ask Alexia" out loud.
 */
function called(name: string): void {
  document.querySelector<HTMLElement>('.name')!.textContent = name
  text.placeholder = `Ask ${name}`
  text.setAttribute('aria-label', `Message ${name}`)
  // And the label over every one of her messages, which the sheet draws rather than the
  // shell. A custom property because `content` can read one and cannot read an ancestor's
  // attribute — and a hardcoded "Alexia" there is exactly the sort of place a rename
  // quietly does not reach.
  document.documentElement.style.setProperty('--her', JSON.stringify(name))
}

/**
 * Which of the two views is on screen. One attribute, because the alternative is two elements
 * whose `hidden` flags have to agree — and the one thing this shell must never do is show the
 * composer and first run at once, inviting a question it cannot answer yet.
 */
let showing = 0
let firstLocal: LocalModelsView | undefined
let closeSettingsLocal: (() => void) | undefined = undefined

/**
 * The sheet as a dialog (modal.ts). Only the board goes inert under it: the dock is drawn above
 * the sheet on purpose, because its tabs switch between Settings and Activity and take the sheet
 * away for Edit layout, and an inert dock would take that away from a mouse as well.
 */
const sheetDialog = modal(document.querySelector<HTMLElement>('#sheet')!, () => [document.querySelector<HTMLElement>('#board')!])

function show(view: 'first-run' | 'chat' | 'settings' | 'control'): void {
  if (view !== 'settings') closeSettingsLocal?.()
  if (view !== 'first-run') firstLocal?.close()
  // A genie still playing is finished first, and a close still waiting to change the view is
  // overtaken: the last thing asked for is what is on screen.
  const mine = ++showing
  stopGenie()
  const was = document.body.dataset.view
  const sheet = document.querySelector<HTMLElement>('#sheet')!
  const tab = (of: string | undefined): HTMLElement | null =>
    document.querySelector<HTMLElement>(of === 'control' ? '#open-control' : '#open-settings')
  const inSheet = (one: string | undefined): boolean => one === 'settings' || one === 'control'
  // The sheet is a dialog: the board goes inert under it, focus moves in, and it goes back
  // to whatever opened it when it closes. In once the sheet is laid out, since a heading
  // that is not on screen yet cannot take focus.
  const landed = (): void => {
    if (inSheet(view)) sheetDialog.open(document.querySelector<HTMLElement>(view === 'control' ? '#control-heading' : '#settings-heading')!)
  }
  if (inSheet(was) && !inSheet(view)) sheetDialog.close(text)
  // Settings and Activity come out of their tab in the dock and go back into it (genie.ts).
  // Closing keeps the sheet laid out until the picture of it has gone in: the view is what lays
  // it out, and it is the view that takes it away afterwards.
  if (inSheet(was) && view === 'chat') {
    const into = tab(was)
    if (into) {
      void genieIn(was!, sheet, into).then(() => {
        if (showing === mine) document.body.dataset.view = view
      })
      return
    }
  }
  if (inSheet(view) && !inSheet(was)) {
    const from = tab(view)
    if (from) {
      // The view changes when the genie is ready to play, a moment later the first time.
      genieOut(view, sheet, from, () => {
        if (showing !== mine) return false
        document.body.dataset.view = view
        landed()
        return true
      })
      return
    }
  }
  document.body.dataset.view = view
  landed()
}

/** Whether Settings or Activity is the sheet over the board right now. */
const sheetOpen = (): boolean => document.body.dataset.view === 'settings' || document.body.dataset.view === 'control'

function firstRun(state: State): void {
  const connect = document.querySelector<HTMLElement>('#connect')!
  const name = document.querySelector<HTMLInputElement>('#name')!
  show('first-run')
  name.value = state.setup.name

  const chosen = (): string =>
    document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'combined'

  /**
   * **Skipping is what the button says, until a key exists** (§12.2, and §2 is the reason).
   *
   * Zero keys reaches a working conversation — that is the whole promise the rest of this
   * project is built on — so the screen is not allowed to present leaving without one as the
   * lesser path. A grey *skip* link under a loud *Start* says exactly that, quietly, to
   * everybody who reads it; a primary button wearing the words instead says the opposite just
   * as quietly. It is the same click either way, and the difference is the sentence a person
   * takes with them.
   */
  const begin = document.querySelector<HTMLButtonElement>('#begin')!
  const skipLine = document.querySelector<HTMLElement>('#skip-line')!
  // Keys somebody pasted, not providers that can be asked: the keyless floor is always the
  // second, and counting it here meant *start with no keys* could never be said.
  let keys = state.providers.filter((p) => p.keyStored).length
  let localReady = false
  let starting = false
  const standing = (): void => {
    const none = keys === 0 && chosen() !== 'local'
    begin.textContent = none ? 'Skip — start with no keys' : 'Start'
    begin.disabled = starting || (chosen() === 'local' && !localReady)
    skipLine.textContent =
      none ?
        'Alexia answers with no key at all: some of the AI services above ask for nothing, and a model on this computer does too. Keys make her faster, and you can add one in Settings any time.'
      : chosen() === 'local' && !localReady ? 'Install a model below, or use one already installed in Ollama, before starting in Local mode.' : ''
  }

  const localRoot = el('section')
  connect.after(localRoot)
  firstLocal = mountLocalModels(localRoot, {
    request: post,
    mode: chosen,
    firstRun: true,
    changed: () => { void read().then((state) => modeFeedback.sync(state)).catch(() => undefined) },
    ready: (ready) => { localReady = ready; standing() },
  })

  const showWall = (): void => {
    // Local mode asks nobody for a key, so the whole step goes away rather than sitting there
    // greyed out looking like something you got wrong.
    connect.hidden = chosen() === 'local'
    const wasHidden = localRoot.hidden
    localRoot.hidden = chosen() !== 'local'
    if (localRoot.hidden) firstLocal?.close()
    else if (wasHidden || localRoot.childElementCount === 0) firstLocal?.open()
    standing()
  }
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', showWall)
  }
  // Counted once per provider: a second key pasted over the first is still one provider keyed.
  const keyedHere = new Set(state.providers.filter((p) => p.keyStored).map((p) => p.id))
  keyWall(state, (id) => {
    keyedHere.add(id)
    keys = keyedHere.size
    standing()
  })
  showWall()

  /**
   * Step 5, and the whole of it: *it lives in the tray, this is how you summon it.*
   *
   * Said once, here, and never again — a tour is what this is instead of. In a browser the
   * block is not shown at all, because a tray icon and a global hotkey are not things a
   * browser has and telling somebody about them there would be a lie.
   */
  const desktop = document.querySelector<HTMLElement>('#desktop')!
  const startsUp = document.querySelector<HTMLInputElement>('#autostart')!
  if (inApp()) {
    desktop.hidden = false
    document.querySelector<HTMLElement>('#hotkey-line')!.textContent =
      `Alexia lives in the tray from now on. Press ${HOTKEY} anywhere to talk to her, and Escape to put her away. A task that is running keeps running.`
    // Checked by default and honoured on Start. A daemon that does not come back after a
    // restart is a daemon somebody has to remember to launch, which is the thing it exists
    // not to be.
    void autostart().then((on) => (startsUp.checked = on ?? true))
  }

  // What it can do, read off the shelf while the rest of first run is being answered (D118).
  const shelf = shelfStep()

  begin.addEventListener('click', () => {
    // No key travels with this any more: a tile saves its own the moment it is pasted, so by
    // the time anybody reaches this button the keychain already has whatever it is getting.
    if (chosen() === 'local' && !localReady) return
    starting = true
    standing()
    void post('/api/setup', { name: name.value.trim() || 'Alexia', mode: chosen() })
      // The plugins picked above, installed **before the screen changes**. Handing somebody
      // the conversation and then filling their assistant in behind it would make the first
      // thing they typed land on an Alexia that could not yet do what they had just asked for.
      .then(async () => {
        let state = await read()
        await modeFeedback.sync(state)
        while (state.modeTransition && !['ready', 'failed'].includes(state.modeTransition.phase)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
          state = await read()
        }
        await modeFeedback.sync(state)
        if (state.modeTransition?.phase === 'failed') throw new Error(state.modeTransition.message)
        await shelf.install()
      })
      .then(() => {
        if (inApp()) setAutostart(startsUp.checked)
        show('chat')
        called(name.value.trim() || 'Alexia')
        text.focus()
      })
      .catch((error: unknown) => { skipLine.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}. Try again.` })
      .finally(() => { starting = false; begin.disabled = chosen() === 'local' && !localReady })
  })
}

/**
 * **The key wall** (§12.2), and the shape of it is the argument.
 *
 * Every provider is a tile of the same size. There is no fork at the top asking *OpenRouter
 * or OmniRoute?* — that is a question about somebody else's plumbing, put to a person who has
 * not used the thing yet, and it contradicts the two minutes the whole first run is allowed.
 * The aggregators are tiles among many, sorted no differently.
 *
 * **What is on a face is what costs you something.** The published free-tier numbers, so the
 * choice is between real quantities rather than between logos. What it takes to get in, where
 * that is more than an email — a Telegram channel to join, an account id to go and find. And
 * what it costs in privacy where anybody has actually checked, which for one provider here is
 * *your prompts train it*. All three are things people currently discover three clicks into a
 * signup, and discovering them there is what makes the minute feel wasted.
 *
 * **Nothing here is required.** {@link skipping} is the other half of this screen.
 */
function keyWall(state: State, saved: (id: string) => void): void {
  const wall = document.querySelector<HTMLElement>('#wall')!
  const keyless = state.providers.filter((p) => p.keyless).length
  /**
   * **Which of them want a card, from the rows** (D165). This said *none of them wants a card*
   * as a fact about the screen, and it stopped being one when Cerebras's trial started asking.
   */
  const carded = state.providers.filter((p) => p.card === true).map((p) => p.name)
  const cards =
    carded.length === 0 ? 'none of them wants a card'
    : carded.length === 1 ? `only ${carded[0] ?? ''} wants a card`
    : `${carded.slice(0, -1).join(', ')} and ${carded.at(-1) ?? ''} want a card`
  document.querySelector<HTMLElement>('#wall-hint')!.textContent =
    keyless > 0 ?
      `${String(keyless)} of these answer with no key at all. A key on any of the others makes Alexia faster, and ${cards}.`
    : `A key on any of these makes Alexia faster, and ${cards}.`

  // The honest trade, said once under the wall rather than on twenty tiles: nobody has read
  // most of these terms, and "we have not checked" beats a confident wrong answer.
  const unchecked = state.providers.filter((p) => p.trainsOnYourData === 'unknown').length
  document.querySelector<HTMLElement>('#training')!.textContent =
    unchecked > 0 ?
      `Whether ${String(unchecked)} of these ${String(state.providers.length)} AI services train on what you send them is not yet checked. Alexia says so rather than guessing.`
    : ''

  for (const provider of state.providers) wall.append(tile(provider, saved))
}

/** The published free tier, in the unit the provider actually rations. */
function allowance(provider: Provider): string {
  const said = [
    provider.rpm === undefined ? '' : `${String(provider.rpm)} requests a minute`,
    provider.rpd === undefined ? '' : `${String(provider.rpd)} requests a day`,
    provider.callsPerMonth === undefined ? '' : `${String(provider.callsPerMonth)} requests a month`,
  ].filter(Boolean)
  return said.length > 0 ? said.join(' · ') : 'limits not published'
}

/**
 * One tile: the name, what it gives, what it costs, and a box to paste a key into.
 *
 * The box is on the tile rather than one shared box under a dropdown, which is the change
 * this screen is. A dropdown makes connecting two providers a thing you do twice without
 * being able to see that you did it once; twenty boxes that each remember their own answer
 * make it obvious.
 */
function tile(provider: Provider, saved: (id: string) => void): HTMLElement {
  const card = el('div', 'tile')
  card.dataset.provider = provider.id

  const head = el('div', 'tile-head')
  head.append(el('b', 'tile-name', provider.name))
  if (provider.keyless) head.append(el('span', 'flag good', 'works with no key'))
  // One badge, made once and shown when a key is stored, so a second save cannot add a second.
  const stored = el('span', 'flag good', 'key stored')
  stored.hidden = !provider.keyStored
  head.append(stored)
  card.append(head)

  card.append(el('span', 'tile-free', allowance(provider)))

  // The two costs that are not money, on the face. Friction first, because it is the one
  // that decides whether somebody starts at all.
  if (provider.friction) card.append(el('span', 'flag warn', provider.friction))
  if (provider.account) card.append(el('span', 'flag warn', 'Needs your account ID as well as a key'))
  if (provider.trainsOnYourData === 'yes') card.append(el('span', 'flag warn', 'Trains on what you send it'))

  const paste = el('input', 'tile-key') as HTMLInputElement
  paste.type = 'password'
  paste.autocomplete = 'off'
  paste.placeholder = provider.account ? 'account ID:key' : 'Paste your key'
  paste.setAttribute('aria-label', `Key for ${provider.name}`)
  card.append(paste)

  const said = el('span', 'tile-said')
  card.append(said)

  /**
   * *How do I get one?*, per tile, and it opens in place.
   *
   * What it can honestly say is what the row knows: the exact limits, when somebody last
   * checked them against the provider's own docs, and a link to those docs — which is where
   * a key is minted. Three invented steps would read better and be wrong the week a signup
   * flow changes, and a first-run screen that lies about a signup is worse than one that
   * points at the page.
   */
  const how = el('details', 'tile-how')
  how.append(el('summary', undefined, 'How do I get one?'))
  const lines = [
    `Free tier: ${allowance(provider)}.`,
    provider.friction ?? '',
    provider.account ? 'It also needs your account ID. Paste the ID, a colon, then the key, like abc123:your-key.' : '',
    provider.trainsOnYourData === 'yes' ? 'Its free tier logs prompts and answers for training.'
    : provider.trainsOnYourData === 'no' ? 'It does not train on what you send it.'
    : 'Whether it trains on what you send it is not checked yet.',
    provider.verified ? `Last checked against its own docs on ${provider.verified}.` : '',
  ].filter(Boolean)
  for (const line of lines) how.append(el('p', 'hint', line))
  if (provider.terms) {
    const link = el('a', 'tile-link', 'Its limits and terms, and where the key comes from')
    link.href = provider.terms
    link.target = '_blank'
    link.rel = 'noreferrer'
    how.append(link)
  }
  card.append(how)

  /**
   * **Saved once per paste.** Enter and `change` both land here — Enter commits the box, which
   * fires `change` as well — so the key being saved is remembered, and the same key a second
   * time while it is on its way is the same save, not another one.
   */
  let sending: string | undefined
  const store = (): void => {
    const typed = paste.value.trim()
    if (!typed || typed === sending) return
    sending = typed
    paste.disabled = true
    void post('/api/setup', { provider: { id: provider.id, key: typed } })
      .then((answer) => {
        paste.value = ''
        said.className = 'tile-said good'
        // What the key unlocked, now that core waits for the list (§1 step 3).
        said.textContent = typeof answer.said === 'string' ? answer.said : 'Saved to the keychain.'
        stored.hidden = false
        saved(provider.id)
        redrawModels()
      })
      // A key is the one thing nobody can check by looking, so a silent failure here is a
      // person pasting the same key again forever. A key the provider refused comes back as a
      // whole sentence of its own, in red where it was pasted; the key it replaced, if any, is
      // still stored, so the badge stays as it was.
      .catch((error: unknown) => {
        said.className = 'tile-said error'
        said.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`
      })
      .finally(() => {
        sending = undefined
        paste.disabled = false
      })
  }
  paste.addEventListener('change', store)
  paste.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') store()
  })
  return card
}

/**
 * The same three questions, on a screen you can go back to (M2-1).
 *
 * First run is thirty seconds long and it is the only place these were ever answerable —
 * which made *what should I call you* and *where do my words go* decisions taken once, by
 * somebody who had not yet used the thing. Nothing new is stored: this writes the identical
 * `/api/setup` the Start button writes, and the mode goes through the same slash command the
 * header's picker does.
 */
function setupSettings(state: State): void {
  const name = document.querySelector<HTMLInputElement>('#name-setting')!
  const provider = document.querySelector<HTMLSelectElement>('#provider-setting')!
  const key = document.querySelector<HTMLInputElement>('#key-setting')!
  const save = document.querySelector<HTMLButtonElement>('#save-key')!
  const remove = document.querySelector<HTMLButtonElement>('#remove-key')!
  const said = document.querySelector<HTMLElement>('#key-said')!

  name.value = state.setup.name
  // On `change`, so it saves when somebody has finished typing rather than on every letter —
  // and blank means the default rather than an assistant with no name.
  name.addEventListener('change', () => {
    const chosen = name.value.trim() || 'Alexia'
    name.value = chosen
    void post('/api/setup', { name: chosen }).then(() => called(chosen))
  })

  /**
   * Which painting is on the wall.
   *
   * Stored beside the name and the mode and written by the same endpoint, because it is the
   * same kind of thing: an answer about this install that outlives the window it was given
   * in. The screen changes on the press and the write goes after it — a theme that waited for
   * a round trip would be a control that feels broken while it works — and a write that fails
   * costs the next launch one frame, which `theme.ts`'s mirror has already covered.
   */
  mountTheme(state.setup.theme, (theme) => {
    void post('/api/setup', { theme })
  })

  // The frost, on the same endpoint for the same reason — a fact about this install, not
  // about this window. `theme.ts`'s mirror covers the launch a failed write would cost.
  mountGlass(state.setup.glass, (glass) => {
    void post('/api/setup', { glass })
  })

  // Whose glass the rail's switches are made of: Apple's, where this Mac has it, or Alexia's
  // own. Same endpoint, same reason — and asked of the shell once, at boot.
  mountGlassLook(state.setup.glassLook, [railMode, railPermission], glassSupported(), (glassLook) => {
    void post('/api/setup', { glassLook })
  })

  for (const option of state.providers) {
    provider.add(new Option(option.free ? `${option.name} — free tier` : option.name, option.id))
  }

  /**
   * Whether there is a key for the chosen one, and its terms. The key itself is not here and
   * cannot be: it went to the keychain, and a box that looked the same either way would have
   * a person pasting a key they had already pasted to find out.
   */
  // A key really stored, not merely reachable: *A key is stored for AI Horde* and a Remove
  // button beside it were said about a provider that answers with no key at all.
  const connected = new Set(state.providers.filter((p) => p.keyStored).map((p) => p.id))
  const describe = (): void => {
    const picked = state.providers.find((p) => p.id === provider.value)
    said.className = 'hint'
    said.textContent =
      connected.has(provider.value) ? `A key is stored for ${picked?.name ?? provider.value}. Pasting one replaces it. `
      : picked?.keyless === true ? `${picked.name} works with no key, so one is optional. `
      : `No key yet for ${picked?.name ?? provider.value}. `
    if (picked?.account === true) said.append('Paste your account ID, a colon, then the key. ')
    // The terms as a link that opens them, the way the first-run tile does, not an address
    // somebody has to copy out of a grey line.
    if (picked?.terms) {
      const link = el('a', '', 'Terms')
      link.href = picked.terms
      link.target = '_blank'
      link.rel = 'noreferrer'
      said.append(link)
    }
    // The way out sits beside the way in, and only where there is something to take out.
    remove.hidden = !connected.has(provider.value)
    disarm()
  }

  /**
   * **Remove a key** (§1 step 4), on the same screen that adds one.
   *
   * Two presses, because what it deletes cannot be read back: the keychain is the only copy
   * this machine has, and a key is minted on somebody else's site. The first press only
   * changes the button's words; anything else — choosing another provider, three seconds —
   * puts them back.
   */
  let armed: number | undefined
  const disarm = (): void => {
    window.clearTimeout(armed)
    armed = undefined
    remove.textContent = 'Remove key'
  }
  remove.addEventListener('click', () => {
    if (armed === undefined) {
      remove.textContent = 'Press again to remove'
      armed = window.setTimeout(disarm, 3000)
      return
    }
    disarm()
    const id = provider.value
    remove.disabled = true
    void post('/api/setup', { provider: { id, remove: true } })
      .then((answer) => {
        connected.delete(id)
        describe()
        if (typeof answer.said === 'string') said.textContent = answer.said
        redrawModels()
      })
      .catch((error: unknown) => {
        said.className = 'error'
        said.textContent = `Not removed: ${error instanceof Error ? error.message : String(error)}`
      })
      .finally(() => (remove.disabled = false))
  })

  provider.addEventListener('change', describe)
  describe()

  const store = (): void => {
    if (!key.value.trim()) return
    save.disabled = true
    void post('/api/setup', { provider: { id: provider.value, key: key.value.trim() } })
      .then((answer) => {
        connected.add(provider.value)
        key.value = ''
        describe()
        // Said out loud, because the box empties and nothing else on the screen moves — and
        // said as what the key unlocked, which core waited to find out (§1 step 3).
        said.textContent = typeof answer.said === 'string' ? answer.said : `Saved to the keychain. ${said.textContent}`
        redrawModels()
      })
      // And said out loud when it does not: a key is the one thing somebody cannot check by
      // looking, so a silent failure here is a person pasting the same key again forever.
      .catch((error: unknown) => {
        said.className = 'error'
        said.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`
      })
      .finally(() => (save.disabled = false))
  }
  save.addEventListener('click', store)
  key.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') store()
  })
}

/**
 * **A key changed, so the lists that follow the keychain are drawn again** (§1 steps 3–4): the
 * rail's models, and the Models & money page when it is the screen being looked at. A page
 * that is not on screen reads its rows when it is next opened, so there is nothing to redraw.
 */
function redrawModels(): void {
  void rail.refresh()
  if (document.body.dataset.view === 'settings') settings.redrawModels()
}

// The keyless floor's switch (D154) changes which providers can be reached, which is what a key
// changes, so it asks for the same redraw from inside the widget that draws it.
window.addEventListener(MODELS_CHANGED, () => {
  redrawModels()
})

/** The last `compute` any state read carried, for the rail, the mode line and Settings. */
let compute: ComputeState | undefined

const read = async (): Promise<State> => {
  const state = (await (await fetch('/api/state', { headers: { 'x-alexia-token': token } })).json()) as State
  compute = state.compute
  const editing = document.querySelector<HTMLButtonElement>('#edit-pictures')
  if (editing) editing.hidden = state.editor?.installed !== true
  showAdult(state.adult)
  return state
}

/**
 * **Edit pictures** (the image editor, A07). Opens over everything for the conversation on
 * screen — asked for at the press, because which conversation is open can change while the
 * button sits there.
 */
/** Settings › Safety › Adult content: which button is offered, and the 18+ box only while it is off. */
function showAdult(adult: State['adult']): void {
  const on = document.querySelector<HTMLButtonElement>('#adult-on')
  const off = document.querySelector<HTMLButtonElement>('#adult-off')
  const age = document.querySelector<HTMLInputElement>('#adult-age')
  if (!on || !off || !age) return
  const confirmed = adult?.confirmed === true
  on.hidden = confirmed
  off.hidden = !confirmed
  age.closest('label')!.hidden = confirmed
}
const adultSaid = (text: string): void => {
  const said = document.querySelector<HTMLElement>('#adult-said')
  if (said) said.textContent = text
}
const setAdult = async (enabled: boolean): Promise<void> => {
  const answered = await fetch('/api/adult', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': token },
    body: JSON.stringify({ enabled, adult: document.querySelector<HTMLInputElement>('#adult-age')?.checked === true, confirm: true }),
  })
  const said = (await answered.json().catch(() => ({}))) as { said?: string }
  adultSaid(said.said ?? '')
  showAdult((await read()).adult)
}
document.querySelector<HTMLButtonElement>('#adult-on')?.addEventListener('click', () => {
  if (document.querySelector<HTMLInputElement>('#adult-age')?.checked !== true) {
    adultSaid('Tick “I am 18 or older” first.')
    return
  }
  void setAdult(true)
})
document.querySelector<HTMLButtonElement>('#adult-off')?.addEventListener('click', () => void setAdult(false))

document.querySelector<HTMLButtonElement>('#edit-pictures')?.addEventListener('click', () => {
  void read().then((state) => {
    if (state.editor?.installed !== true) return
    return openImageEditor({ token, conversationId: state.editor.conversationId, behind: () => [document.querySelector<HTMLElement>('#board')!] })
  }).catch(() => undefined)
})

/**
 * The conversation on screen, painted from nothing.
 *
 * **It clears first**, which is the whole reason it is a function rather than the loop it
 * used to be inside `load()`. Chats (M8-2) can change which conversation is open while this
 * view is off screen, and a repaint that appended would show the new one underneath the old
 * one — two conversations in one scroll, with no line between them.
 */
function paint(state: State): void {
  log.replaceChildren()
  // A repainted conversation knows which model answered and nothing about the rate limits of
  // an hour ago, so the state badge goes rather than lying about the present.
  wearing()
  let latest: HTMLElement | undefined
  /**
   * **Her turns that only ran tools**, folded into one quiet line before whatever comes next.
   * Each used to be drawn as her name over nothing — dozens of empty answers in a conversation
   * where she did a lot of work.
   */
  let tools = 0
  const toolsSoFar = (): void => {
    if (tools === 0) return
    const line = document.createElement('p')
    line.className = 'tools-used'
    line.textContent = usedTools(tools)
    log.append(line)
    tools = 0
  }
  for (const turn of state.messages) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const shown = shownTurn(turn)
    if (turn.role === 'assistant' && shown.text.trim() === '' && !shown.stopped) {
      tools += shown.tools
      continue
    }
    toolsSoFar()
    const drawn = bubble(turn.role, shown.text)
    // What came with the question, as the live turn showed it: the names, not the contents.
    if (shown.attached.length > 0) drawn.append(carriedLine(shown.attached.map((one) => one.name)))
    if (shown.stopped) drawn.append(stoppedMark())
    // The switch lines that were said when this answer was written, above its words (§4 G).
    if (turn.notes !== undefined && turn.notes.length > 0) drawn.prepend(...turn.notes.map(switchLine))
    if (turn.bad === true) markBad(drawn)
    if (turn.model) modelBadge.textContent = turn.model
    if (turn.role === 'assistant' && shown.text.trim() !== '') actionsRow(drawn)
    latest = turn.role === 'assistant' && turn.bad !== true && shown.text.trim() !== '' ? drawn : undefined
    // Her words came before the tools this same turn asked for.
    tools += shown.tools
  }
  toolsSoFar()
  // The latest answer, when the conversation ends on one, carries the row of actions (§4 I).
  if (latest !== undefined) answerActions(latest, state.notHer === true)
  toBottom()
  /**
   * **Who is answering** (improvement 8). Hidden when nothing is chosen, because Alexia's own
   * voice is not a personality and a chip saying *none* would be a control that is always on
   * screen saying nothing.
   */
  characterFrom(state)
  // The figure, the word over it and the lines under it: the day when there is an allowance,
  // otherwise the month. `priceText` says why, once for here and for the end of an answer.
  const day = state.today
  standingPaid =
    state.cross === true && day !== undefined && day.allowance > 0 ?
      `Paid models will be used once the free ones are done, up to ${money(day.allowance)} today.`
    : ''
  warnPaid()
  drawPrice(page('price'), state)
}

/**
 * **Core did not answer at all** — not an answer that went wrong, a request that never landed or
 * a stream that broke off. Said in one plain sentence rather than as *TypeError: Failed to
 * fetch*. `unsent` is a request core never took, so the message is still the person's to send.
 */
class Unreachable extends Error {
  constructor(readonly unsent: boolean) {
    super('Alexia isn’t answering right now — try again in a moment.')
  }
}

/**
 * **Core took the request and said no, because another answer is still being written** in this
 * conversation — from another window, or from a phone. Nothing was said to anybody, so like an
 * unsent request the message goes back into the box. `said` is core's own sentence.
 */
class Busy extends Error {
  readonly unsent = true
}

/**
 * The first read, tried until it lands. A window that opens a moment before core can answer, or
 * while the shell is starting it again, used to stop here for good: the page looked ready and
 * nothing on it worked. Said above the message box, with a way to try at once.
 */
async function reach(): Promise<State> {
  for (let tries = 0; ; tries++) {
    try {
      return await read()
    } catch {
      const now = document.createElement('button')
      now.type = 'button'
      now.textContent = 'Try again'
      note.replaceChildren(tries < 3 ? 'Alexia is starting… ' : 'Can’t reach Alexia yet — still trying. ', now)
      note.hidden = false
      await new Promise<void>((done) => {
        const timer = setTimeout(done, Math.min(1000 * 2 ** tries, 10_000))
        now.addEventListener('click', () => {
          clearTimeout(timer)
          done()
        })
      })
    }
  }
}

async function load(): Promise<void> {
  const state = await reach()
  board.adopt(state.layout)
  board.reach(state.channels)
  called(state.setup.name)
  known = state.commands
  await modeFeedback.sync(state)
  setupSettings(state)
  // The About page's two facts, from the same read: the version and whether to look for a
  // newer one. Both are core's answer rather than the page's, so the window and a tab pointed
  // at the same core cannot disagree about them.
  settings.about({ app: state.app, updates: state.setup.updates })
  settings.compute(state.compute)
  if (!state.setup.done) firstRun(state)
  paint(state)
  showPermissions(state.permissions)
  showLimits(state.ceilings)
  say(state.warning)
  // Last, and never awaited: an update offer must not be able to hold up a window. `load`
  // runs once, at boot, which is the only moment restarting to take an update costs nothing.
  void offerUpdate(state.setup.updates !== false)
}

/**
 * What each permission mode means, in a sentence (Alexia.md, *What Alexia may do*). The labels
 * come from core; these only explain them, and a mode core adds later is shown without one.
 */
const MODE_MEANS: Record<string, string> = {
  'every-time': 'Every action waits for your yes.',
  risky: 'Reading and searching run freely. Anything that changes, sends or spends waits for your yes.',
  watch: 'Actions run, each one is checked, and only the ones that look wrong stop and ask.',
  'full-trust': 'Nothing asks first. Not recommended — the never-touch list still applies, but nothing else stops a mistake.',
}

/**
 * The permission control, filled from core's own labels rather than a copy of them here —
 * two lists of four modes that have to agree is one list too many. It is on the rail and on
 * Settings > Safety; both write `/api/permissions` and both are set from its answer, so neither
 * can show a mode the other has changed. Full trust says *not recommended* on the option
 * itself, where the choice is made (Alexia.md).
 */
/** The chosen permission on every control that shows it. */
function showPermission(mode: string): void {
  for (const picker of permissions) picker.value = mode
  railPermission.value = mode
}
let railPermissionFilled = false

function showPermissions(state: Permissions): void {
  const said = document.querySelector<HTMLElement>('#permission-said')
  const explain = (mode: string): void => {
    if (said) said.textContent = MODE_MEANS[mode] ?? ''
  }
  const choose = (chosen: string): void => {
    showPermission(chosen)
    explain(chosen)
    void fetch('/api/permissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify({ mode: chosen }),
    })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(String(answer.status))
        const now = (await answer.json()) as { mode: string }
        showPermission(now.mode)
        explain(now.mode)
      })
      .catch(() => {
        if (said) said.textContent = 'That did not save. Alexia may not be running — try again in a moment.'
      })
  }
  for (const picker of permissions) {
    if (picker.options.length > 0) continue
    for (const [value, label] of Object.entries(state.modes)) {
      picker.add(new Option(value === 'full-trust' ? `${label} (not recommended)` : label, value))
    }
    picker.addEventListener('change', () => choose(picker.value))
  }
  // The rail's slider, filled from the same labels once. Its Full trust has been pressed and
  // held by the time `change` fires (switchers.ts); the select says *not recommended* instead.
  if (!railPermissionFilled) {
    railPermissionFilled = true
    railPermission.levels(Object.entries(state.modes).map(([value, name]) => ({ value, name, means: MODE_MEANS[value] ?? '' })))
    railPermission.addEventListener('change', () => choose(railPermission.value))
  }
  showPermission(state.mode)
  explain(state.mode)

  // A standing boundary is the user's own sentence holding things back. It stays on screen
  // while it applies, because a rule you cannot see is a rule you cannot find the end of.
  // Kept as the note line's standing sentence, so clearing the line for a new message puts it back.
  const boundary = state.boundaries[0]
  standingNote = boundary ? `Holding: “${boundary.said}”. Say so and I will lift it.` : ''
  if (boundary) say()
}

/** What `/api/ceilings` answers with: the two limits on a task, and the monthly budget if one is set. */
interface Limits {
  steps: number
  askAbove: number
  monthly?: number
  /** *No limit today* is on until this moment (D206), from a limit pause. */
  liftedUntil?: number
}

/**
 * The two limits on one task, and the monthly budget, on Settings > Safety (D205): the most steps, and the estimated
 * cost above which she asks first. Both were settable through `/api/ceilings` with no screen.
 * Saved on `change`, and the box shows what core kept — a refused value goes back.
 */
function showLimits(limits: State['ceilings']): void {
  const steps = document.querySelector<HTMLInputElement>('#steps-setting')
  const above = document.querySelector<HTMLInputElement>('#ask-above-setting')
  const monthly = document.querySelector<HTMLInputElement>('#monthly-setting')
  const said = document.querySelector<HTMLElement>('#limits-said')
  if (!steps || !above || !monthly || !said || limits === undefined) return
  const lifted = document.querySelector<HTMLElement>('#lifted-said')
  const fill = (now: Limits): void => {
    steps.value = String(now.steps)
    above.value = String(now.askAbove)
    monthly.value = now.monthly === undefined ? '' : String(now.monthly)
    // *Budget lifted for today*, while it is (D206) — with *Undo*, since it was one press away.
    if (lifted) lifted.hidden = now.liftedUntil === undefined || now.liftedUntil <= Date.now()
  }
  fill(limits)
  if (steps.dataset.wired === 'true') return
  steps.dataset.wired = 'true'
  const save = (body: { steps?: number; askAbove?: number; monthly?: number | null; lift?: false }): void => {
    void fetch('/api/ceilings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(body),
    })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(String(answer.status))
        fill((await answer.json()) as Limits)
        said.textContent = 'Saved.'
      })
      .catch(() => (said.textContent = 'That did not save. Alexia may not be running — try again in a moment.'))
  }
  document.querySelector('#lifted-undo')?.addEventListener('click', () => save({ lift: false }))
  steps.addEventListener('change', () => {
    const n = Math.floor(Number(steps.value))
    if (!Number.isFinite(n) || n < 1) {
      said.textContent = 'The most steps has to be 1 or more.'
      return
    }
    save({ steps: n })
  })
  // Text boxes, not number inputs: WebKit drew those in the Mac's locale, so in Czech the
  // limit read *0,02* beside a *$*. A comma typed out of habit is still read as the point.
  above.addEventListener('change', () => {
    const n = dollarsOf(above.value, true)
    if (n === undefined) {
      said.textContent = 'Type an amount in dollars, 0 or more, like 0.50.'
      return
    }
    save({ askAbove: n })
  })
  // Empty is *no budget*, which core is told as `null`: a box somebody cleared means the
  // budget is gone, not that nothing was said.
  monthly.addEventListener('change', () => {
    if (monthly.value.trim() === '') {
      save({ monthly: null })
      return
    }
    const n = dollarsOf(monthly.value, true)
    if (n === undefined) {
      said.textContent = 'Type an amount in dollars, like 20, or leave it empty for no budget.'
      return
    }
    save({ monthly: n === 0 ? null : n })
  })
}

/** The loop's own question, answered down the channel it is blocked on. */
const settle = (allowed: boolean): void =>
  void fetch('/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': token },
    body: JSON.stringify({ allowed }),
  })

/**
 * The permission prompt. One question at a time, and the answer goes straight back.
 *
 * `settled` is a parameter because a slash command asks the same question from a different
 * place: it has no stream to be blocked on, so its yes goes back as a second request rather
 * than to `/api/approve`. One prompt, two ways of answering it — a second set of Allow and
 * Deny buttons somewhere else would be the same question wearing a different face.
 */
function askPermission(why: string, settled: (allowed: boolean) => void = settle): void {
  promptWhy.textContent = why
  prompt.hidden = false
  // A task that stops to ask while the window is closed is the case the tray exists for:
  // *needs you* is the one state somebody has to notice without looking for it.
  tray('attention')
  answerPrompt(prompt, settled, () => tray('working'))
}

/**
 * The `data:` frames of a stream, as they arrive. The same shape core's provider client
 * parses on the other side — duplicated rather than shared, because this file cannot import
 * anything that has ever seen a Node builtin.
 */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    // A stream that breaks off is core gone mid-answer, and the words so far stay on screen.
    const { done, value } = await reader.read().catch(() => {
      throw new Unreachable(false)
    })
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line.startsWith('data:')) yield JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      cut = buffer.indexOf('\n')
    }
  }
}

/**
 * The trace, which no longer lives here.
 *
 * It used to be a panel in the log: one row per step, between two of her sentences. That was
 * right when the log was the only surface there was, and wrong the moment there was a panel
 * whose whole job is what she is doing — a wall of tool names in the middle of a conversation
 * is the thing people said made this screen hard to read.
 *
 * So the conversation keeps one line — the names, and a way through — and `live.ts` has the
 * rest: the arguments, the plugin, what it holds and why, and what came back.
 */
const live = withEdge(mountLive(token, { running: page('running'), steps: page('steps'), current: page('current-step') }))

/**
 * The one line the conversation keeps about a run of tool calls.
 *
 * It is a control, not a caption: pressing it is how somebody gets from *she used something*
 * to *here is exactly what she sent and exactly what it said*.
 */
function toolLine(): { saw(name: string): void } {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'tools'
  const names = document.createElement('span')
  names.className = 'names'
  const go = document.createElement('span')
  go.className = 'go'
  go.textContent = 'on the right'
  chip.append(names, go)
  chip.addEventListener('click', () => chip.scrollIntoView({ block: 'nearest' }))
  const seen: string[] = []
  return {
    saw(name) {
      // A tool with no plugin prefix — core's own `skill` — is its whole name, not `kill`.
      const short = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name
      if (!seen.includes(short)) seen.push(short)
      names.textContent = seen.join(', ')
      if (!chip.isConnected) log.append(chip)
      follow()
    },
  }
}

// ---- first run: what it can do (D118) -------------------------------------------------------

/**
 * One plugin on the shelf, as first run needs it. `/api/library` says more; this is the part.
 *
 * A *Coming soon* row (D204) is only an id, a name and a sentence, so the version and the
 * `requires` are optional: reading `.length` off one that was not there threw, and the catch
 * below then told everybody the shelf could not be reached.
 */
interface Shelved {
  id: string
  name: string
  summary: string
  version?: string
  installed: boolean
  requires?: { cap: string; why: string }[]
  coming_soon?: boolean
}

/**
 * The step that exists because nothing ships inside the installer any more (D118).
 *
 * Alexia arrives able to hold a conversation and do nothing else, and every capability is a
 * download. That is the right trade — *install only what you need*, and a plugin author who
 * does not wait for an Alexia release — but it has one cost, and it lands exactly here: a
 * person who is never shown the shelf never finds out that the thing reads documents.
 *
 * So the shelf is a step of first run rather than a screen somebody might visit. What is on
 * it is what **this build can run**: `/api/library` has already dropped anything needing a
 * newer Alexia, so nothing here can be checked and then fail to install.
 *
 * **The tick is the consent.** Each row carries the author's own `requires` sentences, which
 * is the same thing the Plugins page shows before an install and the same rule as everywhere
 * else in this project: the question is asked where the thing being decided is. Nothing is
 * ticked by default — an installer that pre-selects is an installer choosing for you.
 *
 * A shelf that cannot be reached is one grey line, and Start still works. Somebody on a
 * captive portal gets an assistant, not a wall.
 */
function shelfStep(): { install: () => Promise<void> } {
  const group = document.querySelector<HTMLElement>('#choose')!
  const hint = document.querySelector<HTMLElement>('#choose-hint')!
  const list = document.querySelector<HTMLElement>('#shelf')!
  // Under the list it is about, rather than in the line under the Start button: what is being
  // downloaded belongs beside the ticks that asked for it.
  const said = document.querySelector<HTMLElement>('#choose-said')!
  const boxes: HTMLInputElement[] = []

  void fetch('/api/library', { headers: { 'x-alexia-token': token } })
    .then(async (answer) => answer.json() as Promise<{ ok?: boolean; why?: string; plugins?: Shelved[] }>)
    // Only a request that failed is *could not be reached*. The catch at the end is for a list
    // that arrived and could not be drawn, and it must not blame the network for that.
    .catch(() => ({ ok: false, why: 'The plugin list could not be reached.' }) as { ok?: boolean; why?: string; plugins?: Shelved[] })
    .then((read) => {
      group.hidden = false
      // Nothing here may be ticked and then refuse to install, so a *Coming soon* row is left
      // out. Settings still lists it, greyed, for anybody who goes looking.
      const shown = (read.plugins ?? []).filter((entry) => !entry.installed && entry.coming_soon !== true)
      if (read.ok !== true || shown.length === 0) {
        hint.textContent =
          read.ok !== true ?
            `${read.why ?? 'The plugin list could not be reached.'} You can install plugins later from Settings.`
          : 'Nothing new to add right now. Settings has the full list whenever you want it.'
        return
      }
      hint.textContent =
        'Alexia can hold a conversation on her own. Everything else is a plugin, and these download when you tick them. You can add or remove any of them later.'
      for (const entry of shown) {
        const row = el('label', 'card')
        const head = el('span', 'card-head')
        const box = el('input') as HTMLInputElement
        box.type = 'checkbox'
        box.value = entry.id
        boxes.push(box)
        head.append(box, el('b', undefined, entry.name))
        if (entry.version) head.append(el('em', undefined, entry.version))
        row.append(head, el('span', undefined, entry.summary))
        // What it will ask for, in its author's words, beside the tick that agrees to it.
        const requires = entry.requires ?? []
        if (requires.length > 0) {
          const asks = el('ul', 'asks')
          for (const need of requires) asks.append(el('li', undefined, need.why))
          row.append(asks)
        }
        list.append(row)
      }
    })
    .catch(() => {
      group.hidden = false
      hint.textContent = 'The plugin list could not be shown here. You can install plugins later from Settings.'
    })

  return {
    /**
     * Install what was ticked, one at a time, saying which one is happening.
     *
     * Sequential rather than parallel: each of these unpacks an archive into the folder core
     * watches, and four at once is four loaders racing on one directory for no gain a person
     * could see. A failure is reported and the rest still go — one plugin that would not
     * download is not a reason to hand somebody none of the four they asked for.
     */
    install: async (): Promise<void> => {
      const wanted = boxes.filter((box) => box.checked).map((box) => box.value)
      const failed: string[] = []
      for (const [at, id] of wanted.entries()) {
        said.textContent = `Installing ${id} (${String(at + 1)} of ${String(wanted.length)})…`
        const done = (await post('/api/library/install', { id, enable: true }).catch(() => ({ ok: false }))) as {
          ok?: boolean
        }
        if (done.ok !== true) failed.push(id)
      }
      said.textContent = failed.length > 0 ? `${failed.join(', ')} did not install. Settings can try again.` : ''
    },
  }
}

// ---- a newer Alexia (D119) -----------------------------------------------------------------

/**
 * Offer the update, and then get out of the way.
 *
 * **One check, at startup, and never again while the window is open.** Alexia is a daemon
 * that stays up for weeks, so the tempting thing is an hourly poll — and the thing that
 * would actually reach a person is a strip appearing over their conversation at four in the
 * afternoon because a release happened. The check is at the moment somebody has just
 * launched the program, which is the one moment restarting it costs nothing.
 *
 * Nothing is shown when there is no update, when the check fails, or in a browser. Failure
 * is silent by design: nobody asked for this check, so nobody is owed a report of it going
 * wrong — {@link updateAvailable} says why.
 */
async function offerUpdate(automatic: boolean): Promise<void> {
  // Somebody who has turned this off has said they want to stay where they are, and a strip
  // appearing anyway would be the setting doing nothing. Settings, then About, still has a
  // *Check now* that asks this second — turning the looking off is not turning it away.
  if (!automatic) return
  const found = await updateAvailable()
  if (!found) return

  const bar = document.querySelector<HTMLElement>('#update-bar')!
  const said = document.querySelector<HTMLElement>('#update-said')!
  const now = document.querySelector<HTMLButtonElement>('#update-now')!
  const manual = document.querySelector<HTMLAnchorElement>('#update-manual')!

  said.textContent = `Alexia ${found.version} is out. This is ${found.currentVersion}.`
  bar.hidden = false

  now.addEventListener('click', () => {
    now.disabled = true
    said.textContent = `Downloading Alexia ${found.version}…`
    void installUpdate(found.rid, (done, total) => {
      // A percentage where the server said how big it is, bytes where it did not. Neither
      // is a spinner: this replaces the program somebody is looking at, and *how far along*
      // is the question they will actually have.
      said.textContent =
        total !== undefined && total > 0 ?
          `Downloading Alexia ${found.version}… ${String(Math.round((done / total) * 100))}%`
        : `Downloading Alexia ${found.version}… ${String(Math.round(done / 1e6))} MB`
    })
      // There is no success branch. `installUpdate` launches the installer and the plugin
      // exits this process, so the window is gone before a `.then` could run — see its own
      // comment. What lands here is a download that failed or an installer that would not
      // start, and both leave a program that is still working and a person owed a sentence.
      .catch((error: unknown) => {
        said.className = 'error'
        said.textContent = `The update did not go through: ${error instanceof Error ? error.message : String(error)}`
        now.disabled = false
        now.textContent = 'Try again'
        manual.hidden = false
      })
  })
}

/** POST to core with the token, and give back whatever it said. */
const post = async (path: string, body: unknown, options?: Parameters<LocalRequest>[2]): Promise<Record<string, unknown>> => {
  const answer = await fetch(path, {
    method: options?.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': token },
    ...(options?.method !== 'GET' && body !== undefined && { body: JSON.stringify(body) }),
    ...(options?.signal && { signal: options.signal }),
  })
  // A 500 comes back as `text/plain`, so this used to reject inside `.json()` with a parse
  // error nobody was catching — a save that failed looked exactly like a save that did
  // nothing. Whatever core said about it is the sentence the screen can show: a refusal
  // puts it in `said`, a crash has only the plain text.
  if (!answer.ok) {
    const body = (await answer.text()).trim()
    const said = ((): string => {
      try {
        return String((JSON.parse(body) as { said?: unknown }).said ?? body)
      } catch {
        return body
      }
    })()
    throw new Error(said || `${path} failed (${answer.status})`)
  }
  return (await answer.json()) as Record<string, unknown>
}

/**
 * *Using what I learned last time about…* (M4-5).
 *
 * In the conversation, at the moment the skill fires, because that is the only moment when
 * a person can tell whether it was right. **Edit and forget are right there** — a learned
 * skill that turns out to be wrong is found out here, and a settings list nobody opens is
 * not somewhere you find that out in time.
 */
function attribute(name: string): void {
  const row = document.createElement('div')
  row.className = 'learned'
  const line = document.createElement('span')
  line.textContent = `Using what I learned last time about ${name}.`
  row.append(line)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'quiet-button'
  edit.textContent = 'Edit'
  edit.addEventListener('click', () => void editSkill(name, row))

  // Two presses, the same as deleting a plugin, and for the same reason: the skill came out
  // of a task that has long since scrolled away, so nothing here regenerates it. The second
  // press is what carries the `confirm` core refuses this without (M6-1).
  const drop = document.createElement('button')
  drop.type = 'button'
  drop.className = 'quiet-button'
  drop.textContent = 'Forget it'
  let armed = false
  drop.addEventListener('click', () => {
    if (!armed) {
      armed = true
      drop.textContent = 'Forget it for good'
      line.textContent = `Forgetting ${name} deletes it. It was learned from a task that has gone, so it does not come back.`
      return
    }
    void post('/api/learn', { action: 'forget', name, confirm: true }).then((answer) => {
      row.textContent = String(answer.said ?? 'Forgotten.')
    })
  })

  row.append(edit, drop)
  log.append(row)
  follow()
}

/** The skill's own text, editable in place. It is one Markdown file and it reads like one. */
async function editSkill(name: string, row: HTMLElement): Promise<void> {
  const answer = await post('/api/learn', { action: 'edit', name })
  if (typeof answer.text !== 'string') {
    row.textContent = String(answer.said ?? 'That is not editable.')
    return
  }
  const box = document.createElement('div')
  box.className = 'confirm'
  const area = document.createElement('textarea')
  area.rows = 12
  area.value = answer.text
  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = 'Save'
  save.addEventListener('click', () => {
    void post('/api/learn', { action: 'edit', name, text: area.value }).then(() => box.remove())
  })
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'quiet-button'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => box.remove())
  const buttons = document.createElement('div')
  buttons.className = 'row'
  buttons.append(save, cancel)
  box.append(area, buttons)
  row.append(box)
  follow()
}

/**
 * *Want me to remember how to do this?* (M4-5.)
 *
 * Offered, never assumed. Nothing is written and no model is called until the button is
 * pressed — a feature that quietly distilled every task would quietly spend money on every
 * task, and the distillation runs on the strongest rung there is.
 */
function offerToLearn(offer: { about?: string; outline?: string }): void {
  const box = document.createElement('div')
  box.className = 'learn-offer'
  const line = document.createElement('p')
  line.textContent = `That took some working out — ${offer.outline ?? ''}. Want me to remember how to do it?`
  const said = document.createElement('p')
  said.className = 'hint'

  const yes = document.createElement('button')
  yes.type = 'button'
  yes.textContent = 'Remember this'
  yes.addEventListener('click', () => {
    yes.disabled = true
    said.textContent = 'Writing it down…'
    void post('/api/learn', {}).then((answer) => {
      said.className = answer.ok === true ? 'hint' : 'error'
      said.textContent = String(answer.said ?? '')
      no.remove()
    })
  })
  const no = document.createElement('button')
  no.type = 'button'
  no.className = 'quiet-button'
  no.textContent = 'No need'
  no.addEventListener('click', () => box.remove())

  const buttons = document.createElement('div')
  buttons.className = 'row'
  buttons.append(yes, no)
  box.append(line, buttons, said)
  log.append(box)
  follow()
}

async function ask(question: string, files: File[] = []): Promise<void> {
  const said = bubble('user', question)
  /** What each picture became on the way out, once it is known. See {@link smaller}. */
  const shrank = new Map<string, string>()
  let carried: HTMLElement | undefined
  // What the message carried, in the turn that carried it: the names now, and what was read
  // out of them the moment core says — folded away under this same turn.
  if (files.length > 0) {
    carried = carriedLine(files.map((file) => file.name))
    said.append(carried)
    /**
     * **A picture, shown in the turn that sent it.**
     *
     * The same argument `showRead` makes about extracted text, and it lands harder here: an
     * image now goes to the model *as an image*, so what was sent is a thing the person can
     * only check by looking at it. A filename is not that check — `dark.png` says nothing
     * about what is in `dark.png`, and `redact.ts` cannot read a picture, so this is the only
     * place the contents are ever in front of the person who sent them.
     *
     * Drawn from the local `File` rather than from anything core sends back. The bytes are
     * already in this page — the user chose them a moment ago — so asking for them again
     * would be a second copy of a photograph over a socket to save nothing.
     */
    for (const file of files.filter((one) => one.type.startsWith('image/'))) {
      const shown = document.createElement('img')
      shown.className = 'made-preview'
      shown.alt = file.name
      shown.src = URL.createObjectURL(file)
      // Freed once it has been decoded. The element keeps the pixels; the blob URL is only
      // the way in, and a page that never revokes one leaks every picture it ever showed.
      shown.addEventListener('load', () => URL.revokeObjectURL(shown.src), { once: true })
      said.append(shown)
    }
  }
  await respond(files.length > 0 ? 'reading' : 'choosing', said, async () => {
    /**
     * Made small enough to send, before anything is sent.
     *
     * Hoisted out of the request body on purpose: the user's own bubble is already on screen by
     * now, so re-encoding a photograph does not delay the message appearing — it delays only
     * the send, which was going to be the slow part anyway and is now a great deal less slow.
     */
    const uploads =
      files.length === 0 ? []
      : await Promise.all(
          files.map(async (file) => {
            const { blob, type, was } = await smaller(file)
            // Re-encoding somebody's picture is a real change to what was sent, and a change
            // nobody is told about is the thing this codebase refuses everywhere else.
            if (was !== undefined) shrank.set(file.name, `${readable(was)} → ${readable(blob.size)}`)
            return { name: file.name, type, data: await base64(blob) }
          }),
        )
    if (carried && shrank.size > 0) {
      carried.textContent = `📎 ${files
        .map((file) => `${file.name}${shrank.has(file.name) ? ` (${shrank.get(file.name)!})` : ''}`)
        .join(', ')}`
    }
    return { text: question, ...(uploads.length > 0 && { files: uploads }) }
  }).catch((error: unknown) => {
    // Core never took it, so it was never said: the bubble goes, and the words and files go back
    // in the box to be sent again — unless something new has been typed there since.
    if ((error instanceof Unreachable || error instanceof Busy) && error.unsent) {
      said.remove()
      if (text.value === '') {
        text.value = question
        grow(text)
      }
      if (carrying.length === 0) {
        carrying = files
        drawAttached()
      }
    }
    throw error
  })
}

/**
 * **The question that stopped, asked once more** (D155): on Automatic, or on the same model.
 *
 * Nothing new appears on the user's side, because nothing new was said — core asks the
 * question already in the conversation, from wherever the task stopped.
 */
function again(automatic: boolean, more: { allow?: { daily?: number }; free?: true } = {}): Promise<void> {
  return respond('choosing', undefined, () => Promise.resolve({ again: true, ...(automatic && { automatic }), ...more }))
}

/**
 * **A pause** (§4 H): the free models are done, a paid one would answer, and the paid switch is
 * off. Core's sentence says why, and one press of *Allow switching to a paid model* covers this
 * conversation and carries on from where it stopped. At $0 a day the press alone would buy
 * nothing, so the box for the amount comes with it, starting at $1.
 */
function offerPaid(paused: HTMLElement, daily: number): void {
  const buttons = document.createElement('div')
  buttons.className = 'stop-offer'
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.textContent = 'Allow switching to a paid model'
  let amount: HTMLInputElement | undefined
  if (daily <= 0) {
    const box = document.createElement('label')
    box.className = 'pause-amount'
    amount = document.createElement('input')
    amount.type = 'number'
    amount.min = '0.5'
    amount.step = '0.5'
    amount.value = '1.00'
    box.append('up to $', amount, ' a day')
    buttons.append(box)
  }
  allow.addEventListener('click', () => {
    if (!idle()) return
    const typed = amount === undefined ? undefined : Number(amount.value)
    if (typed !== undefined && !(typed > 0)) {
      say('Say how much a day paid models may spend — a number above $0.')
      return
    }
    buttons.remove()
    running(() => again(false, { allow: typed === undefined ? {} : { daily: typed } }))
  })
  buttons.append(allow)
  paused.append(buttons)
  follow()
}

/** A spending limit reached (D206), as core offers it: which one, its amount, and where *Raise* starts. */
interface Limit {
  kind: 'monthly' | 'daily'
  amount: number
  raise: number
}

/**
 * **A spending limit, reached** (D206): she stopped before spending more, and core's one sentence
 * says which limit. Three ways on, each carrying on from where it stopped: *Raise the limit* to
 * the amount in the box, saved as Settings saves it; *No limit today*, which lifts both limits
 * until midnight and changes neither; and *Use free models*, for this chat only.
 */
function offerLimit(paused: HTMLElement, limit: Limit): void {
  const buttons = document.createElement('div')
  buttons.className = 'stop-offer'
  const box = document.createElement('label')
  box.className = 'pause-amount'
  // A text box, as on Settings > Safety: WebKit drew number inputs in the Mac's locale.
  const amount = document.createElement('input')
  amount.type = 'text'
  amount.inputMode = 'decimal'
  amount.value = limit.raise.toFixed(2)
  box.append('$', amount, limit.kind === 'monthly' ? ' a month' : ' a day')
  const choice = (label: string): HTMLButtonElement => {
    const one = document.createElement('button')
    one.type = 'button'
    one.textContent = label
    return one
  }
  const raise = choice('Raise the limit')
  const lift = choice('No limit today')
  const free = choice('Use free models')
  /** Saved first, then carried on — a limit that did not save would only pause again. */
  const saveThen = (body: Record<string, unknown>): void => {
    if (!idle()) return
    void fetch('/api/ceilings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(body),
    })
      .then((answer) => {
        if (!answer.ok) throw new Error(String(answer.status))
        buttons.remove()
        running(() => again(false, { allow: {} }))
      })
      .catch(() => say('That did not save. Alexia may not be running — try again in a moment.'))
  }
  raise.addEventListener('click', () => {
    const n = dollarsOf(amount.value)
    if (n === undefined || !(n > limit.amount)) {
      say(`Type an amount above $${limit.amount.toFixed(2)}.`)
      return
    }
    saveThen(limit.kind === 'monthly' ? { monthly: n } : { daily: n })
  })
  lift.addEventListener('click', () => saveThen({ lift: true }))
  free.addEventListener('click', () => {
    if (!idle()) return
    buttons.remove()
    running(() => again(false, { free: true }))
  })
  buttons.append(box, raise, lift, free)
  paused.append(buttons)
  follow()
}

/**
 * One answer, streamed into a bubble of its own: everything core says while it is made.
 *
 * `first` is what the line under the answer says before core has said anything (`status.ts`):
 * `reading` when the message carries files, because reading them is what happens first, and
 * `choosing` otherwise. `body` is a promise so the caller can do slow work — shrinking a
 * photograph — after the waiting bubble is already on screen. `said` is the question's own
 * bubble, when this answer has one to hang what was read out of the attachments under.
 */
async function respond(
  first: 'choosing' | 'reading',
  said: HTMLElement | undefined,
  body: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const tools = toolLine()
  live.begin(document.querySelector<HTMLElement>('#chat-title')?.textContent ?? 'This conversation')
  const answer = bubble('assistant')
  /**
   * Her words go in a text node of their own, not straight onto the bubble — because a file
   * a step made is appended to the same bubble by `showFiles`, and `answer.textContent = ''`
   * on the first token would take the picture with it. The node stays; only its data moves.
   */
  const prose = document.createTextNode('')
  answer.replaceChildren(prose)
  /**
   * **What is happening, under her words, until the answer is over** — in place of the `…`
   * that used to sit here saying nothing for as long as the wait lasted. Mounted before the
   * request goes out, so its clock counts from the moment the message was sent.
   */
  const status = mountStatus(answer, { first: { kind: first } })
  /**
   * Where the model turn now streaming began in `prose`. A task's turns share one bubble, so a
   * turn that is withdrawn (`restart`) takes back its own words and leaves the earlier ones.
   */
  let turnFrom = 0
  // A new question: a charge line from the last answer is not about this one (§4 G).
  warnPaid()
  // Busy while it streams, so a screen reader is not read every word as it lands; the
  // `#answered` line says once that she has finished instead.
  log.setAttribute('aria-busy', 'true')
  answered.textContent = ''
  let finished = false

  // `finally`, because the line has a clock: an answer that ends any way at all — finished,
  // stopped, refused, or a request that threw — must not leave a timer counting under nothing.
  try {
    const sent = JSON.stringify(await body())
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: sent,
    }).catch(() => {
      throw new Unreachable(true)
    })
    if (response.status === 423) {
      const back = (await response.json().catch(() => ({}))) as { said?: unknown }
      answer.remove()
      throw new Busy(typeof back.said === 'string' ? back.said : 'Alexia is still answering — wait for her or press Stop.')
    }
    if (response.status === 409) {
      // Asked again after the question had its answer: there is nothing left to answer.
      answer.remove()
      return
    }
    if (!response.body) {
      prose.data = 'Alexia is not answering.'
      return
    }

    for await (const event of frames(response.body)) {
      // What the walk is doing right now — choosing, asking, a busy model asked again.
      if (isPhase(event.phase)) status.set(event.phase)
      if (typeof event.delta === 'string') {
        prose.data += event.delta
        follow()
      }
      // The model writing this turn stopped partway and another is starting it again (D155).
      // Its half-sentence goes, so two models' words are never run together in one bubble. The
      // line under it stays, and says who is being asked next as soon as core does.
      if (event.restart === true) prose.data = prose.data.slice(0, turnFrom)
      // The monthly warning and core's other plain lines land in the same place.
      if (typeof event.note === 'string') say(event.note)
      // Another model is answering: said for three seconds, and kept above the words (§4 G).
      const switched = event.switch as { says?: string } | undefined
      if (switched !== undefined && typeof switched.says === 'string') {
        pop(switched.says)
        answer.insertBefore(switchLine(switched.says), prose)
      }
      // The charge line, in its own place, where no other line can replace it (§4 G).
      if (typeof event.paid === 'string') warnPaid(event.paid)
      const attached = event.attached as { name: string; text?: string; refusal?: string }[] | undefined
      if (attached && said) showRead(said, attached)
      if (typeof event.ask === 'string') askPermission(event.ask)
      // A learned skill just fired, and it can be wrong. Attribution goes where the work is
      // happening, with the two things you would want at that moment beside it (M4-5).
      if (typeof event.learned === 'string') attribute(event.learned)
      const offer = event.learn as { about?: string; outline?: string } | undefined
      if (offer) offerToLearn(offer)
      const step = event.step as
        | {
            n: number
            name: string
            ok?: boolean
            text?: string
            args?: Record<string, unknown>
            progress?: { progress: number; total?: number; message?: string; preview?: string; stages?: Stage[]; plan?: boolean; controls?: { key: string; label: string }[] }
            files?: { id: string; name: string; bytes: number; mime: string; path: string; openable: boolean }[]
            timing?: Timing
            card?: { title: string; fields: Record<string, string>; url?: string }
          }
        | undefined
      if (step) {
        // Whatever her next words are, they belong to the turn after this step.
        turnFrom = prose.data.length
        if (step.progress) {
          live.moving(step.n, step.progress)
        } else if (step.ok === undefined) {
          live.step(step.n, step.name, step.args)
          // The conversation says only that a tool was used, and which. The panel beside it
          // has the whole of it.
          tools.saw(step.name)
          // Her answer moves below the line it came after, so the log reads in the order it
          // happened rather than the order the elements were created.
          log.append(answer)
        } else {
          live.done(step.n, step.ok, step.text ?? '', step.timing)
          // An answer read off the screen, as a card under the reply (B5).
          if (step.card) showCard(answer, step.card)
          // A file the step made goes in the conversation rather than in the live panel: the
          // panel is a trace of what happened and closes, and this is a thing the person now
          // has. It lands under the answer the way an attachment lands under the question.
          if (step.files && step.files.length > 0) showFiles(answer, step.files)
        }
      }
      if (typeof event.error === 'string') {
        status.stop()
        live.end('failed', event.error)
        answer.remove()
        const stopped = bubble('refusal', event.error)
        if (event.chosen === 'pinned' || event.chosen === 'sequence') offerInstead(stopped, event.chosen)
      }
      // Paused rather than stopped: nothing was billed, and a press lets paid answer (§4 H).
      if (typeof event.paused === 'string') {
        status.stop()
        live.end('paused', event.paused)
        answer.remove()
        const stopped = bubble('refusal', event.paused)
        // A spending limit reached has its own three choices in place of *Allow* (D206).
        if (typeof event.limit === 'object' && event.limit !== null) offerLimit(stopped, event.limit as Limit)
        else offerPaid(stopped, typeof event.daily === 'number' ? event.daily : 0)
      }
      const done = event.done as
        | {
            model?: string
            bubble?: Bubble
            spent?: number
            cap?: number
            today?: { spent: number; allowance: number }
            warning?: string
            ended?: string
            steps?: number
          }
        | undefined
      if (done) {
        // Over, however it ended: the line goes before the buttons under the answer arrive.
        status.stop()
        if (done.model) modelBadge.textContent = done.model
        wearing(done.bubble)
        // The whole Price page again, from the month and the day core just sent, the way the
        // first read draws it. It used to patch the month's total into *$… of $1.00 today*,
        // which said the month was today. A core that sends no day is asked for the state.
        if (typeof done.spent === 'number' && done.today !== undefined) {
          drawPrice(page('price'), { spent: done.spent, cap: done.cap, today: done.today })
        } else if (typeof done.spent === 'number') {
          void read().then((now) => drawPrice(page('price'), now))
        }
        if (done.warning) say(done.warning)
        prompt.hidden = true
        // A task that hit a limit says which one. Silence after a stop looks like a crash.
        tray(done.ended === 'answered' || done.ended === undefined ? 'idle' : 'error')
        live.end(done.ended ?? 'answered')
        // A conversation is named by the first thing you said in it, so the rail's list and
        // the title above the log are both a turn out of date until this.
        void rail.refresh()
        /**
         * A finished answer can be marked bad (§4 I), and said not to have sounded like her
         * (improvement 10). Drawn from what was last read so the buttons are there the moment
         * the words stop, then read again — because the personality may have been switched on
         * the settings screen since, and the chip in the header is a turn out of date until
         * somebody does.
         */
        if (done.ended === 'answered') {
          finished = true
          const was = inCharacter.notHer
          answerActions(answer, was)
          void read().then((now) => {
            characterFrom(now)
            // Only redrawn when the answer changed, or every finished answer would rebuild its
            // own buttons a beat after drawing them, which reads as a flicker with no cause.
            if ((now.notHer === true) !== was) answerActions(answer, now.notHer === true)
          })
        }
        // Cut short by Stop: what she had written so far stays, marked as not the whole answer,
        // and it can still be copied — it just cannot be judged, since it was never finished.
        if (done.ended === 'stopped' && prose.data !== '') answer.append(stoppedMark())
        if (done.ended !== 'answered' && prose.data.trim() !== '') actionsRow(answer)
        if (done.ended === 'stopped') say('Stopped.')
        if (done.ended === 'ceiling') {
          say(
            `Stopped after ${String(done.steps ?? 0)} steps, the most one task may take. ` +
              'It is not finished. You can raise the limit in Settings > Safety.',
          )
        }
      }
    }
  } catch (error) {
    // An answer that ended by throwing never sent `done`, so Running now would say it still was.
    live.end()
    throw error
  } finally {
    status.stop()
    log.removeAttribute('aria-busy')
    if (finished) answered.textContent = `${document.querySelector('.name')?.textContent ?? 'Alexia'} answered.`
    // Whatever ended it — including a stream that closed without saying how — Running now clears.
    live.end()
    // Nothing was ever written into it: stopped before the first word, or a request that threw
    // and is said in a bubble of its own. The `…` used to stay behind in this case; an empty
    // turn under her name would read as a blank answer rather than one that never came.
    if (answer.isConnected && prose.data === '' && answer.childNodes.length === 1) answer.remove()
  }
}

/**
 * **A stop in somebody's own choice** (D155): one pinned model, or the end of their list. The
 * reason is core's sentence; what is offered under it is this one answer on Automatic — and,
 * for one model, the same model again. Neither changes a setting. The pin is theirs, and so is
 * the list, and a button that quietly rewrote them would be the router choosing for them again.
 */
function offerInstead(stopped: HTMLElement, chosen: 'pinned' | 'sequence'): void {
  const buttons = document.createElement('div')
  buttons.className = 'stop-offer'
  const offer = (label: string, automatic: boolean): HTMLButtonElement => {
    const one = document.createElement('button')
    one.type = 'button'
    one.textContent = label
    if (!automatic) one.className = 'quiet-button'
    one.addEventListener('click', () => {
      if (!idle()) return
      buttons.remove()
      running(() => again(automatic))
    })
    return one
  }
  buttons.append(offer('Use Automatic for this answer', true))
  if (chosen === 'pinned') buttons.append(offer('Try again', false))
  stopped.append(buttons)
  follow()
}

// ---- commands: the shortcut half -----------------------------------------------------

const menu = document.querySelector<HTMLElement>('#menu')!
/**
 * Every mode picker on the page — the rail's glass switch (switchers.ts) and the settings
 * screen's select.
 *
 * A list rather than two constants, because they are one setting shown twice and the day
 * somebody adds a third is the day two of them start disagreeing. Every one of them writes
 * through `/local`, `/combined`, `/cloud`, and core's answer sets all of them.
 */
const railMode: Switcher = mountModeSwitch(document.querySelector<HTMLElement>('#mode-switch')!, around)
/**
 * The sentence under Settings › *How should I run?*: what the chosen mode means. It is in the
 * list with the pickers, so every place that sets them sets it too; it never fires `change`.
 */
class ModeSaid extends EventTarget {
  #value = ''
  get value(): string {
    return this.#value
  }
  set value(value: string) {
    this.#value = value
    const said = document.querySelector<HTMLElement>('#mode-said')
    if (said) said.textContent = MODES.find((mode) => mode.value === value)?.means ?? ''
  }
}
const modes: (EventTarget & { value: string })[] = [
  ...document.querySelectorAll<HTMLSelectElement>('select.mode'),
  railMode,
  new ModeSaid(),
]
let known: Command[] = []
let modeChanging = false
const modeFeedback = mountModeTransition({
  hosts: [document.querySelector<HTMLElement>('#mode-switch')!, document.querySelector<HTMLElement>('#mode-said')!],
  read,
  mode: (value) => { for (const picker of modes) picker.value = value },
  blocked: (pending) => { modeChanging = pending; button.disabled = working || pending },
  refresh: async () => { await rail.refresh(); if (document.body.dataset.view === 'settings') settings.redrawModels() },
  picker: (message, alternative) => { show('settings'); settings.open('models'); settings.localMessage(message, alternative) },
  failed: (message) => bubble('refusal', message),
  hostName: (id) => compute?.hosts.find((view) => view.host.id === id)?.host.name,
})

/**
 * Run one, from the input or from a control. Both go the same way in.
 *
 * A plugin's command is a tool call under a short name, so it meets the same permission
 * ruling everything else does. When that ruling is *ask*, nothing has run: the question goes
 * to the same prompt the loop uses, and a yes sends the identical command back carrying it.
 */
async function command(input: string, approved?: boolean): Promise<void> {
  const ticket = /^\/(local|cloud|combined)(?:\s|$)/.test(input) ? modeFeedback.begin() : undefined
  try {
    const ran = (await (
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify({ input, ...(approved === true && { approved: true }) }),
      })
    ).json()) as { ok: boolean; note: string; ask?: string; moved?: boolean; setup: { mode: string }; modeTransition?: ModeTransition }
    // `/new` moved the conversation out from under this window, so what is on screen is the
    // last one's log. Repaint before saying anything, or the sentence lands under the turns
    // it just left behind.
    if (ran.moved === true) {
      await read().then(paint)
      void rail.refresh()
    }
    // A command that worked says so plainly; only one that did not wears the refusal's dashed box.
    bubble(ran.ok ? 'reply' : 'refusal', ran.note)
    if (ticket !== undefined) await modeFeedback.observe(ran, ticket)
    else await modeFeedback.sync(ran)
    if (ran.ask !== undefined) {
      askPermission(ran.ask, (allowed) => {
        if (allowed) void command(input, true)
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ticket !== undefined) modeFeedback.fail(message, ticket)
    else bubble('refusal', message)
  }
}

/** The rows the `/` menu is showing, and which one ↑ and ↓ have reached. */
let listed: Command[] = []
let menuAt = 0

/** Run a command picked from the menu — by a click, or by Enter on its row. */
function pick(chosen: Command): void {
  text.value = `/${chosen.name}`
  closeMenu()
  form.requestSubmit()
}

function closeMenu(): void {
  menu.hidden = true
  text.removeAttribute('aria-activedescendant')
}

function showMenu(): void {
  // Every command that fits what is typed, not the first eight: the list scrolls, and a
  // command that is never shown is a command nobody finds.
  const matches = slashMatches(known, text.value)
  if (matches.length === 0) {
    closeMenu()
    return
  }
  // The highlight stays on the same command while it is still listed, and starts at the top otherwise.
  const was = listed[menuAt]
  listed = matches
  menuAt = Math.max(0, was === undefined ? 0 : matches.indexOf(was))
  menu.replaceChildren(
    ...matches.map((c, at) => {
      const item = document.createElement('li')
      item.id = `menu-${String(at)}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(at === menuAt))
      if (c.shadowed) item.classList.add('shadowed')
      if (at === menuAt) item.classList.add('on')
      const name = document.createElement('b')
      // A shadowed command still works; it is just longer than its author hoped, and the
      // list says so rather than leaving somebody typing a word that does nothing.
      name.textContent = `/${c.name}`
      const summary = document.createElement('span')
      summary.textContent = c.shadowed ? `${c.summary} — the short name was taken` : c.summary
      item.append(name, summary)
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick(c)
      })
      return item
    }),
  )
  menu.hidden = false
  text.setAttribute('aria-activedescendant', `menu-${String(menuAt)}`)
  menu.children[menuAt]?.scrollIntoView({ block: 'nearest' })
}

/**
 * **The menu by keyboard**: ↑ and ↓ move, Enter or Tab runs the highlighted command, Escape
 * closes it (the window's Escape does that, see `escapeTakes`). Enter runs the highlighted
 * row only while the command word is still being typed — once there is a space, what was
 * typed is the command, arguments and all, and Enter sends that.
 */
function menuKey(event: KeyboardEvent): boolean {
  if (menu.hidden || listed.length === 0) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    menuAt = moveIn(listed.length, menuAt, event.key === 'ArrowDown')
    showMenu()
    return true
  }
  const choosing = !/\s/.test(text.value.trim())
  if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && !event.shiftKey && choosing)) {
    event.preventDefault()
    const chosen = listed[menuAt]
    if (chosen !== undefined) pick(chosen)
    return true
  }
  return false
}

// ⌥Esc while Alexia is using the computer is this button, pressed from anywhere.
onStopKey(() => {
  if (!stop.disabled) stop.click()
})

// Mid-step, always — including while a tool call is in flight. The button does not wait
// for the step to finish and then pretend it stopped it.
stop.addEventListener('click', () => {
  stop.disabled = true
  void fetch('/api/stop', { method: 'POST', headers: { 'x-alexia-token': token } }).finally(() => {
    stop.disabled = false
  })
})

// ---- the settings screen ---------------------------------------------------------------

const settings = mountSettings(token, () => {
  void read().then((state) => modeFeedback.sync(state)).catch(() => undefined)
}, () => railMode.value)
closeSettingsLocal = settings.close

// The obvious way to turn it off, which is the half of "starts on login" that matters. It
// reads the real answer rather than remembering what was chosen at first run: somebody may
// have changed it in Windows, and a switch showing the wrong state is worse than none.
if (inApp()) {
  const row = document.querySelector<HTMLElement>('#desktop-settings')!
  const box = document.querySelector<HTMLInputElement>('#autostart-setting')!
  row.hidden = false
  document.querySelector<HTMLElement>('#hotkey-setting')!.textContent = `Press ${HOTKEY} anywhere to talk to Alexia.`
  void autostart().then((on) => (box.checked = on === true))
  box.addEventListener('change', () => setAutostart(box.checked))
}

/**
 * Put the sheet away and go back to the board. Settings can install, enable, disable and
 * remove plugins, and each of those can add or take away a page, so the board re-reads; the
 * Chats tab under Activity can change which conversation is open, so that re-reads too.
 */
function closeSheet(): void {
  const was = document.body.dataset.view
  // Focus goes back to whatever opened the sheet, or the composer (show, modal.ts).
  show('chat')
  void board.refresh()
  // The Chats tab is behind Activity (M8-2), so which conversation is open may have changed
  // while it was on screen. Re-read rather than remember: the shell does not track the open
  // conversation, and core is one localhost call away.
  if (was === 'control') void read().then(paint)
}

document.querySelector('#close-settings')!.addEventListener('click', closeSheet)

// ---- the control surface (M6-2) ---------------------------------------------------------

const control = mountControl(token)

document.querySelector('#close-control')!.addEventListener('click', closeSheet)

text.addEventListener('input', () => {
  showMenu()
  grow(text)
})
for (const picker of modes) picker.addEventListener('change', () => void command(`/${picker.value}`))

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const question = text.value.trim()
  // A file with nothing typed beside it is a whole message — *here, read this* — so the line
  // is required only when it is the only thing there is.
  if (!question && carrying.length === 0) return
  // A new message: whatever the note line said about the last one is not about this one.
  say()
  if (question.startsWith('/')) {
    // A command is not a question for a model and never carries a document. Attachments stay
    // where they are, so `/new` typed with a file waiting does not quietly throw it away.
    text.value = ''
    grow(text)
    closeMenu()
    void command(question)
    return
  }
  // Enter submits the form whether or not the send button is held.
  if (!idle()) return
  const files = carrying
  carrying = []
  drawAttached()
  text.value = ''
  grow(text)
  closeMenu()
  running(() => ask(question, files))
})

/**
 * **One task at a time.** The send button is held while one runs, but a *Try again*, *Allow* or
 * *Bad answer* left on an older bubble was not — and a press there started a second run in the
 * same conversation, both appending to it, with Stop reaching only the newer. Every way to start
 * one asks this first, before it changes anything on screen.
 */
let working = false
function idle(): boolean {
  if (modeChanging) { say('Wait for the mode switch to finish before sending a message.'); return false }
  if (!working) return true
  say('One answer at a time — wait for this one, or press Stop.')
  return false
}

/** A task on screen: the send button held, the stop button shown, and the tray saying so. */
function running(task: () => Promise<void>): void {
  if (!idle()) return
  working = true
  button.disabled = true
  stop.hidden = false
  // The tray is the only answer to *is it running?* the target user has, so it says so for
  // the whole of a task rather than only while a window happens to be open (M5-2).
  tray('working')
  void task()
    .catch((error: unknown) => {
      bubble('refusal', error instanceof Unreachable || error instanceof Busy ? error.message : String(error))
      // Busy is somebody else's answer still running, which is not something going wrong.
      if (!(error instanceof Busy)) tray('error')
    })
    .finally(() => {
      working = false
      button.disabled = modeChanging
      stop.hidden = true
      prompt.hidden = true
      text.focus()
    })
}

// What is in the box outlives a reload, which the shell does to every window once it has had
// to start core again — the moment a message that could not be sent is waiting there to be.
addEventListener('pagehide', () => modeFeedback.close())
addEventListener('pagehide', () => sessionStorage.setItem('draft', text.value))
text.value ||= sessionStorage.getItem('draft') ?? ''
grow(text)

// Enter sends, Shift+Enter is a newline — the shape every chat window has, so nobody has
// to be told.
text.addEventListener('keydown', (event) => {
  if (menuKey(event)) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    form.requestSubmit()
  }
})

/**
 * The command palette (M6-10). Ctrl+K from anywhere, including the chat window — a palette
 * that only worked once you were already on the screen it navigates would be half a palette.
 *
 * It hands back what was picked: a place and the thing's own name to filter that place's list
 * by, or one chat to open. Going there is the whole of what it does. It never runs anything.
 */
const palette = mountPalette(token, (hit) => {
  // One conversation: opened the way the rail opens one, and the chat is what is on screen.
  if (hit.tab === 'chat' && hit.id !== undefined) {
    void post('/api/action', { key: 'open_chat', row: hit.id })
      .then(async () => {
        show('chat')
        await read().then(paint)
        await rail.refresh()
      })
      .catch(() => undefined)
    return
  }
  // The row's own name, or nothing for a page: what was typed into the palette is not what
  // the list calls it, and seeding it there left the list saying *Nothing here yet*.
  const filter = hit.filter ?? ''
  // Settings is what you choose and Activity is what happened (D205), so a hit on a plugin,
  // a skill, a model, a tool or a setting opens the Settings page it lives on, and only runs
  // and chats open Activity.
  if (isSettingsPage(hit.tab)) {
    show('settings')
    settings.open(hit.tab, filter)
    return
  }
  show('control')
  control.open(hit.tab, filter)
}, [
  // The shell's own entry (D204): the same edit view the bottom-left corner opens.
  {
    label: 'Edit layout',
    detail: 'Move, size, add and remove pages',
    words: ['edit', 'layout', 'board', 'pages', 'arrange', 'view'],
    run: () => {
      if (sheetOpen()) show('chat')
      board.edit(true)
    },
  },
])

// Escape puts the overlay away, and **puts it away without cancelling anything**: the task
// carries on and the tray goes on saying so. Stop is a separate control on purpose — a key
// that both dismisses and cancels is a key somebody presses once and regrets (M5-2).
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    palette.open()
    return
  }
  // Escape takes one step back, and only the last one is putting the window away: out of
  // edit view first, then off the sheet, then the overlay.
  if (event.key === 'Escape') {
    const small = smallOpen()
    const step = escapeTakes(small !== undefined, board.editing(), sheetOpen())
    if (step === 'open') small?.()
    else if (step === 'edit') board.edit(false)
    else if (step === 'sheet') closeSheet()
    else dismiss()
  }
})

/**
 * **The small thing Escape closes before anything bigger**, and how to close it: the model list
 * in the rail, then — while the chat is what is on screen — the `/` menu and the open *That
 * wasn't her* box. Escape used to go straight past all three and put the whole window away.
 */
function smallOpen(): (() => void) | undefined {
  if (rail.modelsOpen()) return () => rail.closeModels()
  if (sheetOpen()) return undefined
  if (!menu.hidden) return closeMenu
  if (closeNotHer !== undefined && log.querySelector('.not-her-line') !== null) return closeNotHer
  return undefined
}

/**
 * The rail (M8-2 and after). Mounted last, because it hands work to the two screens and the
 * palette, and a rail that could open a control surface that did not exist yet would be a
 * button that does nothing on the first press and works on the second.
 */
const rail = mountRail(document.querySelector<HTMLElement>('#rail')!, token, {
  heading: document.querySelector<HTMLElement>('#chat-title')!,
  alsoInto: document.querySelector<HTMLElement>('#chat-recent')!,
  refreshed: () => void board.refresh(),
  openPalette: () => palette.open(),
  openControl: (tab, filter) => {
    show('control')
    control.open(tab, filter)
  },
  openSettings: (page, filter) => {
    show('settings')
    settings.open(page, filter)
  },
  reload: () => read().then(paint),
  hosts: () => compute?.hosts ?? [],
})

await load()
await rail.refresh()

// Where it runs and what she may do can be changed from another window, the overlay, a slash
// command or Telegram, and this one read them once, at boot. Coming back to the window is the
// moment somebody looks at them, so that is when they are read again.
window.addEventListener('focus', () => {
  void read()
    .then((state) => {
      void modeFeedback.sync(state)
      showPermission(state.permissions.mode)
    })
    .catch(() => undefined)
})

// Apple's glass, when it is the one in use, kept over the rail's two switches as the page moves
// under them — and hidden while a sheet or the palette is over the rail.
keepPlaced([railMode, railPermission], document.querySelector<HTMLElement>('#rail')!)

/**
 * **The tools that act on the screen**: offered by a plugin that holds `input.control` and
 * declared as reaching outside Alexia. One that only looks, or only keeps a plan, is not.
 *
 * Read once a task and forgotten when it ends, so a plugin installed between two tasks counts.
 * A tool nobody could say anything about does not light the edge.
 */
let acting: Promise<Set<string>> | undefined
const acts = async (name: string): Promise<boolean> =>
  (
    await (acting ??= (async () => {
      const found = new Set<string>()
      try {
        const headers = { 'x-alexia-token': token }
        const [tools, plugins] = await Promise.all([
          fetch('/api/rows', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'tools' }),
          }).then((answer) => answer.json() as Promise<{ rows?: { id: string; plugin?: string; reaches?: boolean }[] }>),
          fetch('/api/plugins', { headers }).then(
            (answer) => answer.json() as Promise<{ panes?: { id: string; requires?: { cap: string }[] }[] }>,
          ),
        ])
        const controls = new Set(
          (plugins.panes ?? [])
            .filter((pane) => (pane.requires ?? []).some((need) => need.cap === 'input.control'))
            .map((pane) => pane.id),
        )
        for (const tool of tools.rows ?? []) {
          if (tool.reaches === true && tool.plugin !== undefined && controls.has(tool.plugin)) found.add(tool.id)
        }
      } catch {
        // No edge is better than an edge for the wrong step.
      }
      return found
    })())
  ).has(name)

/** Which task a step belongs to, so a lookup that lands after the task ended does not light the edge. */
let task = 0

/**
 * The live panel, with the edge of the screen tied to it: shown at a task's first computer step
 * that acts (not one that only looks), gone when the task ends, however it ends.
 */
function withEdge<
  T extends {
    step(n: number, name: string, args?: Record<string, unknown>): void
    moving(n: number, update: { stages?: Stage[]; plan?: boolean }): void
    end(how?: string, why?: string): void
  },
>(inner: T): T {
  return {
    ...inner,
    moving(n: number, update: { stages?: Stage[]; plan?: boolean }) {
      // The plan goes to the edge of the screen too, where the person is looking while the
      // pointer moves (B0). A pipeline's stages stay in the panel.
      if (update.plan === true && update.stages !== undefined) planOnEdge(update.stages)
      inner.moving(n, update as Parameters<T['moving']>[1])
    },
    step(n: number, name: string, args?: Record<string, unknown>) {
      // By what the plugin holds and what the tool declared, never by whose it is: a tool from a
      // plugin that may move the mouse and type, and that reaches outside Alexia, is acting.
      const of = task
      void acts(name).then((yes) => {
        if (yes && of === task) controlling(true)
      })
      inner.step(n, name, args)
    },
    end(how?: string, why?: string) {
      task += 1
      acting = undefined
      controlling(false)
      // The next task's edge starts empty rather than showing this one's plan.
      planOnEdge([])
      inner.end(how, why)
    },
  }
}
