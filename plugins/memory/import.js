// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Importing memories from another assistant's export (P3-15, ME-18).
 *
 * **The owner provides the file; nothing here goes looking.** The tool is handed one path, and
 * the path must be inside a folder the owner chose (`insideRoots`). What is read is parsed here
 * as plain data — no code in an export is ever run — and handed back as one of two things:
 *
 * - `memories`: sentences the other assistant had already written down about the owner. They
 *   become facts as they are.
 * - `messages`: only the owner's own messages, when an export has no memory entries. They go
 *   through the normal sorting pass (capture.js) in batches, so a note is only written if the
 *   sorter would have written it from a live conversation.
 *
 * Pure functions only; the reading and the writing are in index.js.
 */

/** At most this many of the owner's messages are read from one export. The newest are kept. */
export const MESSAGES_MOST = 2000
/** At most this many memory entries from one export, a limit against a file that is not one. */
export const MEMORIES_MOST = 2000
/** A memory longer than this is not a sentence about somebody; it is cut. */
export const LONGEST = 500

/** Root URIs (`file://…`) or plain paths, as plain absolute paths. Anything else is dropped. */
export function rootPaths(roots) {
  const out = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const raw = typeof root === 'string' ? root : root?.uri
    if (typeof raw !== 'string' || raw === '') continue
    try {
      out.push(raw.startsWith('file:') ? fileURLToPath(raw) : raw)
    } catch {
      // A URI that is not a path on this machine is not a place a file can be inside.
    }
  }
  return out.filter((one) => isAbsolute(one))
}

const same = (a) => (process.platform === 'win32' ? a.toLowerCase() : a)

/** Is `path` the folder `root` or somewhere inside it? Compared after resolving `..` away. */
export function insideRoots(path, roots) {
  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) return false
  const target = resolve(path)
  return rootPaths(roots).some((root) => {
    const rel = relative(same(resolve(root)), same(target))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/** One memory as a sentence: bullets, numbering and a leading date taken off, whitespace folded. */
export function clean(text) {
  const one = String(text ?? '')
    .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[?\d{4}-\d{2}-\d{2}\]?\s*[:–-]?\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...one].length > LONGEST ? [...one].slice(0, LONGEST).join('') : one
}

const unique = (items) => {
  const seen = new Set()
  return items.filter((one) => {
    const key = one.toLowerCase()
    if (one.length < 3 || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A plain text or Markdown file: one memory per line. Headings, rules and empty lines are not memories. */
export function lines(text) {
  return unique(
    String(text ?? '')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:#{1,6}\s|[-*_]{3,}\s*$|>|```)/.test(line))
      .map(clean)
      .filter((line) => line !== ''),
  ).slice(0, MEMORIES_MOST)
}

/** The text of one memory entry however an export spelled it: a string, or an object with a text-ish key. */
function textOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return ''
  for (const key of ['memory', 'text', 'content', 'value', 'summary', 'fact']) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

const list = (value) => (Array.isArray(value) ? value : [])

/** The `memory` entries of a ChatGPT export, wherever it keeps them, or `[]`. */
function chatgptMemories(data) {
  const found = []
  const take = (holder) => {
    if (holder === null || typeof holder !== 'object') return
    for (const key of ['memory', 'memories']) {
      const value = holder[key]
      if (Array.isArray(value)) found.push(...value.map(textOf))
      else if (typeof value === 'string' && value.trim() !== '') found.push(value)
    }
  }
  take(data)
  for (const one of list(data)) take(one)
  // A memory kept as a message of its own inside a conversation.
  for (const one of list(data)) {
    for (const node of Object.values(one?.mapping ?? {})) {
      const message = node?.message
      if (message?.author?.role === 'memory') found.push(list(message.content?.parts).filter((p) => typeof p === 'string').join(' '))
    }
  }
  return unique(found.map(clean).filter(Boolean))
}

/** The owner's own messages, oldest first, at most `MESSAGES_MOST` of the newest. */
function chatgptMessages(data) {
  const said = []
  for (const conversation of list(data)) {
    for (const node of Object.values(conversation?.mapping ?? {})) {
      const message = node?.message
      if (message?.author?.role !== 'user') continue
      const text = list(message.content?.parts)
        .filter((part) => typeof part === 'string')
        .join('\n')
        .trim()
      if (text === '') continue
      said.push({ text, at: Number(message.create_time ?? conversation.create_time ?? 0) || 0 })
    }
  }
  said.sort((a, b) => a.at - b.at)
  return said.slice(-MESSAGES_MOST).map((one) => one.text)
}

/** Does this look like ChatGPT's `conversations.json` (or something carrying its memory)? */
function chatgptShaped(data) {
  // A list is ChatGPT's when it holds conversations; a list of `{ memory }` objects is a plain memory list.
  if (Array.isArray(data)) return data.some((one) => one !== null && typeof one === 'object' && 'mapping' in one)
  return data !== null && typeof data === 'object' && ('memory' in data || 'conversations' in data)
}

/**
 * What an export holds. `name` is the file's name (it picks Markdown from plain text), `text` its
 * contents, `assistant` an optional name from the owner that overrules the guess.
 *
 * Returns `{ assistant, kind: 'memories' | 'messages', items: string[] }`, or `null` when the file
 * is not something this can read at all.
 */
export function parseExport(name, text, assistant) {
  const given = typeof assistant === 'string' && assistant.trim() !== '' ? assistant.trim().slice(0, 60) : undefined
  const body = String(text ?? '').replace(/^﻿/, '')
  const trimmed = body.trim()
  if (trimmed === '') return null
  if (/^[[{]/.test(trimmed)) {
    let data
    try {
      data = JSON.parse(trimmed)
    } catch {
      return null
    }
    const wrapped = data !== null && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.conversations) ? data.conversations : undefined
    if (chatgptShaped(data)) {
      const source = wrapped ?? data
      const memories = unique([...chatgptMemories(data), ...(wrapped === undefined ? [] : chatgptMemories(wrapped))])
      if (memories.length > 0) return { assistant: given ?? 'ChatGPT', kind: 'memories', items: memories.slice(0, MEMORIES_MOST) }
      const messages = chatgptMessages(source)
      return { assistant: given ?? 'ChatGPT', kind: 'messages', items: messages }
    }
    // A Claude memory export as JSON: a list of memories, or an object holding one.
    const holder = Array.isArray(data) ? data : (['memories', 'items', 'entries'].map((key) => data?.[key]).find(Array.isArray) ?? [])
    const items = unique(holder.map(textOf).map(clean).filter(Boolean)).slice(0, MEMORIES_MOST)
    return items.length === 0 ? null : { assistant: given ?? 'Claude', kind: 'memories', items }
  }
  const items = lines(body)
  if (items.length === 0) return null
  // Markdown with headings is what Claude writes its memory out as; a bare list of lines is the owner's own.
  const markdown = /\.(?:md|markdown)$/i.test(String(name ?? '')) && /^\s*#{1,6}\s/m.test(body)
  return { assistant: given ?? (markdown ? 'Claude' : 'a text file'), kind: 'memories', items }
}

/** The file inside an unpacked ChatGPT export folder that holds the conversations, or `undefined`. */
export const exportFile = (names) =>
  names.find((one) => one.toLowerCase() === 'conversations.json') ?? names.find((one) => /^(?:memory|memories)\.(?:json|md|txt)$/i.test(one))

/** The sentence every imported fact carries as where it came from. */
export const origin = (assistant) => `Imported from ${assistant}`

/** `items` in groups of `size`. */
export function batches(items, size) {
  const out = []
  for (let from = 0; from < items.length; from += size) out.push(items.slice(from, from + size))
  return out
}
