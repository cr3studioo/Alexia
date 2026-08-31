// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { READABLE } from './kinds.js'
import { DEFAULT_LIMIT, read } from './read.js'

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

alexia.tool(
  'extract',
  {
    description:
      'Read a document and return what it says, as markdown. Takes the path of a file — ' +
      `${READABLE}. Use whenever the user refers to a file they want read, summarised, ` +
      'searched or answered from. Tables come back as markdown tables and pages are marked. ' +
      'A picture, or a PDF that is a scan with no text layer, is refused with a sentence ' +
      'saying so rather than returning nothing.',
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
  async ({ file }) => {
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

    try {
      const found = read(path, bytes, { limit: await limit() })
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
    } catch (error) {
      // Every one of these is a sentence written to be read by the person who has to act on
      // it — which wall this is, and what would get past it.
      return refuse(String(error?.message ?? error))
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
          `Reads: ${READABLE}.\n\n` +
          'Does not read: pictures (a photograph, a screenshot, a scan), audio, video, ' +
          'archives, or a PDF whose pages are images with no text layer. Reading the words ' +
          'off a picture needs OCR and describing one needs a model that can see; neither is ' +
          'installed. It says which of the two a file would need rather than returning nothing.',
      },
    ],
  }),
)

await alexia.start()
await report()
log.info(`${alexia.manifest.name} is ready`)
