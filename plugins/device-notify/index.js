// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { macos } from './macos.js'
import { createNotifier, MAX_BUTTONS, parseNotice, URGENCIES } from './notify.js'
import { startProcess } from './run.js'
import { windows } from './windows.js'

/**
 * Notifications — Alexia's notices as this computer's own, with up to three buttons and a
 * reply box. Where a notice goes is the hub's decision; this only shows what it is given.
 *
 * **A notice is private.** Its title, text, buttons and the answer are never logged.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const backend = { win32: windows, darwin: macos }[process.platform]
const notifier = backend && createNotifier({ backend, start: startProcess })

const refuse = (text, structuredContent) => ({
  isError: true,
  content: [{ type: 'text', text }],
  ...(structuredContent && { structuredContent }),
})

alexia.tool(
  'notify_show',
  {
    description:
      'Show a notification on this computer. With buttons or a reply box it waits up to a minute for the answer, and returns answer: null when nobody gave one.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The heading.' },
        text: { type: 'string', description: 'What it says.' },
        urgency: { type: 'string', enum: URGENCIES, description: 'urgent plays a sound. Defaults to normal.' },
        buttons: {
          type: 'array',
          maxItems: MAX_BUTTONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the button says.' },
              data: { type: 'string', description: 'What is returned when it is pressed.' },
            },
            required: ['label', 'data'],
          },
        },
        reply: { type: 'boolean', description: 'Offer a box to type a reply in.' },
        id: { type: 'string', description: 'A notification with the same id replaces the earlier one.' },
      },
      required: ['title', 'text'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // Bound only where there is a way to show something, so elsewhere the hub looks further.
    _meta: backend ? { 'alexia/provides': ['notify.show'] } : {},
  },
  async (args, ctx) => {
    if (!notifier) return refuse('I can’t show notifications on that computer.', { shown: false })
    const { notice, error } = parseNotice(args)
    if (error) return refuse(error, { shown: false })
    const { shown, answer, reason } = await notifier.show(notice, { signal: ctx?.mcpReq?.signal })
    if (!shown) {
      // `reason` is one of the helpers' own words or an error's type name, never notice text.
      log.warn(`a notification was not shown (${reason})`)
      return refuse(
        reason === 'disabled' ? 'Notifications are turned off on this computer.' : 'The notification could not be shown.',
        { shown: false },
      )
    }
    const said =
      answer === undefined ? 'Shown.'
      : answer === null ? 'Shown. Nobody answered.'
      : `Answered: ${answer.text ?? answer.data}`
    return { content: [{ type: 'text', text: said }], structuredContent: { shown, ...(answer !== undefined && { answer }) } }
  },
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
