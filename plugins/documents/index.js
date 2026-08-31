// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { kindOf, READABLE } from './kinds.js'
import { pageImages } from './pdf.js'
import { cut, DEFAULT_LIMIT, read } from './read.js'

/**
 * Reading a document, which turns out to be the same sentence as hearing one.
 *
 * `voice.transcribe` is *audio file in, text out*. This is **file in, markdown out**, and it
 * is the same shape with a different noun: core resolves it by capability name and never by
 * plugin id, a second provider offers the same name and becomes a drop-in alternative rather
 * than a competitor, and if nothing provides it the caller gets a clean `-32050` and
 * everything else keeps running.
 *
 * **This is tier 0**, and the argument for it is not accuracy — it is that it installs on a
 * cold machine. No Python, no model to download, no process to spawn, no network, and one
 * permission. A tier-2 extractor (Docling, MinerU) that reads a *scan* is a separate plugin
 * that provides the same name and is preferred when it is installed; this one says so in a
 * sentence rather than failing when it meets one.
 *
 * **What it will not do is the interesting half.** A picture is refused by kind before it is
 * opened, and a PDF with no text layer is refused after: describing a screenshot and reading
 * a photograph are two different jobs with two different answers, and an extractor that
 * quietly accepted either would return an empty string, or a handful of watermark characters,
 * and let a model answer confidently about a document nobody read.
 *
 * **And where something else can read a picture, it is asked** — `image.ocr`, by capability
 * name, so this plugin never learns who answered and works identically whether that is the
 * Windows recogniser, a Tesseract build or something nobody has written yet. Two properties
 * of that are worth stating because both are load-bearing:
 *
 * - **It is only ever tried on the path that was already a refusal.** A born-digital PDF is
 *   read the way it always was and never pays for OCR, because the text layer answered
 *   first. The cost falls exactly on the files that had no answer before.
 * - **With nothing providing it, the refusals are unchanged, word for word.** They are
 *   written in `kinds.js` and `read.js`, which know nothing about any of this and stay
 *   testable with no wire in sight. Delete the OCR plugin and this file's behaviour is what
 *   it was the day before OCR existed — which is the invariant, and there is a test for it.
 */

const alexia = plugin()

/** Big enough to be a mistake. A document this size is a database somebody renamed. */
const MOST = 80 * 1024 * 1024

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

async function limit() {
  const { max_characters: most } = await alexia.settings()
  const asked = Number(most)
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_LIMIT
}

async function report(last) {
  await alexia
    .status('state', last === undefined ? '■ Nothing read yet' : `● Last read ${last}`)
    .catch(() => {})
}

/**
 * A scan is slow enough that a page count is worth having, and forty of them is enough.
 *
 * Recognising one page takes a fraction of a second and forty takes most of a minute, which
 * is inside the two minutes core allows a tool call and close enough to it to be worth a
 * ceiling. The budget below usually stops it first; this is for the scanned book, and like
 * the budget it is **said in the text** rather than left as a silent truncation.
 */
const MOST_PAGES = 40

/**
 * `-32050`, which here means *nothing on this machine reads pictures* and nothing worse.
 *
 * It is the one rejection that has to be told apart from the others, because it is not a
 * failure: it is the ordinary state of a machine with no OCR plugin installed, and the right
 * answer to it is the sentence `kinds.js` already wrote. Every other rejection — a crash, a
 * timeout, a plugin that broke — belongs in front of the user, because something *is*
 * installed and it did not work.
 */
const NOT_AVAILABLE = -32050

/** One picture, through whatever provides `image.ocr`. Its own sentence on the way back. */
async function recognised(args) {
  const answered = await alexia.capability('image.ocr', args)
  const text = (answered.content ?? [])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  if (answered.isError === true) throw new Error(text || 'whatever reads pictures here would not say why.')
  return text
}

/**
 * The words in a picture, or in a PDF that is a picture of one — when something can read them.
 *
 * Returns `undefined` when nothing provides `image.ocr`, and the caller then says what it
 * would have said anyway. **Not an error**, because *no OCR is installed* is not a failure
 * of this call, it is the shape of the machine, and the sentence already written for it in
 * `kinds.js` is better than anything this could throw.
 */
async function viaOcr(path, bytes, limit, ctx) {
  try {
    return await ocrPath(path, bytes, limit, ctx)
  } catch (error) {
    if (error?.code === NOT_AVAILABLE) return undefined
    throw error
  }
}

async function ocrPath(path, bytes, limit, ctx) {
  const { picture } = kindOf(basename(path), bytes)

  if (picture !== undefined) {
    // The path, not the bytes: whatever answers has `fs.read_scoped` of its own and the file
    // is already sitting on disk, so base64 through a pipe would buy nothing.
    const text = await recognised({ file: path })
    return { markdown: cut(text, limit).text, kind: picture, characters: text.length, truncated: text.length > limit }
  }

  const sheets = pageImages(bytes)
  if (sheets.length === 0) return undefined
  const said = []
  let together = 0
  let read = 0

  for (const [at, sheet] of sheets.slice(0, MOST_PAGES).entries()) {
    // A scan of a book is thirty seconds of work with nothing on screen. Core streams this
    // to the panel a frame at a time, which is the difference between waiting and quitting.
    alexia.progress(ctx, at, Math.min(sheets.length, MOST_PAGES), `Reading page ${String(at + 1)}`)
    if (sheet.bytes === undefined) {
      said.push(`**page ${String(at + 1)}** — not read: ${sheet.why}`)
      continue
    }
    // The bytes, because this page was unwrapped out of the PDF and was never a file. That
    // is the whole reason `image.ocr` takes either.
    const text = await recognised({ bytes: sheet.bytes.toString('base64') })
    read += 1
    said.push(sheets.length === 1 ? text : `**page ${String(at + 1)}**\n\n${text}`)
    together += text.length
    if (together > limit) break
  }

  if (read === 0) return undefined
  const whole =
    said.join('\n\n') +
    (sheets.length > MOST_PAGES ?
      `\n\n*(the first ${String(MOST_PAGES)} pages of ${String(sheets.length)} were read — that is as many as this reads at once.)*`
    : '')
  const { text, truncated } = cut(whole, limit)
  return { markdown: text, kind: 'pdf', characters: whole.length, truncated, pages: sheets.length }
}

alexia.tool(
  'extract',
  {
    description:
      'Read a document and return what it says, as markdown. Takes the path of a file — ' +
      `${READABLE}. Use whenever the user refers to a file they want read, summarised, ` +
      'searched or answered from. Tables come back as markdown tables and pages are marked. ' +
      'A picture, or a PDF that is a scan with no text layer, is read by whatever reads ' +
      'pictures if anything here does, and otherwise refused with a sentence saying what ' +
      'would read it rather than returning nothing.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { file: { type: 'string', description: 'The path of the document to read.' } },
      required: ['file'],
    }),
    // Reading a file the user pointed at changes nothing, and saying so is what keeps the
    // default permission mode from stopping to ask about every attachment.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    // The runtime half of `provides`. Nothing has to download or warm up first, so unlike
    // the speech plugin this one can bind at registration and never move.
    _meta: { 'alexia/provides': ['document.extract'] },
  },
  async ({ file }, ctx) => {
    const path = String(file ?? '')
    if (path.trim() === '') return refuse('Which file? This needs a path.')
    let bytes
    try {
      const found = statSync(path)
      if (found.isDirectory()) return refuse(`${basename(path)} is a folder, not a document.`)
      if (found.size > MOST) {
        return refuse(
          `${basename(path)} is ${String(Math.round(found.size / (1024 * 1024)))} MB, and this reads documents rather than files that size. Nothing was read.`,
        )
      }
      bytes = readFileSync(path)
    } catch (error) {
      // ENOENT is the common one and its message is a path and an errno, which tells a
      // model nothing it can act on.
      return refuse(
        error?.code === 'ENOENT' ?
          `There is no file at ${path}.`
        : `${basename(path)} could not be opened: ${String(error?.message ?? error)}`,
      )
    }

    const most = await limit()
    let found
    try {
      found = read(path, bytes, { limit: most })
    } catch (error) {
      /**
       * The refusal path, and the only place OCR is ever reached for.
       *
       * `read` threw, so this file is a picture, a scan, or something genuinely unreadable —
       * a zip, a program, a video. Only the first two have anywhere else to go, and
       * `viaOcr` answers `undefined` for the rest and for the machine with no OCR plugin on
       * it. Either way the sentence that comes out is the one `read` wrote.
       */
      try {
        found = await viaOcr(path, bytes, most, ctx)
      } catch (second) {
        // Whatever reads pictures had its own reason and it is a better sentence than
        // *that is a picture*: it knows what it tried. The original still goes with it,
        // because *no language installed* alone does not say what file this was about.
        return refuse(`${basename(path)}: ${String(second?.message ?? second)}`)
      }
      if (found === undefined) return refuse(String(error?.message ?? error))
    }

    await report(basename(path))
    return {
      content: [{ type: 'text', text: found.markdown }],
      // The structure rides MCP's own envelope rather than a second one (D83): what came
      // out, how much of it, and whether anything was left behind.
      structuredContent: {
        name: basename(path),
        kind: found.kind,
        characters: found.characters,
        truncated: found.truncated,
        ...(found.pages !== undefined && { pages: found.pages }),
      },
    }
  },
)

alexia.tool(
  'formats',
  {
    description:
      'List the kinds of document this can read, and say what it cannot. Use when the user ' +
      'asks whether a file can be read, or after a refusal. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  () => ({
    content: [
      {
        type: 'text',
        text:
          `Reads itself: ${READABLE}.\n\n` +
          'Pictures — a photograph, a screenshot, a scan, and a PDF whose pages are images ' +
          'with no text layer — are handed to whatever reads the words in a picture, if ' +
          'anything here does. If nothing does, they are refused with a sentence saying so, ' +
          'rather than coming back empty. Either way, try it and read the answer: this tool ' +
          'cannot see what else is installed, and guessing would be worse than attempting it.\n\n' +
          'Never reads: audio, video, archives. And describing a picture — what is happening ' +
          'in this photo, what does this chart mean — is a different job from reading the ' +
          'words in it, and needs a model that can see.',
      },
    ],
  }),
)

await alexia.start()
await report()
log.info(`${alexia.manifest.name} is ready`)
