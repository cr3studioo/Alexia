// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notes from a recording: splitting a long transcript, putting the Markdown file together,
 * and finding a name that is free. Pure; the folder and the clock are handed in.
 */

/** Speech runs at about 150 words a minute; with no timestamps in a transcript, that is the clock. */
export const WORDS_PER_MINUTE = 150
export const CHUNK_MINUTES = 20

/** The transcript in pieces of about `minutes` of speech, cut at the end of a sentence or word. */
export function chunkTranscript(text, minutes = CHUNK_MINUTES) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const size = Math.max(1, Math.round(minutes * WORDS_PER_MINUTE))
  const chunks = []
  for (let at = 0; at < words.length; at += size) chunks.push(words.slice(at, at + size).join(' '))
  return chunks
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A title as a file name: no path separators or characters Windows refuses, 80 characters at most. */
export function fileStem(title) {
  const stem = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  if (stem === '') return 'Notes'
  // Windows opens CON, NUL, COM1 … (with or without an extension) as devices, not files.
  return RESERVED.test(stem) ? `_${stem}` : stem
}

/** `Title.md`, then `Title (2).md`, `Title (3).md` … the first one `taken(name)` says is free. */
export function freeName(stem, taken) {
  for (let n = 1; n < 10_000; n += 1) {
    const name = n === 1 ? `${stem}.md` : `${stem} (${n}).md`
    if (!taken(name)) return name
  }
  throw new Error('Too many notes with the same name.')
}

const SECTIONS = ['Key points', 'Terms', 'Open questions']

/**
 * What a model said, sorted into the three sections. It is asked for `## Key points`,
 * `## Terms` and `## Open questions`; if it ignored that, everything goes under Key points.
 */
export function sections(text) {
  const found = { 'Key points': [], Terms: [], 'Open questions': [] }
  let current = 'Key points'
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = /^\s*#{1,6}\s*(.+?)\s*:?\s*$/.exec(line)
    const match = head && SECTIONS.find((name) => name.toLowerCase() === head[1].toLowerCase())
    if (match) current = match
    else found[current].push(line)
  }
  return Object.fromEntries(SECTIONS.map((name) => [name, found[name].join('\n').trim()]))
}

/** The note: a header, the three sections, then the whole transcript folded away. */
export function renderNote({ title, date, course, summary, transcript }) {
  const parts = sections(summary)
  const body = SECTIONS.map((name) => `## ${name}\n\n${parts[name] || '_Nothing._'}\n`)
  return [
    `# ${String(title).trim()}`,
    '',
    `- Date: ${date}`,
    `- Course: ${course ? String(course).trim() : '—'}`,
    '',
    ...body,
    '<details>',
    '<summary>Transcript</summary>',
    '',
    String(transcript ?? '').trim(),
    '',
    '</details>',
    '',
  ].join('\n')
}
