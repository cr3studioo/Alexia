// SPDX-License-Identifier: AGPL-3.0-only
import { CORE } from './secrets.js'
import type { Store } from './store.js'

/**
 * The consent ladder for skills (M6-9, D84).
 *
 * Plugins have had this since M2-5: a folder appearing is not consent, so a plugin arrives
 * installed and not enabled and somebody says yes (D73). **A skill arrived and was simply
 * live** — including a *learned* skill, which is written by a model, after a task, about what
 * it thinks it just learned. That is the one thing in this product that starts working
 * without anybody asking for it, and it is precisely the case the predecessor built this
 * ladder for, labelling it in as many words: **AI-generated — pending review**.
 *
 * **Three records, because they have three lifetimes.** Collapsing them into one field is
 * the mistake that makes each of them wrong somewhere:
 *
 * | Record | Lifetime | What it answers |
 * |---|---|---|
 * | **pending** | transient | is this waiting for a human right now |
 * | **provenance** | permanent, written once at creation | where did this come from |
 * | **preauth** | consumed once | *yes, to this exact name*, said in advance |
 *
 * **Pending is derived, not stored.** It is *not bundled and not yet allowed*, which means
 * there is no third place for it to disagree with the other two — and a transient fact with
 * its own row is a row that outlives what it was about.
 *
 * **Provenance is separate and permanent because of the field that looks like it means
 * something else.** The predecessor tried to read authorship out of a usage record and found
 * the upstream field meant *is this curator-managed*; rows written before the marker existed
 * were unrecoverable. So a skill with no provenance entry is shown as **unknown, never
 * guessed** — the same discipline as the catalog's honesty flags (M1-5). An absent fact is
 * displayed as absent.
 */

/** Where a skill came from. Written once, at the moment it arrives, and never rewritten. */
export type Provenance =
  /** Somebody put the folder there. Also what a folder of unknown origin is called. */
  | 'unknown'
  /** Alexia wrote it, from a task somebody watched happen (M4-5). */
  | 'learned'
  /** It arrived with a plugin, and the plugin's own yes covers it. */
  | 'bundled'
  /** Installed from the marketplace, which is a yes said in advance to that exact name. */
  | 'installed'

const PROVENANCE = 'skill_provenance'
const ALLOWED = 'skill_allowed'
const PREAUTH = 'skill_preauth'

const read = <T>(store: Store, key: string, fallback: T): T => (store.kvGet(CORE, key) as T | undefined) ?? fallback

/**
 * Where this skill came from, written once.
 *
 * **Once**, and that is the whole of it: a later writer does not overwrite an earlier one,
 * because provenance is a fact about the moment a thing arrived and nothing after that moment
 * knows it better. Re-recording is what turns *learned* into *installed* the first time
 * somebody re-syncs a folder.
 */
export function record(store: Store, name: string, provenance: Provenance): void {
  const held = read<Record<string, Provenance>>(store, PROVENANCE, {})
  if (held[name] !== undefined) return
  store.kvSet(CORE, PROVENANCE, { ...held, [name]: provenance })
}

/** What is known about where it came from. `undefined` means nobody wrote it down. */
export function provenanceOf(store: Store, name: string): Provenance | undefined {
  return read<Record<string, Provenance>>(store, PROVENANCE, {})[name]
}

/** Forget everything about a skill that is gone, so a new one of the same name starts clean. */
export function forgetConsent(store: Store, name: string): void {
  const held = read<Record<string, Provenance>>(store, PROVENANCE, {})
  if (name in held) {
    store.kvSet(CORE, PROVENANCE, Object.fromEntries(Object.entries(held).filter(([one]) => one !== name)))
  }
  store.kvSet(
    CORE,
    ALLOWED,
    read<string[]>(store, ALLOWED, []).filter((one) => one !== name),
  )
}

/**
 * *Yes, to this exact name*, said in advance.
 *
 * What the marketplace's Install button is: the person read what it was and pressed it, and
 * that is a real yes — it just arrives before the folder does. Consumed once, so a second
 * folder appearing under the same name later is a folder nobody said yes to.
 */
export function preauthorise(store: Store, name: string): void {
  const held = read<string[]>(store, PREAUTH, [])
  if (!held.includes(name)) store.kvSet(CORE, PREAUTH, [...held, name])
}

/** Spend it, if there is one. True means there was, and it is gone now. */
export function consume(store: Store, name: string): boolean {
  const held = read<string[]>(store, PREAUTH, [])
  if (!held.includes(name)) return false
  store.kvSet(
    CORE,
    PREAUTH,
    held.filter((one) => one !== name),
  )
  return true
}

/** Somebody said yes to this one, on the screen. */
export function allow(store: Store, name: string): void {
  const held = read<string[]>(store, ALLOWED, [])
  if (!held.includes(name)) store.kvSet(CORE, ALLOWED, [...held, name])
}

export function allowed(store: Store, name: string): boolean {
  return read<string[]>(store, ALLOWED, []).includes(name)
}

/**
 * May the model be shown this skill?
 *
 * A bundled one, yes: it arrived with a plugin and enabling that plugin was the yes, which is
 * a consent decision somebody already made with the author's own words in front of them.
 * Everything else needs a yes of its own — spent from a preauth as it arrives, or given on
 * the screen afterwards.
 */
export function live(store: Store, skill: { name: string; pluginId?: string }): boolean {
  return skill.pluginId !== undefined || allowed(store, skill.name)
}

/**
 * Meet a skill for the first time: spend a preauth if there is one, and write down where it
 * came from if nobody has.
 *
 * Called on every read rather than only on arrival, because core does not watch the skills
 * directory (M2-2) and a folder can appear between two of them. Idempotent, and cheap: two
 * map lookups for a skill that has been seen before.
 */
export function met(store: Store, skill: { name: string; pluginId?: string }): void {
  if (skill.pluginId !== undefined) {
    record(store, skill.name, 'bundled')
    return
  }
  // A preauth is only ever spent here, at the moment the thing it named actually turns up.
  if (consume(store, skill.name)) {
    record(store, skill.name, 'installed')
    allow(store, skill.name)
    return
  }
  // Nothing written, nothing to guess with. `unknown` is a fact and not a shrug: it means
  // this folder appeared and Alexia does not know who put it there.
  if (provenanceOf(store, skill.name) === undefined) record(store, skill.name, 'unknown')
}
