// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telegram's "/" command menu, built from core's own list rather than kept in step by hand
 * (#6). Core already knows every manifest's commands — that is what answers `/help` — and a
 * second list of them living in this plugin would be exactly the kind of thing that drifts:
 * a plugin ships a command, the menu here is not told, and the "/" button quietly lies about
 * what typing `/` will do.
 *
 * `commandsFrom` reads `_meta['alexia/command']` when core sends it, and otherwise parses the
 * `/help` reply's own text — an older Alexia has no `_meta` key for this yet, and the menu
 * should still work against it rather than come up empty. `menu` is the other half: Telegram's
 * `setMyCommands` has its own rules (a lowercase name, a description that is not empty, at
 * most 100 entries), and a namespaced command like `commitments.due` or one with a `-` in it
 * is not a valid Telegram command at all, so it is dropped rather than sent and rejected.
 *
 * `stop` and `panel` are not core commands — `/stop` is intercepted by this plugin before it
 * ever reaches core (Phase 2), and `/panel` opens the Mini App this plugin owns — so they are
 * added here, after whatever core sent, rather than living in core's list for a menu that has
 * nothing to do with core.
 */

/** This plugin's own commands, not core's — always present, appended after core's list. */
export const OWN = [
  { name: 'stop', summary: 'Stop what Alexia is doing, and drop anything waiting.' },
  { name: 'panel', summary: 'Open the control panel.' },
]

/** A `/help` line of the form `/name — summary` (an em dash, or a plain ` - `). */
const LINE_RE = /^\/(\S+)\s+(?:—|-)\s+(.+)$/

/** Core's `/help` answer, however it arrived, as a plain list of `{ name, summary }`. */
export function commandsFrom(result) {
  const meta = result?._meta?.['alexia/command']
  if (Array.isArray(meta)) {
    return meta
      .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.summary === 'string')
      .map((entry) => ({ name: entry.name, summary: entry.summary }))
  }
  const text = result?.content?.type === 'text' ? result.content.text : undefined
  if (typeof text !== 'string') return []
  const found = []
  for (const line of text.split('\n')) {
    const match = LINE_RE.exec(line.trim())
    if (match) found.push({ name: match[1], summary: match[2] })
  }
  return found
}

/** A name Telegram's `setMyCommands` will actually accept. */
const NAME_RE = /^[a-z0-9_]{1,32}$/

/** Telegram's own cap on how many commands the menu can hold. */
const MAX_COMMANDS = 100

/** `{ name, summary }` pairs, from core and from `OWN`, turned into Telegram `BotCommand[]`. */
export function menu(list) {
  const out = []
  const seen = new Set()
  for (const entry of [...(Array.isArray(list) ? list : []), ...OWN]) {
    if (out.length >= MAX_COMMANDS) break
    const name = String(entry?.name ?? '')
    if (!NAME_RE.test(name) || seen.has(name)) continue
    seen.add(name)
    const summary = String(entry?.summary ?? '').trim()
    out.push({ command: name, description: (summary || name).slice(0, 256) })
  }
  return out
}

/** `OWN`, as the same `/name — summary` lines a relayed `/help` reply already uses. */
export function helpLines() {
  return OWN.map((entry) => `/${entry.name} — ${entry.summary}`).join('\n')
}
