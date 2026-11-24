// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createDesk } from './desk.js'
import { CLASSES } from './triage.js'

/**
 * Mail desk — sorts new mail, watches the inbox, tracks parcels and bills.
 *
 * It reads mail only through the `mail.list` and `mail.read` capabilities, whichever account
 * provides them, and never marks, moves or deletes anything. It never logs a subject, a sender
 * or any text: log lines carry counts.
 *
 * It only starts serving when run as the entry point, so importing it (as the load test does)
 * never attaches to stdio.
 */

const alexia = plugin()

/** One question to a model, through sampling. */
async function sample(text, systemPrompt) {
  const answer = await alexia.server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text } }],
    systemPrompt,
    maxTokens: 2000,
  })
  return answer.content?.type === 'text' ? answer.content.text : ''
}

const desk = createDesk({
  capability: (cap, args) => alexia.capability(cap, args),
  sample,
  storage: alexia.storage,
  settings: () => alexia.settings(),
})

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const out = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })

alexia.tool(
  'inbox',
  {
    description:
      'Mail the desk has sorted, newest first: who it is from and why it is in its class (act, reply, wait, read_later, noise). ' +
      'Optionally only one class.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { class: { type: 'string', enum: CLASSES, description: 'Only this class.' } },
    }),
    annotations: RO,
  },
  async ({ class: klass } = {}) => {
    const rows = await desk.inbox(CLASSES.includes(klass) ? klass : undefined)
    const text = rows.length === 0 ? 'Nothing sorted yet.' : rows.map((r) => `- [${r.class}] ${r.sender}${r.reason ? `: ${r.reason}` : ''} (${r.id})`).join('\n')
    return out(text, { messages: rows })
  },
)

alexia.tool(
  'parcels',
  {
    description: 'Parcels found in shipping mail: carrier, tracking number, state and expected day. Takes no arguments.',
    annotations: RO,
  },
  async () => {
    const rows = await desk.parcels()
    const text = rows.length === 0 ? 'No parcels.' : rows.map((r) => `- ${r.carrier} ${r.number}: ${r.state}${r.eta ? `, expected ${r.eta}` : ''}${r.what ? ` (${r.what})` : ''}`).join('\n')
    return out(text, { parcels: rows })
  },
)

alexia.tool(
  'bills',
  {
    description: 'Bills and subscription renewals found in mail, with amounts and due days. Takes no arguments.',
    annotations: RO,
  },
  async () => {
    const rows = await desk.bills()
    const text = rows.length === 0 ? 'No bills.' : rows.map((r) => `- ${r.payee}: ${r.amount} ${r.currency}, ${r.recurring ? 'renews' : 'due'} ${r.due} [${r.state}] (${r.id})`).join('\n')
    return out(text, { bills: rows })
  },
)

alexia.tool(
  'bill_paid',
  {
    description: 'Mark one bill as paid, so it stops coming up. Use when the user says they have paid it. Takes the bill’s id from `bills`.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which bill.' } },
      required: ['id'],
    }),
    // It changes the desk's own list and nothing outside it.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const result = await desk.billPaid(id)
    if (!result.found) return { isError: true, content: [{ type: 'text', text: 'There is no bill with that id.' }] }
    await report()
    return out(result.already ? `${result.payee} was already paid.` : `Marked paid: ${result.payee}.`, result)
  },
)

const noticeSchema = fromJsonSchema({
  type: 'object',
  properties: {
    now: { type: 'number', description: 'Now, in epoch milliseconds.' },
    horizon_days: { type: 'number', description: 'How many days ahead counts as soon. Defaults to 7.' },
    tz_offset_min: { type: 'number', description: 'Minutes east of UTC. Defaults to 0.' },
  },
})

alexia.tool(
  'notice_items',
  {
    description:
      'Mail worth raising now (what needs the owner or a reply), parcels out for delivery or delivered, and bills and renewals coming due.',
    inputSchema: noticeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  async (args = {}) => {
    const items = await desk.noticeItems(args)
    return out(items.map((i) => `- ${i.text}`).join('\n'), { items })
  },
)

alexia.tool(
  'notice_done',
  {
    description: 'Stop raising the mail a notice was about, when its key is `mail:<id>`. Any other key does nothing.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { key: { type: 'string', description: 'The notice’s key.' } },
      required: ['key'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.done'] },
  },
  async ({ key } = {}) => {
    const result = await desk.noticeDone(key)
    return out(result.closed ? 'Closed.' : 'Nothing to close.', result)
  },
)

alexia.tool(
  'brief_section',
  {
    description:
      'The mail section of a brief. Morning: counts per class and what needs acting on. Evening: what still needs a reply. Weekly: bills and renewals of the coming week.',
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
  async (args = {}) => {
    const text = await desk.briefSection(args)
    return out(text, { title: 'Mail', text })
  },
)

/** The line at the top of the settings pane. */
async function report() {
  try {
    const { sorted, open } = await desk.counts()
    await alexia.status('status', open > 0 ? `● ${open} need you` : sorted > 0 ? '■ Nothing needs you' : '■ Nothing sorted yet')
  } catch {
    // The status line is a courtesy.
  }
}

let timer
let polling = false

async function tick() {
  if (polling) return
  polling = true
  try {
    const result = await desk.poll()
    if (result.filed > 0) log.info(`sorted ${result.filed} new messages`)
  } catch (error) {
    // The message is the error's own; mail text never reaches it.
    log.warn('could not look at the inbox', error instanceof Error ? error.message : 'unknown error')
  } finally {
    polling = false
    await report()
  }
}

async function schedule() {
  clearInterval(timer)
  const { every } = await alexia.settings()
  const minutes = [15, 30, 60].includes(Number(every)) ? Number(every) : 15
  timer = setInterval(() => void tick(), minutes * 60_000)
  timer.unref?.()
}

if (isEntry()) {
  await alexia.start()
  alexia.onSettingsChanged((changed) => {
    if ('every' in changed) void schedule().catch(() => {})
  })
  await schedule().catch(() => {})
  void tick()
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
