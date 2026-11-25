// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createTasks } from './tools.js'

/**
 * Tasks — the owner's to-dos and lists, with days, and reminders tied to a place or a person.
 * It is where quick captures land (`tasks.add`). There is no delete tool: done is the end.
 *
 * It depends on capabilities and never on who provides them: `context.current` to know when
 * you arrive somewhere you named, `memory.recall` to know who was just mentioned.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const tasks = createTasks({
  storage: alexia.storage,
  capability: (cap, args) => alexia.capability(cap, args),
  tz: (ms) => -new Date(ms ?? Date.now()).getTimezoneOffset(),
})

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
// It appends and closes; nothing is overwritten or removed, so it is not destructive.
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

const props = {
  text: { type: 'string', description: 'The task, as a sentence that still makes sense next month.' },
  due: { type: 'string', description: 'The day it is due, as YYYY-MM-DD only. Work out "tomorrow" or "Friday" yourself. Omit if none.' },
  list: { type: 'string', description: 'Which list: "tasks" (the default), "shopping", or any name the user uses.' },
}

alexia.tool(
  'tasks_add',
  {
    description: 'Write a task or list item down. Takes text, an optional ISO day and an optional list; returns its id.',
    inputSchema: fromJsonSchema({ type: 'object', properties: props, required: ['text'] }),
    annotations: WRITES,
    _meta: { 'alexia/provides': ['tasks.add'] },
  },
  (args) => tasks.add({ text: args?.text, due: args?.due, list: args?.list }),
)

alexia.tool(
  'add_task',
  {
    description:
      'Write a task down, optionally to be raised at a place ("when I am at the gym") or when a person comes up ' +
      '("next time I talk to Petr"). One per call, in the user’s words.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...props,
        place: { type: 'string', description: 'A place label as the owner names it, to raise this when they arrive there.' },
        person: { type: 'string', description: 'A person’s name, to raise this when that person comes up.' },
      },
      required: ['text'],
    }),
    annotations: WRITES,
  },
  (args) => tasks.add(args ?? {}),
)

alexia.tool(
  'done_task',
  {
    description: 'Mark one task done. Use when the user says they have done it. Takes its id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which task.' } },
      required: ['id'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => tasks.done(args),
)

alexia.tool(
  'tasks',
  {
    description: 'List tasks, newest first. Takes an optional list name and a state: open (the default), done or all.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Only this list.' },
        state: { type: 'string', enum: ['open', 'done', 'all'] },
      },
    }),
    annotations: RO,
  },
  (args) => tasks.tasks(args),
)

alexia.tool(
  'lists',
  { description: 'The names of the lists, with how many items are open in each. Takes no arguments.', annotations: RO },
  () => tasks.lists(),
)

alexia.tool(
  'notice_items',
  {
    description:
      'Open tasks worth raising now: those with a day within the horizon or overdue, those for a place the owner has just arrived at, ' +
      'and those for a person just mentioned. Takes `now` (epoch ms), `horizon_days` and `tz_offset_min`.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'How many days ahead counts as soon. Defaults to 7.' },
        tz_offset_min: { type: 'number', description: 'Minutes east of UTC. Defaults to 0.' },
      },
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  (args) => tasks.noticeItems(args),
)

alexia.tool(
  'notice_done',
  {
    description: 'Close the task a notice was about, when its key is `tasks:<id>` and it is still open. Any other key does nothing.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { key: { type: 'string', description: 'The notice’s key.' } },
      required: ['key'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.done'] },
  },
  (args) => tasks.noticeDone(args),
)

alexia.tool(
  'brief_section',
  {
    description: 'The tasks section of a brief: today’s due and overdue in the morning; the week’s due ones and the shopping list’s length in the weekly one.',
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
  (args) => tasks.briefSection(args),
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
