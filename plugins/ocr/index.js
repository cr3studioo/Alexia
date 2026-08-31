// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assemble } from './lines.js'
import * as win from './windows.js'

/**
 * **A picture in, the words in it out** — the tier `plugins/documents` refuses by name.
 *
 * That refusal was deliberate and this does not remove it, it answers it. `document_plan.md`
 * §4 splits *OCR* into three problems and only one of them is this: **B, a scan** — a
 * photograph of a page, a fax, a screenshot with a sentence in it. **C, describing a
 * picture** — what is happening in this photo, what does this chart show — is a different
 * job needing a model that can see, and it is still not installed. So this reads words and
 * says so, and a chart handed to it comes back as its axis labels rather than as an
 * explanation of itself. That is the honest answer and it is why this is `image.ocr` and
 * not `image.describe`.
 *
 * **It is a separate plugin from `documents` on purpose.** That one is zero dependencies,
 * one permission and no child process, and its argument is that it installs on a cold
 * machine; this one spawns PowerShell and is Windows-only. Folding them together would cost
 * the first its whole case. Delete this folder and `documents` refuses a picture in exactly
 * the words it used before this existed — which is the invariant, tested rather than hoped.
 *
 * **Where the words go is not this plugin's business.** It is handed a picture and it hands
 * back text. What put the picture there — an attachment, a page pulled out of a scanned PDF,
 * a rectangle the accessibility tree measured on screen — is the caller's question, and this
 * one cannot tell the three apart. That is what makes the same capability answer all of them.
 */

const alexia = plugin()

/**
 * Big enough that something has gone wrong. Windows will refuse anything over 10,000 pixels
 * on a side anyway; this is the cheaper refusal, before a 300 MB file is handed to a decoder.
 */
const MOST = 60 * 1024 * 1024

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const unsupported = () =>
  refuse(
    `Reading the words in a picture uses Windows' own text recognition, and this is ${process.platform}. ` +
      'Nothing was read. On this platform it would need a recogniser of its own — that is a ' +
      'second plugin offering the same thing, not a setting here.',
  )

let own
/** What Windows can read here, asked once. The list does not change while a process lives. */
let installed

async function known(signal) {
  if (installed === undefined) installed = await win.languages(signal).catch(() => [])
  return installed
}

async function report() {
  if (!win.supported()) {
    await alexia.status('state', `▲ Not available on ${process.platform} yet`).catch(() => {})
    return
  }
  const have = await known().catch(() => [])
  await alexia
    .status(
      'state',
      have.length === 0 ?
        '▲ Windows has no text-recognition language installed'
      : `● Reads ${have.map((one) => one.name).join(', ')}`,
    )
    .catch(() => {})
}

/**
 * The picture, on disk, whatever shape the caller had it in.
 *
 * Two shapes because there are two callers and they genuinely differ: `plugins/computer` has
 * a screenshot it already wrote and hands over a path, and `plugins/documents` has a page
 * pulled out of a PDF and holds it in memory. Making the second one write the file would
 * mean giving a plugin that only ever reads a permission to write, for this — which is a
 * worse trade than the six lines below.
 *
 * **The bytes do not stay**, the same way core's attachments do not: written, read, and
 * deleted in the same breath, in a `finally`, because a folder quietly accumulating pages of
 * other people's documents is a second place those documents live for no benefit.
 */
function spill(bytes) {
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  const path = join(own, `handed-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  writeFileSync(path, bytes)
  return path
}

alexia.tool(
  'read',
  {
    description:
      'Read the words in a picture and return them as text, in reading order. Takes the path ' +
      'of an image — a scan, a photograph of a page, a screenshot, a PNG or JPEG. Use when a ' +
      'file is a picture rather than a document, or after something else refused one for ' +
      'needing OCR. It reads words only: it cannot say what a photograph is of, or what a ' +
      'chart means, and for a chart it returns the axis labels rather than the point.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The path of the picture to read.' },
        bytes: {
          type: 'string',
          description:
            'The picture itself, base64 — for a caller holding one it never wrote to disk. ' +
            'Give this or file, not both.',
        },
        language: {
          type: 'string',
          description:
            'A language tag such as en-GB or cs, when the picture is not in the usual one. ' +
            'Leave it out to use the languages Windows is already set to.',
        },
      },
    }),
    // Reading a picture somebody pointed at changes nothing on the machine. Saying so is
    // what keeps the gate from stopping on every page of a scan.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    // The runtime half of `provides`. Nothing downloads and nothing warms up, so this binds
    // at registration and never moves — unlike the speech plugin, which cannot claim its
    // capability until a model has arrived.
    _meta: { 'alexia/provides': ['image.ocr'] },
  },
  async ({ file, bytes, language }, ctx) => {
    if (!win.supported()) return unsupported()
    const path = String(file ?? '').trim()
    const encoded = String(bytes ?? '')
    if (path === '' && encoded === '') return refuse('Which picture? This needs a path, or the picture itself.')
    if (path !== '' && encoded !== '') {
      return refuse('That call gave both a path and the picture itself. Send one of the two.')
    }

    let handed
    try {
      if (encoded !== '') {
        const raw = Buffer.from(encoded, 'base64')
        if (raw.length === 0) return refuse('That picture did not arrive in one piece — there were no bytes in it.')
        if (raw.length > MOST) return refuse(`That picture is ${megabytes(raw.length)}, and ${megabytes(MOST)} is the most this reads.`)
        handed = spill(raw)
      } else {
        const found = statSync(path)
        if (found.isDirectory()) return refuse(`${basename(path)} is a folder, not a picture.`)
        if (found.size > MOST) {
          return refuse(`${basename(path)} is ${megabytes(found.size)}, and ${megabytes(MOST)} is the most this reads.`)
        }
      }
    } catch (error) {
      return refuse(
        error?.code === 'ENOENT' ? `There is no file at ${path}.`
        : `${basename(path)} could not be opened: ${String(error?.message ?? error)}`,
      )
    }

    try {
      const { language: used, lines, width, height } = await win.read(handed ?? path, {
        language: String(language ?? '').trim(),
        signal: ctx?.mcpReq?.signal,
      })
      const text = assemble(lines)
      // **A picture with no words in it is not a failure and is not an empty answer.** It is
      // the commonest thing this will be handed by mistake — a photograph, a logo, a chart
      // that is all lines — and an empty string returned into a message is how a model ends
      // up answering about a document nobody read.
      if (text === '') {
        return refuse(
          'Windows found no text in that picture. Either there are no words in it, or they ' +
            'are too small or too faint to make out. Nothing was read.',
        )
      }
      await report()
      return {
        content: [{ type: 'text', text }],
        structuredContent: { language: used, lines: lines.length, characters: text.length, width, height },
      }
    } catch (error) {
      return refuse(String(error?.message ?? error))
    } finally {
      // Never throws: this runs whatever happened above, and a complaint about a temporary
      // file replacing the answer would be worse than leaving the file.
      if (handed !== undefined) {
        try {
          rmSync(handed, { force: true })
        } catch {
          // It stays until the next one lands beside it, which costs nothing.
        }
      }
    }
  },
)

alexia.tool(
  'languages',
  {
    description:
      'List the languages this machine can recognise text in. Use after a refusal that ' +
      'mentions a language, or when a picture is not in English. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    if (!win.supported()) return unsupported()
    const have = await known(ctx?.mcpReq?.signal).catch(() => [])
    return {
      content: [
        {
          type: 'text',
          text:
            have.length === 0 ?
              'Windows has no text-recognition language installed on this machine, so no picture can be read ' +
                'here yet. Settings, then Time and language, then Language and region, adds one.'
            : `${have.map((one) => `${one.name} (${one.tag})`).join('\n')}\n\n` +
              'A picture is read in whichever of these fits unless a language is asked for.',
        },
      ],
    }
  },
)

const megabytes = (bytes) => `${String(Math.max(1, Math.round(bytes / (1024 * 1024))))} MB`

await alexia.start()
own = (await alexia.host()).paths.ownDir
await report()
log.info(`${alexia.manifest.name} is ready`)
