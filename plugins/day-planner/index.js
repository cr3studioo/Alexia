// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createPlanner } from './tools.js'

/**
 * Day planner — turns whatever provides `calendar.events` into a plan for the day, free time,
 * a nudge to leave, and what is known about a meeting an hour before it.
 *
 * It depends on capabilities and never on who provides them. Booking goes through
 * `calendar.create`, which is open-world: the owner's permission mode decides if it asks, and a
 * proactive run always does.
 *
 * It only starts serving when run as the entry point, so importing it (as the load test does)
 * never attaches to stdio.
 */

const alexia = plugin()

const planner = createPlanner({
  capability: (cap, args) => alexia.capability(cap, args),
  settings: () => alexia.settings(),
  status: (value) => alexia.status('standing', value),
  tz: () => -new Date().getTimezoneOffset(),
})

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

alexia.tool(
  'brief_section',
  {
    description: 'Your calendar as one section of a brief: today for the morning, tomorrow for the evening, the week ahead for the weekly one.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        kind: { type: 'string', description: '"morning", "evening" or "weekly".' },
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        tz_offset_min: { type: 'number', description: 'Minutes east of UTC.' },
      },
      required: ['kind'],
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['brief.section'] },
  },
  (args) => planner.briefSection(args),
)

alexia.tool(
  'notice_items',
  {
    description: 'When to leave for an event that has a place, and what is known about a meeting an hour before it.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'How many days ahead to look. Defaults to 1.' },
        tz_offset_min: { type: 'number', description: 'Minutes east of UTC.' },
      },
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  (args) => planner.noticeItems(args),
)

alexia.tool(
  'find_time',
  {
    description: 'Find up to three free slots in the calendar for something the user wants to fit in. Read-only; it does not book.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        what: { type: 'string', description: 'What it is for.' },
        minutes: { type: 'number', description: 'How long it takes.' },
        within_days: { type: 'number', description: 'How many days ahead to look. Defaults to 7.' },
        after: { type: 'string', description: 'Not earlier than this time of day, as HH:MM.' },
        before: { type: 'string', description: 'Finished by this time of day, as HH:MM.' },
      },
      required: ['what', 'minutes'],
    }),
    annotations: RO,
  },
  (args) => planner.findTime(args),
)

alexia.tool(
  'book_slot',
  {
    description: 'Put an event in the calendar at a slot find_time gave. Use only after the user has chosen one.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        what: { type: 'string', description: 'The event title.' },
        start: { type: 'string', description: 'The slot start, an ISO date-time as find_time returned it.' },
        minutes: { type: 'number', description: 'How long it lasts.' },
      },
      required: ['what', 'start', 'minutes'],
    }),
    // It writes to the owner's calendar through another plugin, so it is open-world.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => planner.bookSlot(args),
)

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point. argv[1] is resolved through links (a junction or symlink
 * to the plugins folder, macOS /var), because Node already resolves import.meta.url. */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
