// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Is this a moment to look at? Decided from what `computer.screenshot` says about the screen
 * (`locked`, and `front: { app, title }`), before a single pixel is read. Pure.
 *
 * Three answers: `ok`, `private` (locked, a password manager, a sign-in or a private browser
 * window) and `unknown` (nobody could say which window was in front, which may be because it
 * changed while the picture was taken, so it is worth one more try).
 */

/** What the lock screen, the sign-in screen and the system's password prompts run as. */
const LOCK_SCREENS = ['lockapp', 'logonui', 'loginwindow', 'screensaverengine', 'credentialuibroker', 'consent']

/** Programs whose whole window is secrets. */
const SECRET_APPS = [
  'keepass',
  'keepassxc',
  '1password',
  'bitwarden',
  'dashlane',
  'lastpass',
  'nordpass',
  'enpass',
  'proton pass',
  'protonpass',
  'keeperpasswordmanager',
  'keychain access',
  'passwords',
]

/**
 * Words in a window title that mean a secret may be on it: a sign-in, or a browser's private
 * window as Chrome, Edge, Firefox and Safari name them. Compared lower case, both as written
 * and without diacritics.
 */
const PRIVATE_TITLES = [
  'password',
  'heslo',
  'sign in',
  'sign-in',
  'přihlášení',
  'přihlásit',
  'incognito',
  'inprivate',
  'private browsing',
  'anonymní',
]

/** `KeePassXC.exe`, `keepassxc`, `/Applications/KeePassXC.app` → `keepassxc`. */
const appKey = (name) =>
  String(name)
    .trim()
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|app)$/, '')

const plain = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')

/** `ok`, `private` or `unknown`, from the screenshot's `structuredContent`. */
export function moment(shot) {
  // Only a plain "not locked" counts: a missing answer is not one.
  if (shot?.locked !== false) return 'private'
  const front = shot.front
  const app = typeof front?.app === 'string' ? front.app.trim() : ''
  if (app === '') return 'unknown'
  const key = appKey(app)
  if (LOCK_SCREENS.includes(key) || SECRET_APPS.includes(key)) return 'private'
  // macOS names no title without Accessibility; the app alone is then what there is to go on.
  const title = typeof front.title === 'string' ? front.title.toLowerCase() : ''
  const bare = plain(title)
  return PRIVATE_TITLES.some((word) => title.includes(word) || bare.includes(plain(word))) ? 'private' : 'ok'
}
