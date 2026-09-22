// SPDX-License-Identifier: AGPL-3.0-only
import type { Manifest, Standing } from '@alexia/protocol'
import { report, verify, type Provider } from './provider.js'
import { MODES, type Pins } from './router.js'
import { CORE } from './secrets.js'
import type { Store } from './store.js'
import { allowance, dollars, today } from './usage.js'

/**
 * Slash commands: the shortcut, never the only route. Every one of these has a control in
 * the shell, because a command surface that is the only way to reach something is a
 * documentation requirement, and the person this is built for does not read documentation.
 *
 * Core's own commands are the three axes and nothing else. Everything else comes off a
 * manifest — so deleting a plugin's folder removes its commands, with no core file to edit
 * and nothing left pointing at something that is gone.
 */

export interface Command {
  /** What you type, without the slash. */
  name: string
  summary: string
  /** The namespaced form, which exists for every plugin command and always works. */
  alias?: string
  /** Which plugin it came from. Absent for core's own. */
  plugin?: string
  /**
   * The bare word was already taken, so `name` is the namespaced form. The shell shows
   * these in amber — the command still works, it is just longer than its author hoped.
   */
  shadowed?: boolean
}

/**
 * The three axes, as words. Reserved: a plugin cannot take one of these names, because
 * `/local` meaning something other than local — for anyone, ever — is the kind of surprise
 * this whole project is against.
 */
const BUILT_IN: Command[] = [
  /**
   * The one command that is not a setting.
   *
   * It is first because it is the one anybody needs from a place with no buttons: a phone
   * has no *New chat* to press, so without this every message anyone ever sends from one
   * lands in the same conversation, carrying every message before it (D109 gave that
   * conversation a home; this is how you leave it).
   */
  { name: 'new', summary: 'Start a new conversation. Nothing said before it comes with it.' },
  { name: 'help', summary: 'List everything you can type here.' },
  { name: 'local', summary: 'Run everything on this machine.' },
  { name: 'combined', summary: 'The cloud thinks; this machine makes images and speech.' },
  { name: 'cloud', summary: 'Run everything through APIs.' },
  { name: 'nsfw', summary: 'Allow uncensored models.' },
  { name: 'sfw', summary: 'Back to the standard content policy.' },
  { name: 'cheap', summary: 'Prefer the cheapest model that can do the job.' },
  { name: 'best', summary: 'Prefer the strongest model available.' },
  /**
   * The fourth kind of command: not an axis, and not a setting. A free tier that has moved
   * fails in a way that reads as Alexia being broken, so there has to be one thing to type
   * that says which half of that it actually is.
   */
  { name: 'providers', summary: 'Check every provider: which answer, and how old each check is.' },
  /**
   * The other question a place with no screen cannot answer by looking: **what is it set to,
   * what has it cost, and is it busy?** The window shows all of that without being asked — the
   * mode on its switch, the spend above the message box, a stop button while something runs —
   * and a phone shows none of it. Reports, never acts, like `/providers`.
   */
  { name: 'status', summary: 'Where things stand: the mode, the preference, what has been spent, and whether anything is running.' },
]

/**
 * Everything you could type right now. `manifests` is in install order — first installed
 * wins the bare word, and the namespaced form of every command always works, so resolving
 * a collision never breaks one that was already working.
 */
export function commands(manifests: readonly Manifest[] = []): Command[] {
  const taken = new Set(BUILT_IN.map((c) => c.name))
  const list = [...BUILT_IN]
  for (const manifest of manifests) {
    for (const { name, summary } of manifest.commands ?? []) {
      const alias = `${manifest.id}.${name}`
      const shadowed = taken.has(name)
      if (!shadowed) taken.add(name)
      list.push({ name: shadowed ? alias : name, alias, summary, plugin: manifest.id, ...(shadowed && { shadowed }) })
    }
  }
  return list
}

/** Only what the user pinned. The placement is derived from the mode, so it is not stored. */
const chosen = (store: Store): Omit<Pins, 'placement'> =>
  (store.kvGet(CORE, 'pins') as Omit<Pins, 'placement'> | undefined) ?? {}

/**
 * Change one pin and leave the rest alone.
 *
 * Exported because the Models tab sets the same `model` pin the router reads, and a second
 * writer with its own idea of the shape is how the two drift apart. One writer, two callers:
 * a slash command below, and a row action on the panel.
 */
export function setPin(store: Store, change: Omit<Pins, 'placement'>): void {
  store.kvSet(CORE, 'pins', { ...chosen(store), ...change })
}

/** Where the work runs, as the person last said it. Combined until they have said anything. */
const modeOf = (store: Store): keyof typeof MODES => (store.kvGet(CORE, 'mode') as keyof typeof MODES | undefined) ?? 'combined'

/** The pins as they stand, which is what every request is routed against. */
export function pins(store: Store): Pins {
  return { ...chosen(store), placement: MODES[modeOf(store)] }
}

/**
 * **Where things stand**, as facts and as the one line that says them (`/status`).
 *
 * Only the parts that exist: a month with no cap is money spent, not money spent *of* nothing,
 * and an allowance of zero — the default, and the reason paid models are never reached for on
 * their own — is not written as *$0.00 of $0.00*, which reads as a limit somebody hit. Whether
 * something is running is said only by a caller that can know; this file cannot.
 */
export function standing(store: Store, running?: () => boolean): { note: string; data: Standing } {
  const mode = modeOf(store)
  const prefer = chosen(store).prefer ?? 'cheap'
  const day = today(store)
  const { spent, cap } = allowance(store)
  const busy = running?.()
  const note = [
    `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
    prefer === 'best' ? 'strongest first' : 'cheapest first',
    day.allowance > 0 ? `${dollars(day.spent)} of ${dollars(day.allowance)} today` : `${dollars(day.spent)} today`,
    cap === undefined ? `${dollars(spent)} this month` : `${dollars(spent)} this month of ${dollars(cap)}`,
    ...(busy === undefined ? [] : [busy ? 'working on something' : 'nothing running']),
  ].join(' · ')
  return {
    note,
    data: {
      mode,
      prefer,
      today: { spent: day.spent, allowance: day.allowance },
      month: { spent, ...(cap !== undefined && { cap }) },
      running: busy === true,
    },
  }
}

export interface Ran {
  ok: boolean
  /** What to show. One line, in the words the person typing would use. */
  note: string
  /**
   * **The same answer as data**, for a surface that draws it itself — the structured twin of
   * `note`, never a replacement for it. `/help` hands over the list it wrote the lines from, so a
   * phone's own `/` menu is not built by parsing a paragraph; `/status` hands over the facts its
   * sentence was made of. Absent for a command that has nothing more than its sentence.
   */
  data?: unknown
}

/**
 * Run what was typed. `call` invokes a plugin's tool of the same name as the command —
 * which is the whole binding, and why a manifest declares a command with nothing but a name
 * and a sentence.
 *
 * Whatever follows that word is handed over whole, under `rest`, the same key for every
 * plugin command alike (D177). Core does not read it, split it or learn what it means, so a
 * command still declares nothing but a name and a sentence; the tool on the other end says in
 * its own schema whether it wanted an argument, and is the only thing that knows.
 */
export async function run(
  input: string,
  context: {
    store: Store
    manifests?: readonly Manifest[]
    call?(plugin: string, tool: string, args?: Record<string, unknown>): Promise<string>
    /**
     * Start a fresh conversation *here*.
     *
     * A hook rather than something this file does, because *here* is different for every
     * caller: the window rotates the conversation on screen, and a plugin rotates its own.
     * Neither knows about the other, and this file knows about neither.
     */
    newChat?(): Promise<Ran>
    /**
     * **Is a task running right now?** For `/status`, and a hook for the same reason `newChat`
     * is: *running* is a fact about whoever holds the task, and this file holds none. Absent,
     * and the line says nothing either way rather than guessing *no*.
     */
    running?(): boolean
    /** The table to check, defaulting to all of it. A seam, so the test does not need a network. */
    providers?: readonly Provider[]
  },
): Promise<Ran> {
  const typed = input.trim().replace(/^\//, '')
  const word = typed.split(/\s+/)[0] ?? ''
  const rest = typed.slice(word.length).trim()
  const { store } = context

  const mode = (name: keyof typeof MODES, note: string): Ran => {
    store.kvSet(CORE, 'mode', name)
    return { ok: true, note }
  }
  const pin = (change: Omit<Pins, 'placement'>, note: string): Ran => {
    setPin(store, change)
    return { ok: true, note }
  }

  switch (word) {
    case 'new':
      return (
        (await context.newChat?.()) ?? {
          ok: false,
          note: 'there is nowhere to start a new conversation from here',
        }
      )
    case 'help': {
      const list = commands(context.manifests)
      return {
        ok: true,
        note: list.map((one) => `/${one.name} — ${one.summary}`).join('\n'),
        data: list.map(({ name, summary }) => ({ name, summary })),
      }
    }
    case 'local':
      return mode('local', 'Local: everything runs on this machine, including the models.')
    case 'combined':
      return mode('combined', 'Combined: the cloud thinks, this machine makes images and speech.')
    case 'cloud':
      return mode('cloud', 'Cloud: everything goes through the providers you have connected.')
    case 'nsfw':
      return pin({ uncensored: true }, 'Uncensored models allowed. A model nobody has verified does not count.')
    case 'sfw':
      return pin({ uncensored: false }, 'Back to the standard content policy.')
    case 'cheap':
      return pin({ prefer: 'cheap' }, 'Cheapest first, which is usually free.')
    case 'best':
      return pin({ prefer: 'best' }, 'Strongest first. This one can cost money.')
    case 'providers':
      // Reports, never acts. A row that did not answer today is a question for a person —
      // disabling it here would hide the one thing worth knowing, and writing today's date
      // over its `verified` would be a check nobody performed.
      return { ok: true, note: report(await verify(context.providers)) }
    case 'status':
      return { ok: true, ...standing(store, context.running) }
  }

  // A plugin's, then — by the bare word it won, or by its namespaced form, which works
  // whether or not anything else took the short name.
  const found = commands(context.manifests).find((c) => c.plugin && (c.name === word || c.alias === word))
  if (!found?.plugin) return { ok: false, note: `there is no /${word} — type / to see what there is` }
  if (!context.call) return { ok: false, note: `/${word} needs ${found.plugin}, which is not running` }

  const tool = found.alias?.split('.')[1] ?? found.name
  try {
    return { ok: true, note: await context.call(found.plugin, tool, rest === '' ? undefined : { rest }) }
  } catch (error) {
    // The plugin's own words, or the reason it could not be reached. Never core's guess.
    return { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
}
