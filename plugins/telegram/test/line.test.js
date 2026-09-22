// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { Line } from '../line.js'

/**
 * The line the poll loop hands its messages to (D192).
 *
 * The loop used to answer each message where it stood, and a permission question asked from
 * the phone deadlocked on it: the press arrives through the loop, and the loop was waiting on
 * the answer that was waiting on the press. What moved here has to keep the two things the old
 * shape gave for free — **one at a time, in the order they came** — because core runs one task
 * at a time and the chat a question goes to is one variable. And it must not stall on a bad
 * message, which the old loop got by being a loop.
 */

/** A job that runs until it is let go, so a test can hold it mid-flight. */
function held(name, ran) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const job = async () => {
    ran.push(`${name} start`)
    await gate
    ran.push(`${name} end`)
  }
  return { job, release }
}

test('jobs run in the order they came', async () => {
  const line = new Line()
  const ran = []
  const done = ['a', 'b', 'c'].map((name) =>
    line.push(async () => {
      await Promise.resolve()
      ran.push(name)
    }),
  )
  await Promise.all(done)
  expect(ran).toEqual(['a', 'b', 'c'])
})

test('one at a time: the second does not start until the first has finished', async () => {
  const line = new Line()
  const ran = []
  const one = held('one', ran)
  const two = held('two', ran)

  const first = line.push(one.job)
  const second = line.push(two.job)
  await Promise.resolve()
  expect(ran).toEqual(['one start'])
  expect(line.busy).toBe(true)
  expect(line.waiting).toBe(1)

  one.release()
  await first
  await Promise.resolve()
  expect(ran).toEqual(['one start', 'one end', 'two start'])
  expect(line.waiting).toBe(0)

  two.release()
  await expect(second).resolves.toBe(true)
  expect(ran).toEqual(['one start', 'one end', 'two start', 'two end'])
  expect(line.busy).toBe(false)
})

test('a job that throws is logged, and the ones behind it still run', async () => {
  const logged = []
  const line = new Line((error) => logged.push(error.message))
  const ran = []

  const broken = line.push(async () => {
    throw new Error('the model refused')
  })
  const sync = line.push(() => {
    throw new Error('not even async')
  })
  const fine = line.push(async () => {
    ran.push('fine')
  })

  // Settled, not rejected: the poll loop does not wait on these, and a rejection nobody
  // waits on is a crash waiting for a Node flag.
  await expect(broken).resolves.toBe(true)
  await expect(sync).resolves.toBe(true)
  await expect(fine).resolves.toBe(true)
  expect(logged).toEqual(['the model refused', 'not even async'])
  expect(ran).toEqual(['fine'])
  expect(line.busy).toBe(false)
})

test('a log that throws does not stall the line either', async () => {
  const line = new Line(() => {
    throw new Error('the log is broken')
  })
  const ran = []
  line.push(() => {
    throw new Error('first')
  })
  await line.push(async () => {
    ran.push('second')
  })
  expect(ran).toEqual(['second'])
})

test('clear drops what is waiting, and the running job finishes', async () => {
  const line = new Line()
  const ran = []
  const running = held('running', ran)

  const first = line.push(running.job)
  const dropped = [line.push(async () => ran.push('dropped a')), line.push(async () => ran.push('dropped b'))]
  await Promise.resolve()
  expect(line.waiting).toBe(2)

  expect(line.clear()).toBe(2)
  expect(line.waiting).toBe(0)
  expect(line.busy).toBe(true)
  await expect(Promise.all(dropped)).resolves.toEqual([false, false])

  running.release()
  await expect(first).resolves.toBe(true)
  expect(ran).toEqual(['running start', 'running end'])

  // And the line is not left closed behind it: the next message is answered.
  await line.push(async () => ran.push('after'))
  expect(ran.at(-1)).toBe('after')
})
