// SPDX-License-Identifier: AGPL-3.0-only
// Not a test: the capabilities, faked. A screenshot is a real PNG in a real temporary file whose
// pixels say where they are, so a reader handed any piece of it knows which piece it was given.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLooker } from '../look.js'
import { decode, encode } from '../png.js'

export const WIDTH = 1920
export const HEIGHT = 1080

/** An RGB picture where each pixel holds its own position. */
export function picture(width = WIDTH, height = HEIGHT) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3
      raw[at] = x & 255
      raw[at + 1] = y & 255
      raw[at + 2] = (x >> 8) | ((y >> 8) << 4)
    }
  }
  return encode({ width, height, depth: 8, colour: 2 }, raw)
}

/** Which rectangle of the original a piece of such a picture is. */
export function whereabouts(png) {
  const { width, height, pixels } = decode(png)
  return { x: pixels[0] | ((pixels[2] & 15) << 8), y: pixels[1] | ((pixels[2] >> 4) << 8), w: width, h: height }
}

/** The words wholly inside a piece, one per line. */
export function wordsIn(png, words) {
  const r = whereabouts(png)
  return words
    .filter((one) => one.x >= r.x && one.y >= r.y && one.x + one.w <= r.x + r.w && one.y + one.h <= r.y + r.h)
    .map((one) => one.text)
    .join('\n')
}

export const WORDS = [
  { text: 'Notifications', x: 300, y: 200, w: 140, h: 22 },
  { text: 'Turn off', x: 1500, y: 760, w: 90, h: 22 },
]

export const result = (text, structuredContent, isError) => ({
  content: [{ type: 'text', text }],
  ...(structuredContent && { structuredContent }),
  ...(isError && { isError: true }),
})

export const absent = (cap) => Object.assign(new Error(`nothing provides ${cap}`), { code: -32050 })

let full
const shot = () => (full ??= picture())

/**
 * A looker over faked capabilities. `shots` are the `structuredContent`s the screenshot answers
 * with, one after the other (the last repeats). `over` replaces a capability by name; `null`
 * means nothing provides it.
 */
export function world({ shots, over = {}, words = WORDS, reply, draws = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'screen-look-'))
  const calls = []
  const sampled = []
  const warned = []
  const paths = []
  let taken = 0
  const front = { app: 'SystemSettings', title: 'Settings', fullscreen: false, titleBar: true }
  const states = shots ?? [{ locked: false, front }]
  const provided = {
    'computer.screenshot': () => {
      const path = join(dir, `screen-${String(taken)}.png`)
      writeFileSync(path, shot())
      paths.push(path)
      const state = states[Math.min(taken, states.length - 1)]
      taken += 1
      return result(`Saved ${path}`, { path, width: WIDTH, height: HEIGHT, ...state })
    },
    'image.ocr': ({ bytes }) => {
      const text = wordsIn(Buffer.from(bytes, 'base64'), words)
      return text === '' ? result('The reader found no text in that picture.', undefined, true) : result(text)
    },
    'vision.describe': () => result('{}', { description: 'A settings window with a list of switches.' }),
    'screen.draw': ({ shapes }) => result('Drawn.', { drawn: shapes.length }),
    ...over,
  }
  const looker = createLooker({
    capability: async (cap, args) => {
      // Whether any screenshot was still on disk when each capability was asked.
      calls.push({ cap, args, kept: paths.some((path) => existsSync(path)) })
      if (!provided[cap]) throw absent(cap)
      return provided[cap](args)
    },
    answers: async (cap) => ({ answers: cap === 'screen.draw' ? draws : Boolean(provided[cap]), here: true }),
    sample: async (prompt, system) => {
      sampled.push({ prompt, system })
      if (reply instanceof Error) throw reply
      return reply ?? JSON.stringify({ answer: 'Press "Turn off".', steps: ['Press "Turn off".'], control: 'Turn off' })
    },
    read: (path) => readFile(path),
    unlink: (path) => unlink(path),
    warn: (message) => warned.push(message),
  })
  return {
    looker,
    calls,
    sampled,
    warned,
    paths,
    of: (cap) => calls.filter((call) => call.cap === cap),
    left: () => paths.filter((path) => existsSync(path)),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}
