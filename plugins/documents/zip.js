// SPDX-License-Identifier: AGPL-3.0-only
import { inflateRawSync } from 'node:zlib'

/**
 * A ZIP reader, because every office format is one.
 *
 * `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp` and `.epub` are all the same container:
 * a ZIP holding XML. One reader answers all seven, and the only thing it needs that Node
 * does not already have is the central directory — `node:zlib` has been able to inflate the
 * entries since forever.
 *
 * ponytail: no `adm-zip`, no `jszip`, no `yauzl`. This is ninety lines of offsets against a
 * format that has not changed since 1993, and the alternative is a dependency in the one
 * plugin whose entire argument is that it installs on a cold machine (§6.1).
 *
 * **What it deliberately does not do.** No encryption, no ZIP64, no spanned archives, no
 * writing. Each of those is refused by name below rather than half-supported, because a
 * reader that returns *something* for an archive it did not understand is the failure this
 * plugin exists to avoid.
 */

/** The four signatures this format is made of. */
const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const ZIP64_LOCATOR = 0x07064b50

/** Stored and deflated. Every office format uses one of the two, and usually both. */
const STORED = 0
const DEFLATED = 8

/**
 * The end-of-central-directory record, found by scanning backwards.
 *
 * It has to be scanned for rather than read at a fixed offset: the record ends with a
 * variable-length comment, so it is *near* the end rather than *at* it. 64 KB is the most a
 * comment may be, so that is how far back this looks and no further.
 */
function directoryEnd(bytes) {
  const earliest = Math.max(0, bytes.length - 0xffff - 22)
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) return at
  }
  return -1
}

/**
 * Every entry in the archive, by name, as raw bytes.
 *
 * A `Map`, so a caller asking for `word/document.xml` gets it without walking anything, and
 * so the *order* of the entries survives for the callers that need it — `ppt/slides/` is
 * read in the order the archive lists, which is the order the slides are in.
 */
export function unzip(bytes) {
  const end = directoryEnd(bytes)
  if (end === -1) throw new Error('that file is not a zip archive, or it is truncated')
  // ZIP64 puts the real offsets somewhere else entirely. Refused by name rather than read
  // wrong: a 4 GB office document is not a thing this is going to meet, and guessing at
  // one would produce entries at nonsense offsets rather than an error.
  if (end >= 20 && bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    throw new Error('that archive is zip64, which this cannot read')
  }
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)

  const files = new Map()
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new Error('that archive’s directory does not line up')
    }
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const compressed = bytes.readUInt32LE(at + 20)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const localAt = bytes.readUInt32LE(at + 42)
    // Bit 0 is the encryption flag. An encrypted entry inflates to noise, so it is named.
    if ((flags & 1) !== 0) throw new Error('that archive is password-protected')
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength

    // The name and extra fields are repeated in the local header, at *different lengths* —
    // reading them from the directory copy is the classic way to land mid-file.
    if (localAt + 30 > bytes.length || bytes.readUInt32LE(localAt) !== LOCAL_HEADER) continue
    const localName = bytes.readUInt16LE(localAt + 26)
    const localExtra = bytes.readUInt16LE(localAt + 28)
    const from = localAt + 30 + localName + localExtra
    const raw = bytes.subarray(from, from + compressed)

    if (method === STORED) files.set(name, raw)
    else if (method === DEFLATED) files.set(name, inflateRawSync(raw))
    // Anything else is one of the historical methods no office format emits. Left out of
    // the map rather than thrown for: one unreadable entry in an archive should not lose
    // the rest of the document, and a missing part is reported by whoever wanted it.
  }
  return files
}

/** Entries whose name matches, in the archive's own order. `ppt/slides/slide2.xml` before 10. */
export function within(files, pattern) {
  return [...files.keys()]
    .filter((name) => pattern.test(name))
    .sort((a, b) => numbered(a) - numbered(b) || a.localeCompare(b))
    .map((name) => ({ name, bytes: files.get(name) }))
}

/** The number in a name like `slide12.xml`, so ten sorts after nine rather than after one. */
const numbered = (name) => Number(/(\d+)\.[a-z]+$/i.exec(name)?.[1] ?? 0)
