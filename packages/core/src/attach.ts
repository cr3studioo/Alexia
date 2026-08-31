// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * **Uploading is core's half; reading is a plugin's** — and this file is the seam.
 *
 * A plugin cannot add a control to the composer and should not be able to, so where the bytes
 * arrive, what happens to them, and how a file appears in the conversation are core's. What
 * the file *says* is `document.extract`, which core resolves by capability name and never by
 * plugin id: delete whatever is answering it and an attachment still arrives, still lands in
 * the conversation, and says that nothing could read it.
 *
 * **Base64 in a JSON body, not multipart.** `node:http` has no multipart parser, and adding
 * one for this would buy a parser core otherwise never needs. Drag-and-drop and paste hand
 * the webview bytes rather than a path, so there is nothing to open on this side and nothing
 * to ask permission for — the file the user chose is the file that arrives.
 *
 * **The bytes do not stay.** The file is written, read, and deleted in the same breath. It
 * has to exist on disk for the length of one call, because the capability takes a path the
 * way `voice.transcribe` does; it does not have to exist afterwards, and a folder of
 * everybody's payslips accumulating beside the database is a second place their documents
 * live for no benefit at all. What is kept is the extracted text, in the conversation, where
 * they can see it.
 */

/** What the shell sends: a name and the bytes, base64, because JSON has no others. */
export interface Upload {
  name: string
  data: string
}

/** One that made it to disk, ready to be handed to whatever reads documents. */
export interface Saved {
  name: string
  path: string
  bytes: number
}

/**
 * The ceilings, and what each of them is actually protecting.
 *
 * A body arrives as one string in memory and base64 is a third bigger than what it encodes,
 * so the real cost of the total is about 55 MB of string. That is a deliberate ceiling rather
 * than a guess: past it the answer is *attach fewer, or smaller* and not a machine paging.
 */
export const MOST_FILES = 8
export const MOST_PER_FILE = 25 * 1024 * 1024
export const MOST_TOGETHER = 40 * 1024 * 1024

/** The characters a Windows filename may not hold, plus both separators. */
const FORBIDDEN = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']

/**
 * A name that cannot escape the folder it is written to.
 *
 * The name comes from the shell, which got it from a file the user picked — so it is not
 * hostile in any ordinary sense, and it is still the one string here that a path is built
 * from. Everything but the last segment goes, then everything a filesystem argues about.
 */
export function safeName(name: string): string {
  const last = basename(String(name).split('\\').join('/'))
  // Filtered character by character rather than by a range, because the range that spells
  // *control characters* in a regex is one typo away from also spelling *digits and dots* —
  // and a name with its dots taken out has no extension for the reader to dispatch on.
  const bare = [...last]
    .filter((one) => (one.codePointAt(0) ?? 0) > 31 && !FORBIDDEN.includes(one))
    .join('')
    .replace(/^\.+/, '')
    .trim()
  const kept = bare.slice(-120)
  return kept === '' ? 'attachment' : kept
}

/**
 * Write what arrived, and say what would not fit.
 *
 * Refusals come back as sentences rather than being thrown, because one oversized file among
 * five should not lose the other four — the message still gets sent, and the line under the
 * composer says which one did not come with it.
 */
export function receive(uploads: readonly Upload[], dir: string, at: number = Date.now()): { kept: Saved[]; refused: string[] } {
  const kept: Saved[] = []
  const refused: string[] = []
  let together = 0
  mkdirSync(dir, { recursive: true })

  for (const [n, upload] of uploads.slice(0, MOST_FILES).entries()) {
    const called = safeName(upload.name)
    let bytes: Buffer
    try {
      bytes = Buffer.from(String(upload.data ?? ''), 'base64')
    } catch {
      refused.push(`${called} did not arrive in one piece.`)
      continue
    }
    if (bytes.length === 0) {
      refused.push(`${called} is empty.`)
      continue
    }
    if (bytes.length > MOST_PER_FILE) {
      refused.push(`${called} is ${megabytes(bytes.length)}, and ${megabytes(MOST_PER_FILE)} is the most one file may be.`)
      continue
    }
    if (together + bytes.length > MOST_TOGETHER) {
      refused.push(`${called} did not fit — ${megabytes(MOST_TOGETHER)} is the most that can be attached at once.`)
      continue
    }
    together += bytes.length
    // Unique per attachment, so two files called `scan.pdf` in one message do not become one.
    const path = join(dir, `${String(at)}-${String(n)}${extname(called).slice(0, 16)}`)
    writeFileSync(path, bytes)
    kept.push({ name: called, path, bytes: bytes.length })
  }
  if (uploads.length > MOST_FILES) {
    refused.push(`Only the first ${String(MOST_FILES)} files were attached — that is the most one message may carry.`)
  }
  return { kept, refused }
}

const megabytes = (bytes: number): string => `${String(Math.max(1, Math.round(bytes / (1024 * 1024))))} MB`

/**
 * Gone the moment it has been read.
 *
 * **Never throws**, and that is load-bearing rather than tidy: this runs in the `finally` of
 * the read, so anything it threw would replace whatever actually happened to the message with
 * a complaint about a temporary file. Windows can hold a handle open for a moment after a
 * reader exits, and `force` does not cover that one.
 */
export function discard(kept: readonly Saved[]): void {
  for (const one of kept) {
    try {
      rmSync(one.path, { force: true })
    } catch {
      // It stays until the next one lands on it, which is a cost of nothing.
    }
  }
}

/** What came back for one attachment: the text of it, or the sentence saying why not. */
export interface Reading {
  name: string
  text?: string
  /** What the reader said it was, and how much of it there is. Absent when nothing read it. */
  about?: string
  refusal?: string
}

/**
 * The user's line with the documents underneath it, as one message.
 *
 * **This is the whole of what a model sees**, and it is a string, because `Message.content`
 * is a string at the store, through `trim.ts` and at the provider boundary. That is not a
 * workaround for models that cannot read a document — today it is the only thing the wire can
 * carry, for every model, including the ones that could read the file themselves.
 *
 * Two properties worth stating, because both are load-bearing:
 *
 * - **Everything here goes through `redact.ts` on the way out**, exactly as a typed sentence
 *   does, because it *is* the typed sentence. A payslip is a much larger surface than a chat
 *   turn — more of it, and skewed towards the personal — and the honest place to say so is
 *   here, next to the code, rather than after somebody notices.
 * - **A file that could not be read still appears.** Silence would leave the model answering
 *   a question about a document it was never given, with nothing to say that is what
 *   happened. The refusal is in the message, in the reader's own words.
 */
export function withDocuments(text: string, readings: readonly Reading[]): string {
  const blocks = readings.map((one) =>
    one.text === undefined ?
      `[attached: ${one.name} — not read. ${one.refusal ?? 'Nothing here could read it.'}]`
    : `[attached: ${one.name}${one.about === undefined ? '' : ` — ${one.about}`}]\n${one.text}\n[end of ${one.name}]`,
  )
  return [text.trim(), ...blocks].filter((part) => part !== '').join('\n\n')
}

/** What the shell puts under the composer: one line per attachment, in the reader's words. */
export const noteFor = (one: Reading): string =>
  one.text === undefined ?
    `${one.name} was not read. ${one.refusal ?? 'Nothing installed here reads documents.'}`
  : `Read ${one.name}${one.about === undefined ? '' : ` — ${one.about}`}.`
