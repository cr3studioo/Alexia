// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Store, type Outcome, type Source } from '../src/store.js'

/**
 * `model_plan.md` §4 J's acceptance: **a report carries only the listed fields** — per model per
 * provider by week: tries, answers, failures by kind, and *Bad answer* presses. No prompts, answers,
 * keys, names or times of day (D160). Sharing it is decided later, so nothing calls it yet.
 */

const at = (iso: string): number => Date.parse(iso)

test('a report is counts per model per provider by week, and nothing else', () => {
  const store = new Store(':memory:')
  // Everything a report must never carry, written where a careless report could find it.
  const session = store.createSession('Plans for Anna')
  store.append(session, { role: 'user', content: 'what should I tell Anna tomorrow' })
  store.append(session, { role: 'assistant', model: 'vendor/a', provider: 'stub', content: 'tell her the truth' })
  store.kvSet('core', 'secret', 'sk-live-do-not-share')
  store.recordUsage({ session, model: 'vendor/a', provider: 'stub', tokensIn: 10, tokensOut: 10, cost: 0 })

  const tried = (when: string, model: string, provider: string, outcome: Outcome, source: Source = 'chat', status = 200): void =>
    store.recordTry({ at: at(when), provider, model, outcome, status, source })
  // Before `since`: not reported.
  tried('2026-09-01T09:00:00Z', 'vendor/a', 'stub', 'answered')
  // The week of Monday 7 September.
  tried('2026-09-10T08:15:00Z', 'vendor/a', 'stub', 'answered')
  tried('2026-09-13T23:59:59Z', 'vendor/a', 'stub', 'busy', 'plugin', 429)
  // The week of Monday 14 September, from its first second.
  tried('2026-09-14T00:00:00Z', 'vendor/a', 'stub', 'answered', 'test')
  tried('2026-09-17T12:34:56Z', 'vendor/a', 'stub', 'answered')
  tried('2026-09-17T12:35:10Z', 'vendor/a', 'stub', 'empty')
  tried('2026-09-17T12:35:30Z', 'vendor/a', 'stub', 'empty')
  tried('2026-09-17T12:36:00Z', 'vendor/a', 'stub', 'bad-answer', 'person', 0)
  // The same model on another provider is its own row.
  tried('2026-09-17T13:00:00Z', 'vendor/a', 'other', 'retired', 'chat', 404)

  const report = store.report(at('2026-09-07T00:00:00Z'))
  expect(report).toEqual([
    { week: '2026-09-07', provider: 'stub', model: 'vendor/a', tries: 2, answers: 1, failures: { busy: 1 }, badAnswers: 0 },
    { week: '2026-09-14', provider: 'stub', model: 'vendor/a', tries: 4, answers: 2, failures: { empty: 2 }, badAnswers: 1 },
    { week: '2026-09-14', provider: 'other', model: 'vendor/a', tries: 1, answers: 0, failures: { retired: 1 }, badAnswers: 0 },
  ])

  // Exactly the listed fields on every row, and failures keyed only by kinds of failure.
  const kinds: readonly string[] = ['busy', 'failed', 'slow', 'empty', 'cut', 'retired', 'needs-key', 'no-credit', 'key-refused', 'too-long', 'unreachable']
  for (const row of report) {
    expect(Object.keys(row).sort()).toEqual(['answers', 'badAnswers', 'failures', 'model', 'provider', 'tries', 'week'])
    expect(Object.keys(row.failures).every((kind) => kinds.includes(kind))).toBe(true)
    // A week is a date, never a time.
    expect(row.week).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${row.week}T00:00:00Z`).getUTCDay()).toBe(1)
  }
  const sent = JSON.stringify(report)
  for (const never of ['Anna', 'truth', 'sk-live', 'status', 'source', 'chat', 'plugin', 'person', '12:3', '00Z', '1789']) {
    expect(sent).not.toContain(never)
  }
  store.close()
})

test('nothing calls the report and nothing sends it', () => {
  // Sharing is decided later (D160), and would change Alexia.md in two places. This is the line to
  // change on purpose when it is.
  const callers: string[] = []
  for (const dir of [join(import.meta.dirname, '..', 'src'), join(import.meta.dirname, '..', '..', 'ui', 'src')]) {
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.(ts|js)$/.test(name)) continue
      if (/\.report\(/.test(readFileSync(join(dir, name), 'utf8'))) callers.push(name)
    }
  }
  expect(callers).toEqual([])
})
