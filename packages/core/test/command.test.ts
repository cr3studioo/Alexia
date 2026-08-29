// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { noPolling, stage } from './staged.js'

/**
 * A slash command is two different things wearing one syntax, and the gate is the difference.
 *
 * Core's own commands set a mode or a pin. A plugin's is **a tool call under a short name** —
 * the identical call the loop makes, and the identical call an action button makes, both of
 * which go through `rule()`. This one was reaching `callTool` with nothing in between.
 * Classifying the route for M6-1 is what found it: there was no sentence that made
 * `/api/command` safe, because it was not one.
 *
 * So the ruling decides, and it decides the way it does everywhere else: read-only runs,
 * *ask* comes back as a question with nothing done, and a boundary the person spoke blocks
 * with no second press.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-command-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

/**
 * Hello, with two commands added to its staged manifest.
 *
 * Declared here rather than in the plugin because they exist to be *ruled on*: one bound to
 * a tool that says it is read-only, and one bound to a name core has never heard of — which
 * the gate reads the same way it reads a tool declaring nothing, and that is the half worth
 * a test.
 */
const from = stage('hello')
const staged = join(from, 'hello', 'plugin.json')
writeFileSync(
  staged,
  JSON.stringify(
    {
      ...(JSON.parse(readFileSync(staged, 'utf8')) as Record<string, unknown>),
      commands: [
        { name: 'greeted', summary: 'How many people have been greeted' },
        { name: 'mystery', summary: 'Bound to a tool that does not exist' },
      ],
    },
    null,
    2,
  ),
)

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets: memorySecrets(),
})

afterAll(async () => {
  await alexia.close()
  for (const path of [from, root]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

interface Ran {
  ok: boolean
  note: string
  ask?: string
  setup: { mode: string }
}

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

const say = async (input: string, approved?: boolean): Promise<Ran> =>
  (await post('/api/command', { input, ...(approved === true && { approved: true }) })) as unknown as Ran

const mode = (chosen: string): Promise<unknown> => post('/api/permissions', { mode: chosen })

test('a command of core’s own is a setting, and nothing asks about a setting', async () => {
  const ran = await say('/local')
  expect(ran.ok).toBe(true)
  expect(ran.ask).toBeUndefined()
  expect(ran.setup.mode).toBe('local')
})

test('a plugin’s command is a tool call, and a read-only one runs', async () => {
  await post('/api/plugin', { id: 'hello', action: 'enable' })

  // The default mode. `greeted` declares `readOnlyHint`, so the ruling is *run* and the
  // person gets the answer rather than a question about counting something.
  const ran = await say('/greeted')
  expect(ran.ask).toBeUndefined()
  expect(ran.ok).toBe(true)
  expect(ran.note).toBe('0')
}, 20_000)

test('a command bound to a tool core has never heard of is asked about, not run', async () => {
  // Silence is not a claim of safety. A tool nobody declared reads exactly like a tool that
  // declared nothing: not safe until something says so.
  const ran = await say('/mystery')
  expect(ran.ok).toBe(false)
  expect(ran.ask).toContain('mystery')
})

test('in Ask me every time, the same command comes back as a question with nothing done', async () => {
  await mode('every-time')

  const asked = await say('/greeted')
  expect(asked.ok).toBe(false)
  // A question, not a refusal: the shell puts it to the person and sends the command back.
  expect(asked.ask).toContain('greeted')

  const then = await say('/greeted', true)
  expect(then.ok).toBe(true)
  expect(then.ask).toBeUndefined()

  await mode('risky')
})

test('a boundary the person spoke blocks a command, and there is no second press', async () => {
  alexia.store.kvSet(CORE, 'boundaries', [{ said: 'don’t touch anything', blocks: 'everything', at: Date.now() }])

  const stopped = await say('/greeted')
  expect(stopped.ok).toBe(false)
  // Their sentence, quoted back, so the thing to lift is unmistakable.
  expect(stopped.note).toContain('don’t touch anything')
  // `blocked` has no appeal, which is the difference between a question and a floor.
  expect(stopped.ask).toBeUndefined()

  // And saying yes does not get past it either: `approved` answers a question, and a
  // boundary never asked one.
  expect((await say('/greeted', true)).ok).toBe(false)

  alexia.store.kvSet(CORE, 'boundaries', [])
})

test('a command nothing declares is still the router’s own sentence', async () => {
  const ran = await say('/nonsense')
  expect(ran.ok).toBe(false)
  expect(ran.note).toContain('there is no /nonsense')
})
