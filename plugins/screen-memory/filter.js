// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What may be kept of one moment on screen, and what is cut out of it first. Pure: no I/O, no
 * clock, no logging — a function of the window in front, the words read off the screen and the
 * owner's exclusion list.
 *
 * **When in doubt, the moment is dropped.** A window nobody could name, a title that might be a
 * sign-in, a full-screen picture with no title bar: none of these are kept. Losing a moment
 * costs the owner a recall that comes back empty; keeping the wrong one costs a password in a
 * database.
 */

/** The longest text one moment keeps, after redaction. */
export const MAX_TEXT = 4000

/** What a removed secret reads as. */
export const REMOVED = '[removed]'

/** The owner's list when she has not written one. */
export const DEFAULT_SKIP_APPS = 'KeePassXC.exe, 1Password.exe, Bitwarden.exe'

/**
 * What the lock screen and the sign-in screen run as, on Windows and macOS. Not a setting:
 * there is no reason to keep any of them, and no way to make one a good idea.
 */
const LOCK_SCREENS = ['lockapp', 'logonui', 'loginwindow', 'screensaverengine', 'credentialuibroker', 'consent']

/**
 * Words in a window title that mean somebody may be typing a secret. Lower case, compared both
 * as written and with diacritics stripped, so `Přihlášení` and an OCR'd `Prihlaseni` match alike.
 */
const SECRET_TITLES = ['password', 'heslo', 'sign in', 'sign-in', 'přihlášení', 'přihlásit']

/** `KeePassXC.exe`, `keepassxc`, `/Applications/KeePassXC.app` → `keepassxc`. */
export function appKey(name) {
  const base = String(name ?? '')
    .trim()
    .split(/[\\/]/)
    .pop()
  return base.toLowerCase().replace(/\.(exe|app)$/, '')
}

/** The exclusion list from the setting's text: comma or newline separated, case ignored. */
export function parseSkipApps(text) {
  return new Set(
    String(text ?? DEFAULT_SKIP_APPS)
      .split(/[,\n;]/)
      .map(appKey)
      .filter((one) => one !== ''),
  )
}

const plain = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')

/** True when a title reads like a place a secret is typed. */
export function secretTitle(title) {
  const said = String(title ?? '').toLowerCase()
  const bare = plain(said)
  return SECRET_TITLES.some((word) => said.includes(word) || bare.includes(plain(word)))
}

/** Luhn's check, over a string of digits. */
export function luhn(digits) {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// 13–19 digits, with single spaces or dashes between groups as cards are printed and typed.
const CARD = /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g
// Two letters, two check digits, then 11–30 letters and digits, in groups of four or not.
// Upper case, as banks print them, so the next ordinary word is not swallowed with it.
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}(?![A-Z0-9])/g
// The token prefixes this plugin knows, and the rest of the token after them.
const TOKEN = /(?<![A-Za-z0-9])(?:sk-|sk_live_|sk_test_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-z]?-)[A-Za-z0-9_-]{4,}/gi

/**
 * Card numbers that pass Luhn, IBANs and API tokens, each replaced by `[removed]`. The host's own
 * credential redaction is not something a plugin can call, so this is this plugin's own.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(TOKEN, REMOVED)
    .replace(IBAN, (found) => {
      // Not every two-letters-two-digits run is an account number; one with this many digits
      // in it is close enough that keeping it would be the mistake.
      const digits = found.replace(/\D/g, '').length
      return digits >= 8 ? REMOVED : found
    })
    .replace(CARD, (found) => {
      const digits = found.replace(/\D/g, '')
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? REMOVED : found
    })
}

/**
 * Decide one moment.
 *
 * `front` is the window in front as the screenshot reported it: `{ app, title, fullscreen,
 * titleBar }`, and `locked` when the session is locked. `skipApps` is the owner's list, as
 * parsed by {@link parseSkipApps}.
 *
 * Returns `{ keep: false, reason }` — the reason is a fixed word, never anything read off the
 * screen — or `{ keep: true, app, title, text }` with the secrets already cut out.
 */
export function decide({ front, locked, text }, skipApps = parseSkipApps()) {
  if (locked === true) return { keep: false, reason: 'locked' }
  if (!front || typeof front !== 'object') return { keep: false, reason: 'unknown_window' }
  const app = typeof front.app === 'string' ? front.app.trim() : ''
  if (app === '' || typeof front.title !== 'string') return { keep: false, reason: 'unknown_window' }
  const key = appKey(app)
  if (LOCK_SCREENS.includes(key)) return { keep: false, reason: 'locked' }
  if (skipApps.has(key)) return { keep: false, reason: 'skipped_app' }
  if (secretTitle(front.title)) return { keep: false, reason: 'sign_in' }
  // Games and full-screen video: a window over the whole screen with no title bar. The hub's
  // game list is not something a plugin can see, so this is the test, and an unknown is a yes.
  if (typeof front.fullscreen !== 'boolean') return { keep: false, reason: 'unknown_window' }
  if (front.fullscreen && front.titleBar !== true) return { keep: false, reason: 'full_screen' }
  const words = redact(text).trim()
  if (words === '') return { keep: false, reason: 'no_text' }
  return { keep: true, app, title: redact(front.title).slice(0, 300), text: words.slice(0, MAX_TEXT) }
}
