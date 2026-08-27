// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Step } from '../src/agent.js'
import {
  asRuling,
  counted,
  freshTally,
  givenUp,
  GIVE_UP,
  QUESTIONS,
  readAnswers,
  type Tally,
} from '../src/checker.js'
import type { Scope } from '../src/permissions.js'

// The checker is allowed to be wrong. What it is not allowed to be is silently permissive,
// or endlessly obstructive — so those two are what these test.

const step: Step = { n: 1, name: 'notes__delete', args: { path: join(homedir(), 'work', 'a.txt') } }
const scope: Scope = { mode: 'watch', roots: [join(homedir(), 'work')], dataDir: join(homedir(), 'Alexia') }

test('every question is closed, and yes is always the alarming answer', () => {
  // The rule the whole file rests on: a small model answers yes/no well and opinions badly.
  for (const question of QUESTIONS) {
    expect(question.startsWith('Does this')).toBe(true)
    expect(question.endsWith('?')).toBe(true)
  }
  // Phrased so a model that says yes to everything fails safe rather than waving it through.
  expect(readAnswers('1. YES\n2. YES\n3. YES').flagged).toBe(true)
  expect(readAnswers('1. NO\n2. NO\n3. NO').flagged).toBe(false)
})

test('an answer that cannot be read is not a no', () => {
  // The failure that would make this decoration: a model rambles, and silence reads as
  // approval. It does not.
  expect(readAnswers('I think this is probably fine!').flagged).toBe(true)
  expect(readAnswers('1. NO\n2. NO').flagged).toBe(true)
  expect(readAnswers('').flagged).toBe(true)
  expect(readAnswers('1. NO\n2. NO\n3. maybe?').why).toContain('could not answer clearly')
})

test('the flagged question is the sentence the user gets, not a score', () => {
  const review = readAnswers('1. NO\n2. YES\n3. NO')
  expect(review.flagged).toBe(true)
  expect(review.why).toBe(QUESTIONS[1])
})

test('a flag asks; it never blocks outright', () => {
  // A model can be wrong, so it gets to interrupt and not to refuse. Blocking with no appeal
  // belongs to the never-touch list and to sentences the user said themselves.
  const ruling = asRuling({ flagged: true, why: 'it deletes things' }, step, freshTally())
  expect(ruling.verdict).toBe('ask')
  expect(ruling.verdict === 'ask' && ruling.why).toContain('notes__delete')
})

test('no checker at all is a question for the user, not a quiet yes', () => {
  const ruling = asRuling({ flagged: false, unavailable: true, why: 'no local model' }, step, freshTally())
  expect(ruling.verdict).toBe('ask')
  expect(ruling.verdict === 'ask' && ruling.why).toContain('could not be checked')
})

test('three blocks in a row and it gets out of the way', () => {
  let tally: Tally = freshTally()
  for (let i = 0; i < GIVE_UP.inARow; i++) tally = counted(tally, { flagged: true })
  expect(givenUp(tally)).toBe(true)

  // And it says so rather than continuing to look like a working checker.
  const ruling = asRuling({ flagged: true }, step, tally)
  expect(ruling.verdict === 'ask' && ruling.why).toContain('stopped agreeing with itself')
})

test('anything it lets through resets the streak, but not the session count', () => {
  let tally: Tally = freshTally()
  tally = counted(tally, { flagged: true })
  tally = counted(tally, { flagged: true })
  expect(tally).toEqual({ inARow: 2, inASession: 2 })

  tally = counted(tally, { flagged: false })
  expect(tally).toEqual({ inARow: 0, inASession: 2 })
  expect(givenUp(tally)).toBe(false)
})

test('twenty in a session is enough even with no streak', () => {
  let tally: Tally = freshTally()
  for (let i = 0; i < GIVE_UP.inASession; i++) {
    tally = counted(tally, { flagged: true })
    tally = counted(tally, { flagged: false })
  }
  expect(tally.inARow).toBe(0)
  expect(givenUp(tally)).toBe(true)
  expect(asRuling({ flagged: false }, step, tally).verdict).toBe('ask')
})

test('a clean review runs, which is the case that has to stay cheap', () => {
  expect(asRuling({ flagged: false }, step, freshTally())).toEqual({ verdict: 'run' })
  expect(scope.mode).toBe('watch')
})
