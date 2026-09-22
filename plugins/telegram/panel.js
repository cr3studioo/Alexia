// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Mini App control panel (#5) — a snapshot of Alexia's state, and a handful of buttons,
 * opened from a keyboard button rather than served by this plugin. That last part is the
 * design: the page is a *static* file, hosted on GitHub Pages, with no token and no network
 * calls of its own, and every viewer's actual state rides along in the URL's `#fragment` —
 * which browsers never send to a host, static or otherwise. That is what makes a page that
 * knows today's spend safe to publish next to the app's own source.
 *
 * A tap on the page's buttons comes back the same way any Mini App reports a result:
 * `Telegram.WebApp.sendData(JSON.stringify({ do }))`, which arrives here as an ordinary
 * `web_app_data` message. `ACTIONS` is the allowlist that message is checked against — the
 * page is trusted to only ever send what its own buttons produce, but the message is not,
 * because anyone who can script `sendData` can hand this plugin whatever JSON they like.
 * `action()` is written the way `Asking`'s token lookup is: nothing not on the list survives
 * the trip, `Object.hasOwn` rather than `in` so a crafted `{"do":"__proto__"}` cannot reach
 * something `ACTIONS` never put there, and a document this large or this malformed does not
 * even get as far as `JSON.parse`.
 *
 * ### The state shape, `{ v, at, mode?, prefer?, today?, month?, running, waiting, voice, paired }`
 *
 * The page this state is built for is a separate piece of work, built against exactly this
 * shape, so it is documented here rather than left to be inferred from `encode`'s call sites:
 *
 * - `v` — `PANEL_VERSION`, so a page loaded from a stale cache can tell it is reading a shape
 *   older or newer than the one it knows, rather than silently misreading a field.
 * - `at` — when this snapshot was taken, in milliseconds since the epoch.
 * - `mode` — `'local' | 'combined' | 'cloud'`, when core's `/status` said one.
 * - `prefer` — `'cheap' | 'best'`, when core's `/status` said one.
 * - `today` — `{ spent, allowance }`, today's spend against today's allowance, in the same
 *   currency units `/status` already reports them in.
 * - `month` — `{ spent, cap? }`, the month's spend, and its cap when one is set.
 * - `running` — whether a task is in progress right now.
 * - `waiting` — how many messages are queued behind it (`Line`'s own count).
 * - `voice` — the `voice_replies` mode in effect: `'never' | 'mirror' | 'always'`.
 * - `paired` — how many Telegram accounts are allowed to reach Alexia.
 */

/** Bumped if this shape ever changes incompatibly — a page reading an unknown `v` knows why. */
export const PANEL_VERSION = 1

/** Where the panel page is hosted by default, once Pages is turned on for the repo. */
export const DEFAULT_PANEL_URL = 'https://cr3studioo.github.io/Alexia/telegram/'

/** `state` → JSON → UTF-8 bytes → base64url, with no padding — a URL fragment, not a body. */
export function encode(state) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
}

/** The inverse of `encode`, for the panel page itself. Garbage in is `undefined`, never a throw. */
export function decode(fragment) {
  try {
    const raw = String(fragment ?? '').replace(/^#/, '')
    if (raw === '') return undefined
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** Telegram's own cap on a `web_app` button's URL, which `#encode(state)` has to fit inside. */
const URL_LIMIT = 2048

/**
 * `base#encode(state)`, or `undefined` when there is no safe URL to build — `base` is not
 * `https:` (a Mini App button that opened `file:` or `javascript:` would be a bug worth
 * refusing outright, not a corner case to leave to Telegram), or the state, once encoded,
 * does not fit.
 */
export function panelUrl(base, state) {
  let url
  try {
    url = new URL(String(base))
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  url.hash = ''
  const full = `${url.toString()}#${encode(state)}`
  return full.length <= URL_LIMIT ? full : undefined
}

/**
 * The allowlist a `do` string is checked against — the whole of what the panel's buttons are
 * allowed to mean. Nothing else reaches `command()` or the settings this plugin owns.
 */
export const ACTIONS = Object.freeze({
  new: Object.freeze({ command: '/new' }),
  local: Object.freeze({ command: '/local' }),
  combined: Object.freeze({ command: '/combined' }),
  cloud: Object.freeze({ command: '/cloud' }),
  cheap: Object.freeze({ command: '/cheap' }),
  best: Object.freeze({ command: '/best' }),
  stop: Object.freeze({ stop: true }),
  'voice:never': Object.freeze({ voice: 'never' }),
  'voice:mirror': Object.freeze({ voice: 'mirror' }),
  'voice:always': Object.freeze({ voice: 'always' }),
})

/** Telegram's own cap on `web_app_data.data` — checked before this even tries to parse it. */
const DATA_LIMIT = 4096

/**
 * `web_app_data.data`, checked against `ACTIONS`. `Object.hasOwn` rather than `key in ACTIONS`
 * or `ACTIONS[key]` is what keeps `"__proto__"` and `"constructor"` from resolving to
 * something this allowlist never put there — an *own* key is the only kind that counts.
 */
export function action(data) {
  if (typeof data !== 'string' || data.length > DATA_LIMIT) return undefined
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const key = parsed.do
  if (typeof key !== 'string' || !Object.hasOwn(ACTIONS, key)) return undefined
  return ACTIONS[key]
}

/** The persistent reply-keyboard button that opens the panel at the given (already-encoded) URL. */
export function keyboard(url) {
  return {
    keyboard: [[{ text: '⚙ Panel', web_app: { url } }]],
    resize_keyboard: true,
    is_persistent: true,
  }
}
