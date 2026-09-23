// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { Clock } from '../clock.js'
import { TRIES } from '../reminders.js'

/**
 * The tick that delivers reminders — and the four ways it used to eat them.
 *
 * Every failure on this path is silent and arrives hours late, which is precisely why it went
 * unnoticed through four commits and a hundred and fifty green tests: nothing reached it. These
 * are the rules, held without a database, a bot token or a real clock.
 */

/** A clock over a list of rows, with everything it touches recorded. */
function harness({ rows = [], fail = () => false, summary } = {}) {
  const log = []
  const seen = { sent: [], done: [], retried: [], summaries: [] }
  const clock = new Clock({
    due: async () => rows,
    send: async (row) => {
      seen.sent.push(row.id)
      const why = fail(row)
      if (why) throw new Error(why)
    },
    done: async (row) => void seen.done.push(row.id),
    retry: async (row, tries) => void seen.retried.push([row.id, tries]),
    summary: summary ?? (async (now) => void seen.summaries.push(now)),
    log: (message, error) => log.push(`${message}: ${String(error?.message ?? error)}`),
  })
  return { clock, seen, log }
}

const row = (id, extra = {}) => ({ id, rowid: id, text: `reminder ${String(id)}`, at: 1, ...extra })

test('every due reminder is sent, and each one is finished with', async () => {
  const { clock, seen } = harness({ rows: [row(1), row(2), row(3)] })
  expect(await clock.tick(100)).toBe(true)
  expect(seen.sent).toEqual([1, 2, 3])
  expect(seen.done).toEqual([1, 2, 3])
  expect(seen.retried).toEqual([])
})

test('a reminder that will not send is retried rather than finished with', async () => {
  const { clock, seen } = harness({ rows: [row(1)], fail: () => 'Forbidden: bot was blocked by the user' })
  await clock.tick(100)
  expect(seen.done).toEqual([])
  expect(seen.retried).toEqual([[1, 1]])
})

test('one bad reminder does not stop the ones behind it', async () => {
  // The fault this exists for: a 403 used to reject the whole tick before the row was marked,
  // so every later reminder was stuck behind it and the morning summary was never reached.
  const { clock, seen } = harness({ rows: [row(1), row(2), row(3)], fail: (r) => r.id === 1 && 'no' })
  await clock.tick(100)
  expect(seen.sent).toEqual([1, 2, 3])
  expect(seen.done).toEqual([2, 3])
  expect(seen.retried).toEqual([[1, 1]])
  expect(seen.summaries).toEqual([100])
})

test('a reminder is given up on once it runs out of tries, with one line in the log', async () => {
  const { clock, seen, log } = harness({ rows: [row(1, { tries: TRIES - 1 })], fail: () => 'gone' })
  await clock.tick(100)
  // Finished with rather than retried: there is nowhere to say it failed, because the reason
  // it failed is that its chat cannot be reached.
  expect(seen.done).toEqual([1])
  expect(seen.retried).toEqual([])
  expect(log).toHaveLength(1)
  expect(log[0]).toContain('dropped')
})

test('a storage write that fails on one row leaves the rest alone', async () => {
  const log = []
  const done = []
  const clock = new Clock({
    due: async () => [row(1), row(2)],
    send: async () => {},
    done: async (r) => {
      if (r.id === 1) throw new Error('the database is busy')
      done.push(r.id)
    },
    retry: async () => {},
    log: (message, error) => log.push(`${message}: ${String(error?.message ?? error)}`),
  })
  await clock.tick(100)
  expect(done).toEqual([2])
  expect(log).toHaveLength(1)
})

test('the two halves fail apart: unreadable rows still leave the summary to run', async () => {
  const summaries = []
  const log = []
  const clock = new Clock({
    due: async () => {
      throw new Error('the database is gone')
    },
    send: async () => {},
    done: async () => {},
    retry: async () => {},
    summary: async (now) => void summaries.push(now),
    log: (message, error) => log.push(`${message}: ${String(error?.message ?? error)}`),
  })
  expect(await clock.tick(100)).toBe(true)
  expect(summaries).toEqual([100])
  expect(log).toHaveLength(1)
})

test('a summary that throws does not cost the reminders, and never escapes the tick', async () => {
  const { clock, seen, log } = harness({
    rows: [row(1)],
    summary: async () => {
      throw new Error('commitments went away')
    },
  })
  await expect(clock.tick(100)).resolves.toBe(true)
  expect(seen.done).toEqual([1])
  expect(log).toHaveLength(1)
})

test('a second tick while the first is still sending does nothing at all', async () => {
  /**
   * The duplicate: `api.js` puts no timeout on a fetch, so a slow link means the next tick
   * reads the same rows this one has not finished sending — and the person gets the reminder
   * twice, and the morning summary twice, whose *sent today* mark is written after an await
   * like everything else.
   */
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const sent = []
  const summaries = []
  const clock = new Clock({
    due: async () => [row(1)],
    send: async (r) => {
      sent.push(r.id)
      await held
    },
    done: async () => {},
    retry: async () => {},
    summary: async (now) => void summaries.push(now),
  })

  const first = clock.tick(100)
  await Promise.resolve()
  expect(clock.busy).toBe(true)
  // The tick that arrives 30 seconds later, while this one is still waiting on Telegram.
  expect(await clock.tick(200)).toBe(false)
  expect(sent).toEqual([1])
  expect(summaries).toEqual([])

  release()
  expect(await first).toBe(true)
  expect(clock.busy).toBe(false)
  // And once it is free, the next one runs normally.
  expect(await clock.tick(300)).toBe(true)
  expect(sent).toEqual([1, 1])
  expect(summaries).toEqual([100, 300])
})

test('nothing due is a tick that ran, not one that was skipped', async () => {
  const { clock, seen } = harness({ rows: [] })
  expect(await clock.tick(100)).toBe(true)
  expect(seen.sent).toEqual([])
  expect(seen.summaries).toEqual([100])
})
