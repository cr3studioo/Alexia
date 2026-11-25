// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createStudy } from './tools.js'

/**
 * Study desk: notes from a lecture or meeting recording, and study sessions over those notes.
 *
 * It depends on capabilities and never on who provides them: `voice.transcribe` for the words,
 * the owner's opened folders for reading the recording and saving the notes. The model is the
 * one the app lends it through sampling.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const study = createStudy({
  storage: alexia.storage,
  capability: (cap, args) => alexia.capability(cap, args),
  answers: (cap) => alexia.answers(cap),
  settings: () => alexia.settings(),
  roots: async () => (await alexia.server.server.listRoots()).roots,
  sample: async (text, systemPrompt, maxTokens) => {
    const answer = await alexia.server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text } }],
      systemPrompt,
      maxTokens,
    })
    return answer.content?.type === 'text' ? answer.content.text : ''
  },
  tz: (ms) => -new Date(ms ?? Date.now()).getTimezoneOffset(),
})

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const object = (properties, required) => fromJsonSchema({ type: 'object', properties, ...(required && { required }) })

alexia.tool(
  'lecture_notes',
  {
    description:
      'Turn a lecture or meeting recording into notes: a summary with key points, terms and open questions, and the transcript, saved as a new Markdown file in the notes folder. ' +
      'Never overwrites a file. Takes the recording path, an optional title and an optional course.',
    inputSchema: object(
      {
        path: { type: 'string', description: 'The path of the recording.' },
        title: { type: 'string', description: 'A title for the notes. Defaults to the recording’s name.' },
        course: { type: 'string', description: 'The course or subject, if any.' },
      },
      ['path'],
    ),
    annotations: WRITES,
  },
  (args) => study.lectureNotes(args ?? {}),
)

alexia.tool(
  'study',
  {
    description:
      'Start or continue a study session. Returns the next cards to ask, with their answers; ask them one at a time, judge the owner’s answer, and call answer_card for each. ' +
      'Takes an optional course, the minutes they have, and an optional document to draw questions from.',
    inputSchema: object({
      course: { type: 'string', description: 'Only this course.' },
      minutes: { type: 'number', description: 'How long they have; about one card a minute. Defaults to 10.' },
      document: { type: 'string', description: 'The path of a document in their library to make questions from.' },
    }),
    annotations: RO,
  },
  (args) => study.study(args ?? {}),
)

alexia.tool(
  'answer_card',
  {
    description: 'Record how a study card went. Right moves it up a box and spaces it further out; wrong brings it back tomorrow.',
    inputSchema: object(
      { id: { type: 'string', description: 'The card’s id.' }, right: { type: 'boolean', description: 'Whether the owner answered it right.' } },
      ['id', 'right'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => study.answerCard(args ?? {}),
)

alexia.tool(
  'exam',
  {
    description: 'Note an exam date for a course, so reviews are offered in the days before. The day is YYYY-MM-DD; work out "next Friday" yourself.',
    inputSchema: object(
      { course: { type: 'string', description: 'The course.' }, day: { type: 'string', description: 'The day, as YYYY-MM-DD.' } },
      ['course', 'day'],
    ),
    annotations: WRITES,
  },
  (args) => study.exam(args ?? {}),
)

alexia.tool('exams', { description: 'The exams coming up. Takes no arguments.', annotations: RO }, () => study.exams())

alexia.tool(
  'notice_items',
  {
    description:
      'Study cards due today, and exams within 14 days. Takes `now` (epoch ms), `horizon_days` and `tz_offset_min`.',
    inputSchema: object({
      now: { type: 'number', description: 'Now, in epoch milliseconds.' },
      horizon_days: { type: 'number', description: 'Ignored; exams are looked for 14 days ahead.' },
      tz_offset_min: { type: 'number', description: 'Minutes east of UTC. Defaults to 0.' },
    }),
    annotations: RO,
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  (args) => study.noticeItems(args ?? {}),
)

alexia.tool(
  'notice_done',
  {
    description: 'Close the exam a notice was about, when its key is `study:exam:<id>`. Any other key does nothing.',
    inputSchema: object({ key: { type: 'string', description: 'The notice’s key.' } }, ['key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.done'] },
  },
  (args) => study.noticeDone(args ?? {}),
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
