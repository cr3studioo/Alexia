// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/**
 * What a step is allowed to do, decided before it runs.
 *
 * Three layers, checked in this order and never the other way round:
 *
 * 1. **The never-touch list.** Deterministic code, no model involved. It is what stands
 *    between the user and a disaster when the checker is wrong, so it is the first question
 *    and it has no appeal.
 * 2. **Spoken boundaries.** *"Don't delete anything"* holds until lifted. Said out loud as a
 *    strong default rather than a guarantee, because that is what it is.
 * 3. **The mode**, read off the tool's MCP annotations. Nothing Alexia-specific and nothing
 *    an author declares twice.
 *
 * Nothing in this file knows a plugin's name, and nothing in it asks a model anything.
 */

/** The four modes, in the user's own words (Alexia.md, *What Alexia may do*). */
export type Mode = 'every-time' | 'risky' | 'watch' | 'full-trust'

export const MODE_LABELS: Record<Mode, string> = {
  'every-time': 'Ask me every time',
  risky: 'Ask before anything risky',
  watch: 'Watch and warn me',
  'full-trust': 'Full trust',
}

export const DEFAULT_MODE: Mode = 'risky'

/** MCP's own hints. Alexia adds no fields of its own — that is the point of using them. */
export interface Annotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * A standing instruction the user gave in words. It is not OS-enforced and never claims to
 * be: `said` is quoted back verbatim whenever it stops something, so the person can see
 * exactly which sentence of theirs is doing the blocking and lift it.
 */
export interface Boundary {
  /** Their words, unedited. Core paraphrasing a boundary back is how one gets misremembered. */
  said: string
  /** What it stops. `destructive` is the one people actually say out loud. */
  blocks: 'destructive' | 'everything'
  at: number
}

export interface Ask {
  tool: string
  annotations?: Annotations
  /** Absolute paths this call names, if core could work out any. */
  paths?: readonly string[]
  /**
   * Whether the annotations can be believed. A plugin from Alexia's own registry is
   * reviewed; an MCP server added through compatibility mode (M3-6) is not, and every tool
   * on one is treated as destructive until a human says otherwise (wire-protocol §7).
   */
  reviewed?: boolean
}

export interface Scope {
  mode: Mode
  /** Folders the user put in scope. Empty means nothing is, which is the safe start. */
  roots: readonly string[]
  /** *Everywhere*, chosen deliberately and warned about at the time. */
  everywhere?: boolean
  boundaries?: readonly Boundary[]
  /** Alexia's own data directory, which is on the never-touch list by being it. */
  dataDir: string
}

export type Ruling =
  /** Run it. */
  | { verdict: 'run' }
  /** The user decides, now. `why` is the sentence they are deciding about. */
  | { verdict: 'ask'; why: string }
  /** No. Not askable — the reason says which of the three layers said so. */
  | { verdict: 'blocked'; why: string }

/**
 * The one rule with no exceptions.
 *
 * **The never-touch list survives Full trust** (D63). The sources disagreed: Alexia.md's
 * mode table and wire-protocol.md §7 both say it still applies there, while Alexia.md's
 * rules section and plan.md's M15-3 both carve Full trust out. Resolved towards the floor,
 * for three reasons — the wire protocol is the half plugin authors write against and a
 * contract that says "still applies" must not be a lie; the list is credential stores and
 * system directories, so an override makes one toggle grant read of every saved password on
 * the machine, and *not recommended* is not informed consent for that; and the plan's own
 * sentence in the same paragraph calls this "what stands between the user and a disaster
 * when the checker is wrong" — a floor with an off-switch is not a floor.
 *
 * Full trust still does what it says. It removes prompts, not the floor.
 */
export function rule(ask: Ask, scope: Scope): Ruling {
  const forbidden = (ask.paths ?? []).find((path) => neverTouch(path, scope.dataDir))
  if (forbidden !== undefined) {
    return {
      verdict: 'blocked',
      why: `${forbidden} is on the never-touch list, which no permission mode turns off.`,
    }
  }

  // In scope, or not. Empty roots and no *Everywhere* means the user has not said where
  // Alexia may work, and the answer to "may I write here" is then no rather than probably.
  const outside = (ask.paths ?? []).find((path) => !inScope(path, scope))
  if (outside !== undefined) {
    return {
      verdict: 'ask',
      why: `${ask.tool} wants ${outside}, which is outside the folders you chose.`,
    }
  }

  const destructive = isDestructive(ask)
  for (const boundary of scope.boundaries ?? []) {
    if (boundary.blocks === 'everything' || destructive) {
      return {
        verdict: 'blocked',
        // Their sentence, not a paraphrase of it, so the thing to lift is unmistakable.
        why: `You said “${boundary.said}”, so ${ask.tool} is not running. Say so and I will lift it.`,
      }
    }
  }

  switch (scope.mode) {
    case 'full-trust':
      return { verdict: 'run' }
    case 'every-time':
      return { verdict: 'ask', why: `${ask.tool} wants to run.` }
    case 'watch':
      // Runs, and the checker reviews it (M15-4). Flagged ones stop there, not here.
      return { verdict: 'run' }
    case 'risky':
      return readOnly(ask) ? { verdict: 'run' } : { verdict: 'ask', why: `${ask.tool} ${changes(ask)}.` }
  }
}

/**
 * Read-only enough to run unasked. An unreviewed server's word is not taken for it, and
 * neither is silence: a tool that declares nothing has not said it is safe.
 */
function readOnly(ask: Ask): boolean {
  if (ask.reviewed === false) return false
  return ask.annotations?.readOnlyHint === true && ask.annotations.destructiveHint !== true
}

/** `destructiveHint: true` gates in every mode except Full trust, and so does not knowing. */
function isDestructive(ask: Ask): boolean {
  if (ask.reviewed === false) return true
  return ask.annotations?.destructiveHint === true
}

const changes = (ask: Ask): string =>
  isDestructive(ask) ? 'changes or deletes something' : 'is not marked as read-only'

/**
 * The fixed list, built from where this machine actually keeps these things rather than
 * from path literals — which is invariant 7, and also the only way one list is right on
 * three platforms.
 *
 * Deliberately short. Every entry is somewhere a compromise is unrecoverable: the secrets
 * themselves, the operating system, and Alexia's own database — which holds the
 * conversation, the spend and the pointer to every key.
 */
export function neverTouchList(dataDir: string): string[] {
  const home = homedir()
  const root = parse(home).root
  const env = (name: string): string[] => {
    const value = process.env[name]
    return value ? [value] : []
  }

  const everywhere = [
    // Alexia's own config and database. It knows what you said and what it cost.
    dataDir,
    // Keys and credentials, in the places every platform agrees on.
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
  ]

  if (process.platform === 'win32') {
    return [
      ...everywhere,
      ...env('SystemRoot'),
      ...env('ProgramFiles'),
      ...env('ProgramFiles(x86)'),
      // DPAPI master keys and the credential vault: the keychain, on this platform.
      ...env('APPDATA').map((base) => join(base, 'Microsoft', 'Crypto')),
      ...env('APPDATA').map((base) => join(base, 'Microsoft', 'Protect')),
      ...env('LOCALAPPDATA').map((base) => join(base, 'Microsoft', 'Credentials')),
    ]
  }

  if (process.platform === 'darwin') {
    return [
      ...everywhere,
      join(home, 'Library', 'Keychains'),
      join(root, 'System'),
      join(root, 'Library', 'Keychains'),
      join(root, 'usr'),
      join(root, 'bin'),
      join(root, 'sbin'),
      join(root, 'etc'),
    ]
  }

  return [
    ...everywhere,
    join(home, '.local', 'share', 'keyrings'),
    join(root, 'etc'),
    join(root, 'boot'),
    join(root, 'bin'),
    join(root, 'sbin'),
    join(root, 'usr'),
    join(root, 'sys'),
    join(root, 'proc'),
    join(root, 'dev'),
  ]
}

/** Is this path inside one of the forbidden trees? Resolved first, so `..` cannot walk in. */
export function neverTouch(path: string, dataDir: string): boolean {
  return neverTouchList(dataDir).some((forbidden) => within(forbidden, path))
}

function inScope(path: string, scope: Scope): boolean {
  if (scope.everywhere) return true
  return scope.roots.some((root) => within(root, path))
}

/**
 * Is `path` inside `parent`? Both resolved, and the comparison is on path segments rather
 * than on the string — `startsWith` says a folder called `work-notes` is inside one called
 * `work`, which is exactly the bug this check exists to not have.
 */
export function within(parent: string, path: string): boolean {
  const from = resolve(parent)
  const to = resolve(path)
  if (from === to) return true
  const step = relative(from, to)
  return step !== '' && !step.startsWith('..') && !isAbsolute(step)
}

/**
 * The paths a call names, as far as core can tell.
 *
 * **Absolute only, and that limit is the honest part.** A plugin's working directory is one
 * core owns and not its own folder (D58), so a relative path in an argument cannot be
 * resolved to a real place from out here — guessing a base would produce a confident wrong
 * answer about what is being touched, which is worse than no answer.
 *
 * So this is a filter, not a sandbox, and it is why the never-touch list is one of three
 * layers rather than the only one. A plugin that wants to read your keys through a relative
 * path is caught by its manifest at install time and by the checker at run time (M15-4), not
 * here.
 */
export function pathsIn(args: Record<string, unknown>): string[] {
  const found: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4) return
    if (typeof value === 'string') {
      if (isAbsolute(value)) found.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1)
    }
  }
  walk(args, 0)
  return found
}

/**
 * The folders handed to plugins as MCP `roots`.
 *
 * *Everywhere* is not expressible as a root, and is not faked as one: MCP roots are a list
 * of directories, and inventing `/` for it would tell a plugin something false about what it
 * is allowed to read. A plugin in *Everywhere* gets the chosen folders and nothing implied.
 */
export function rootsOf(scope: Scope): { uri: string; name: string }[] {
  return scope.roots
    .filter((dir) => !neverTouch(dir, scope.dataDir))
    .map((dir) => ({ uri: fileUri(dir), name: dir.split(sep).filter(Boolean).at(-1) ?? dir }))
}

/** A `file://` URI for an absolute path, which is the only form MCP roots take. */
function fileUri(dir: string): string {
  const absolute = resolve(dir).split(sep).join('/')
  return new URL(`file://${absolute.startsWith('/') ? '' : '/'}${absolute}`).href
}

/**
 * The warning *Everywhere* comes with. One sentence, said when it is picked and not buried
 * in a settings page afterwards — and it names what is still true, because a warning that
 * only says "be careful" teaches nothing.
 */
export const EVERYWHERE_WARNING =
  'Everywhere means every folder your account can reach, including ones you have forgotten about. The never-touch list still applies — keys, system folders and Alexia’s own database are never readable whatever the mode.'

/**
 * Boundaries core can hear without asking a model.
 *
 * Both apostrophes, because don't and don’t are the same sentence and only one of them is
 * what a phone or a word processor produces. A boundary that missed the curly one would fail
 * silently, in the direction of doing the thing the user asked it not to.
 *
 * The same shape as the router's `HARD` list, and the same honesty about it: a short list of
 * the ways people actually say this, boring, and edited when it is wrong. The checker
 * (M15-4) is where anything cleverer belongs — this is the floor, and a floor that misses a
 * phrasing is why the answer says out loud that it is a default and not a guarantee.
 */
const SPOKEN: { pattern: RegExp; blocks: Boundary['blocks'] }[] = [
  { pattern: /\b(?:do ?n[o’']?t|never|no)\s+(?:ever\s+)?(?:delete|remove|erase|destroy|rm)\b/i, blocks: 'destructive' },
  { pattern: /\b(?:do ?n[o’']?t|never)\s+(?:ever\s+)?(?:change|modify|edit|overwrite|write)\s+(?:any|anything|my|the)\b/i, blocks: 'destructive' },
  { pattern: /\b(?:do ?n[o’']?t|never)\s+(?:ever\s+)?(?:touch|do)\s+anything\b/i, blocks: 'everything' },
  { pattern: /\bread[- ]only\b.*\bplease\b|\bjust look\b|\blook,? do ?n[o’']?t touch\b/i, blocks: 'destructive' },
]

/** A boundary in what the user just said, or nothing. */
export function heard(said: string, at: number = Date.now()): Boundary | undefined {
  const found = SPOKEN.find((rule) => rule.pattern.test(said))
  return found ? { said: said.trim(), blocks: found.blocks, at } : undefined
}

/** What core says back when it hears one. The distinction is the whole sentence. */
export const boundaryAck = (boundary: Boundary): string =>
  boundary.blocks === 'everything' ?
    'Understood — I will not do anything until you say otherwise. That is a rule I hold myself to, not something the operating system enforces for me.'
  : 'Understood — I will not delete or change anything until you say otherwise. That is a rule I hold myself to, not something the operating system enforces for me.'

/** Lifting one. Also a short list, and also said out loud rather than done quietly. */
const LIFTED = /\b(?:you can|go ahead and|ok(?:ay)? (?:you can|to))\s+(?:delete|remove|change|edit|write)|\b(?:lift|forget|cancel|drop)\s+(?:that|the)\s+(?:rule|restriction|boundary)\b|\bnever ?mind that\b/i

export const lifts = (said: string): boolean => LIFTED.test(said)
