// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createLooker } from './look.js'

/**
 * Look at my screen — "what does this error mean", "how do I turn this off here", "copy the text
 * in that picture" (PC-12, PC-13, PC-19).
 *
 * It depends on capabilities and never on who provides them: `computer.screenshot` for the
 * picture, `image.ocr` for the words, `vision.describe` for what is on it, `screen.draw` to
 * point. The model is the one the app lends it through sampling.
 *
 * **Nothing read off the screen is logged, and no picture is kept.**
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

/** Longer than MCP's minute: a model on this computer can take its time over a screenful. */
const SAMPLE_MS = 100_000

const looker = createLooker({
  capability: (cap, args) => alexia.capability(cap, args),
  answers: (cap) => alexia.answers(cap),
  sample: async (text, systemPrompt, signal) => {
    const answer = await alexia.server.server.createMessage(
      { messages: [{ role: 'user', content: { type: 'text', text } }], systemPrompt, maxTokens: 1500 },
      { timeout: SAMPLE_MS, ...(signal && { signal }) },
    )
    return answer.content?.type === 'text' ? answer.content.text : ''
  },
  read: (path) => readFile(path),
  unlink: (path) => unlink(path),
  warn: (message) => log.warn(message),
})

const READS = { readOnlyHint: true, openWorldHint: false }
const object = (properties, required) => fromJsonSchema({ type: 'object', properties, ...(required && { required }) })
const wholeScreen = { type: 'boolean', description: 'Look at the whole screen rather than asking about the window in front.' }

alexia.tool(
  'look',
  {
    description:
      'Look at the owner’s screen now: a description of what is on it and the text read from it, with the window in front. ' +
      'Use when they say "this", "here" or "on my screen", or ask what something on it means. Read-only.',
    inputSchema: object({
      question: { type: 'string', description: 'What they want to know about it.' },
      whole_screen: wholeScreen,
    }),
    annotations: READS,
    _meta: { 'alexia/provides': ['screen.look'] },
  },
  (args) => looker.look(args ?? {}),
)

alexia.tool(
  'help',
  {
    description:
      'Look at the owner’s screen and say how to do something on it, naming controls by their visible labels, with steps. ' +
      'Use for "how do I … here" or "what do I press". With draw, it also boxes the control for the first step when it can find it.',
    inputSchema: object(
      {
        question: { type: 'string', description: 'What they want to do or understand.' },
        draw: { type: 'boolean', description: 'Draw a box around the control for the first step. Defaults to false.' },
      },
      ['question'],
    ),
    annotations: READS,
    _meta: { 'alexia/provides': ['screen.help'] },
  },
  (args, ctx) => looker.help(args ?? {}, { signal: ctx?.mcpReq?.signal }),
)

alexia.tool(
  'text',
  {
    description:
      'Read the text on the owner’s screen, word for word, with no AI model. Use to copy text out of a picture, a video or an app that will not let it be selected. ' +
      'Give region to read one rectangle, in screen pixels. Read-only.',
    inputSchema: object({
      region: {
        type: 'object',
        description: 'One rectangle of the screen, in screen pixels from its top left.',
        properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        required: ['x', 'y', 'w', 'h'],
      },
      whole_screen: wholeScreen,
    }),
    annotations: READS,
    _meta: { 'alexia/provides': ['screen.text'] },
  },
  (args) => looker.text(args ?? {}),
)

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point (argv[1] resolved through links, as Node resolves import.meta.url). */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
