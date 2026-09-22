// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What arrives from the phone besides typed words: a photo, a document, a voice note, or a
 * tap on the panel. All of it lands on the same `message` object Telegram sends, and pure
 * helpers over that shape are what `index.js` wires to `document.extract`, the download and
 * the turn it builds — kept here, and kept pure, so a path this easy to get subtly wrong
 * (which size wins, which characters survive a filename) is one a test can pin down without
 * a bot token or a running plugin.
 *
 * **Photos are capped at 5 MB** because that is the largest size Telegram itself offers in
 * `PhotoSize[]` before it starts downscaling, so asking for anything bigger only asks Telegram
 * to shrink it anyway. **Downloads are capped at 20 MB** because that is `getFile`'s own limit
 * for a bot — past it, the file exists on Telegram's side but this plugin cannot fetch it, and
 * the honest answer is to say so rather than let the download fail lower down.
 *
 * A document's name is the one piece of this that reaches the filesystem, which makes it the
 * one piece a stranger's upload could use to climb out of `ownDir/incoming/` — `../../etc/x`
 * is a path, not a filename, and `safeName` is what turns it back into one.
 */

/** The largest `PhotoSize` this plugin will pick without Telegram having to shrink it first. */
export const PHOTO_MAX = 5 * 1024 * 1024

/** `getFile`'s own ceiling for a bot. Past this the bytes are not reachable at all. */
export const DOWNLOAD_MAX = 20 * 1024 * 1024

/** The raster formats Telegram will actually hand back as an image, not a generic file. */
export function isImageMime(mime) {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(String(mime ?? ''))
}

/**
 * What kind of message this is, for the one branch that matters to the caller. Checked in a
 * fixed order because a `document` that happens to be an image has to be caught before the
 * plain `document` branch claims it, and a tap on the panel arrives as its own kind of
 * message entirely, ahead of everything else a message could also be.
 */
export function kindOf(message) {
  if (message?.web_app_data) return 'web_app'
  if (Array.isArray(message?.photo) && message.photo.length > 0) return 'photo'
  if (message?.document) return isImageMime(message.document.mime_type) ? 'image_document' : 'document'
  if (message?.voice ?? message?.audio) return 'voice'
  if (typeof message?.text === 'string') return 'text'
  return undefined
}

/**
 * The `PhotoSize` to actually fetch: the largest one that fits under `PHOTO_MAX`, because a
 * bigger size is more detail for the model to see. A size with no `file_size` at all — Telegram
 * does not always report one — is assumed to fit rather than assumed not to, since refusing an
 * unmeasured photo would refuse most of them. When nothing fits, the smallest is the least
 * bad choice rather than no choice at all.
 */
export function bestPhoto(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined
  const area = (size) => size.width * size.height
  const fits = (size) => typeof size.file_size !== 'number' || size.file_size <= PHOTO_MAX
  const within = sizes.filter(fits)
  const pool = within.length > 0 ? within : sizes
  const better = within.length > 0 ? (a, b) => area(a) > area(b) : (a, b) => area(a) < area(b)
  return pool.reduce((best, candidate) => (better(candidate, best) ? candidate : best))
}

/**
 * A filename safe to write under `ownDir/incoming/`. Only the basename survives — the path
 * before it is exactly how `../../etc/passwd` (or a Windows path with a drive letter, on the day this bot
 * also has a Windows-side sender) would climb out of that directory, so it is discarded, not
 * escaped. What is left is trimmed to `[\w.-]`, stripped of any leading dot so it cannot pass
 * as a dotfile, capped at 100 characters, and never empty.
 */
export function safeName(name) {
  const base = String(name ?? '').split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '')
  return cleaned.slice(0, 100) || 'file'
}

/** Whether a size is past what `getFile` will hand back to a bot. */
export function tooBig(size) {
  return typeof size === 'number' && size > DOWNLOAD_MAX
}

/** The user turn a downloaded, extracted file becomes — caption first, when there is one. */
export function fileTurn(caption, name, extracted) {
  const parts = []
  if (caption) parts.push(String(caption))
  parts.push(`The file ${name} says:`)
  parts.push(String(extracted ?? ''))
  return parts.join('\n\n')
}

/** What the chat history keeps for a photo turn — not the bytes, which never touch storage. */
export function photoNote(caption) {
  return caption ? `[a photo] ${caption}` : '[a photo]'
}
