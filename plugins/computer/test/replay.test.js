// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check, DECIDE, free, MAX_STEPS, replay, STEPS } from '../replay.js'

/**
 * The two rungs below a model deciding every step (M7-6).
 *
 * The first test is the one that matters and it is a **structural** check rather than a
 * behavioural one: a script cannot bill because there is no code path from this module to a
 * model, and the way to prove that is to read the imports. The predecessor's own guarantee
 * had the same shape — `script_engine.py` never imported the gateway — and the lesson it
 * carries is that a rule the import graph enforces survives an edit a comment does not.
 */

const here = join(import.meta.dirname, '..')
const read = (name) => readFileSync(join(here, name), 'utf8')

/**
 * The file with its comments taken out.
 *
 * The check below looks for the names of things that can reach a model, and the module's own
 * documentation says several of them out loud while explaining that it does not use them. A
 * check that a comment can fail is a check somebody deletes.
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const source = code(read('replay.js'))

test('a script cannot bill, because nothing in the module can reach a model', () => {
  // One import, and it spawns PowerShell. No SDK, so no `alexia`, so no `createMessage` and
  // no `capability` — there is nowhere in this file for a model to enter.
  const imports = [...source.matchAll(/^import .*? from '([^']+)'/gm)].map((found) => found[1])
  expect(imports).toEqual(['./windows.js'])

  for (const reachable of ['@alexia/sdk', 'createMessage', 'capability(', 'sampling']) {
    expect(source, `${reachable} must not be reachable from a rung that claims to be free`).not.toContain(reachable)
  }

  // And `windows.js` is the same one step further out, so the graph has no second hop.
  const windows = code(read('windows.js'))
  expect([...windows.matchAll(/^import .*? from '([^']+)'/gm)].map((found) => found[1]).every((one) => one.startsWith('node:'))).toBe(true)
})

test('a plan with no decision in it runs with nothing to decide with', async () => {
  // The literal claim: no `ask` is passed at all. If any step needed one, this throws.
  const ran = []
  const plan = [
    { do: 'wait', ms: 0 },
    { do: 'wait', ms: 0 },
  ]
  expect(free(plan)).toBe(true)
  const done = await replay(plan, { onStep: (n, what) => ran.push(`${String(n)}:${what}`) })
  expect(done.steps).toBe(2)
  expect(ran).toEqual(['1:wait', '2:wait'])
})

test('a decision spends once, and what it answered is what the next step acts on', async () => {
  const asked = []
  const typed = []
  // `type` is a registry step, replaced here so the test does not drive a real keyboard.
  const was = STEPS.type
  STEPS.type = (step) => {
    typed.push(step.text)
    return Promise.resolve()
  }
  try {
    const plan = [
      { do: 'wait', ms: 0 },
      { do: DECIDE, id: 'name', question: 'What should it be called?' },
      { do: 'type', text: 'the file is {name}' },
      { do: 'wait', ms: 0 },
    ]
    expect(free(plan)).toBe(false)
    const done = await replay(plan, {
      ask: (question) => {
        asked.push(question)
        return 'report.txt'
      },
    })
    // Once, not once per step. That is the whole of what the middle rung is for.
    expect(asked).toEqual(['What should it be called?'])
    expect(typed).toEqual(['the file is report.txt'])
    expect(done.answers).toEqual({ name: 'report.txt' })
  } finally {
    STEPS.type = was
  }
})

test('a step that is not in the registry is refused before anything runs', async () => {
  // A plan is data somebody edits by hand. If replaying one executed arbitrary strings,
  // editing one would be writing code, and every plan would be a permission question nobody
  // could answer. The registry is the difference.
  expect(check([{ do: 'powershell', script: 'rm -rf /' }])).toContain('not something a plan can do')
  expect(check([])).toContain('no steps')
  expect(check(Array.from({ length: MAX_STEPS + 1 }, () => ({ do: 'wait' })))).toContain('is the most')

  // Refused *before* anything runs, because a sequence that half-ran and then stopped has
  // left the screen somewhere nobody planned for.
  const ran = []
  await expect(
    replay([{ do: 'wait', ms: 0 }, { do: 'powershell' }], { onStep: (n, what) => ran.push(what) }),
  ).rejects.toThrow()
  expect(ran).toEqual([])
})

test('a decision with nothing to decide with says so rather than guessing', async () => {
  await expect(replay([{ do: DECIDE, question: 'which?' }])).rejects.toThrow(/nothing was given to decide with/)
})

test('the registry holds nothing this plugin could not already do', () => {
  // "Every step is something the permission ladder already knows how to rule on" — which is
  // true exactly while the registry is a subset of what the annotated tools do.
  const index = read('index.js')
  const declared = /action: \{ type: 'string', enum: \[([^\]]+)\]/.exec(index)?.[1] ?? ''
  const actions = [...declared.matchAll(/'([a-z]+)'/g)].map((one) => one[1])
  expect(actions.length).toBeGreaterThan(0)

  // `focus` and `wait` are the two extras, and both are tools of their own — `focus` is one
  // by name, and `wait` touches nothing at all.
  expect(Object.keys(STEPS).filter((one) => !actions.includes(one)).sort()).toEqual(['focus', 'wait'])
  expect(index).toContain("'focus',")
})
