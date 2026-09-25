// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { askJev, gate, pressReaches, readAnswer, readText, request, risky, SURE_RISKY, table, valid } from '../decide.js'
import { runTask } from '../task.js'

const rows = [
  { name: 'Untitled - Notepad', type: 'Window', id: '', x: 400, y: 300, off: false },
  { name: 'Save As…', type: 'MenuItem', id: '', x: 40, y: 60, off: false },
  { name: 'Save', type: 'MenuItem', id: '', x: 40, y: 40, off: false },
  { name: 'Status', type: 'Text', id: '', x: 10, y: 590, off: false },
  { name: 'File name', type: 'Edit', id: 'FileName', x: 300, y: 500, off: false },
  { name: 'Hidden', type: 'Button', id: '', x: null, y: null, off: true },
]

/** An answer that picks `choice` with probability `p`, the rest shared out. */
const answer = (options, choice, p) => {
  const rest = (1 - p) / (options.length - 1)
  const probabilities = Object.fromEntries(options.map((one) => [one, one === choice ? p : rest]))
  return { type: 'choice', choice, probabilities, confidence: (options.length * p - 1) / (options.length - 1) }
}

describe('table', () => {
  it('offers only controls a person could use, numbered in order', () => {
    const list = table(rows)
    expect(list.map((row) => row.name)).toEqual(['Save As…', 'Save', 'File name'])
    expect(list.map((row) => row.index)).toEqual(['1', '2', '3'])
    expect(list[2].editable).toBe(true)
  })
})

describe('pressReaches', () => {
  it('knows that pressing “Save” by name would reach “Save As…” first', () => {
    const list = table(rows)
    expect(pressReaches(rows, list[0])).toBe(true)
    expect(pressReaches(rows, list[1])).toBe(false)
  })
})

describe('request', () => {
  it('asks the operation and a target per operation in one request, and never sends typed text', () => {
    const body = request({ goal: 'Save it', window: 'Notepad', rows: table(rows), history: [{ operation: 'TYPE', name: 'File name', text: 'secret words' }] })
    expect(Object.keys(body.questions)).toEqual(['operation', 'press_target', 'type_target'])
    expect(Object.keys(body.questions.type_target.criteria)).toEqual(['3'])
    expect(JSON.stringify(body)).not.toContain('secret words')
  })
})

describe('valid and readAnswer', () => {
  it('refuses a choice that was never offered', () => {
    expect(valid({ choice: '9', probabilities: { 1: 1 }, confidence: 1 }, ['1'])).toBe(false)
  })

  it('reads only the target of the operation that won', () => {
    const list = table(rows)
    const body = request({ goal: 'Save it', window: 'Notepad', rows: list, history: [] })
    const ops = Object.keys(body.questions.operation.criteria)
    const decision = readAnswer(
      {
        model: 'jev-1.13.0',
        answers: {
          operation: answer(ops, 'PRESS', 0.9),
          press_target: answer(Object.keys(body.questions.press_target.criteria), '2', 0.9),
          type_target: { garbage: true },
        },
      },
      body,
      list,
    )
    expect(decision.operation).toBe('PRESS')
    expect(decision.row.name).toBe('Save')
  })
})

describe('gate', () => {
  const row = (name) => ({ name, type: 'Button' })
  it('acts when sure, and hands back when not', () => {
    expect(gate({ operation: 'PRESS', confidence: 0.9, row: row('Next'), targetConfidence: 0.7 })).toBeUndefined()
    expect(gate({ operation: 'PRESS', confidence: 0.3, row: row('Next'), targetConfidence: 0.9 })).toMatch(/not sure/)
  })
  it('asks for more certainty before anything that sends, deletes or pays', () => {
    expect(risky('Odeslat')).toBe(true)
    expect(risky('Sender settings')).toBe(false)
    expect(gate({ operation: 'PRESS', confidence: 0.9, row: row('Send'), targetConfidence: 0.7 })).toMatch(/commits something/)
    expect(gate({ operation: 'PRESS', confidence: 0.9, row: row('Send'), targetConfidence: SURE_RISKY })).toBeUndefined()
  })
})

describe('readText', () => {
  it('takes exactly one text value, and nothing else', () => {
    expect(readText('{"text": "report.txt"}')).toBe('report.txt')
    expect(readText('```json\n{"text": "a"}\n```')).toBe('a')
    expect(readText('{"text": null}')).toBeUndefined()
    expect(readText('sure, here you go')).toBeUndefined()
  })
})

describe('askJev', () => {
  it('says the key was refused rather than a status number', async () => {
    const fetch = async () => ({ ok: false, status: 401 })
    await expect(askJev({ key: 'k', body: {}, fetch })).rejects.toThrow(/refused the key/)
  })
})

describe('runTask', () => {
  /** A screen that changes when Save is pressed, and a Jev that presses Save then says done. */
  function world({ sure = 0.9 } = {}) {
    let saved = false
    const did = []
    return {
      did,
      io: {
        look: async () => (saved ? [...rows, { name: 'Saved', type: 'Button', id: '', x: 5, y: 5, off: false }] : rows),
        decide: async (body) => {
          const ops = Object.keys(body.questions.operation.criteria)
          if (saved) return { answers: { operation: answer(ops, 'DONE', 0.95) } }
          const press = Object.keys(body.questions.press_target.criteria)
          return { answers: { operation: answer(ops, 'PRESS', 0.95), press_target: answer(press, '2', sure) } }
        },
        press: async (row) => {
          did.push(`press ${row.name}`)
          saved = true
          return { found: true, how: 'invoke' }
        },
        click: async (row) => {
          did.push(`click ${row.name}`)
          saved = true
        },
        type: async () => {},
        write: async () => undefined,
        note: async (step) => did.push(`note ${step.how}`),
      },
    }
  }

  it('clicks the chosen row when pressing by name would reach a different one, then stops at done', async () => {
    const { io, did } = world()
    const done = await runTask('Save it', io)
    expect(done.outcome).toBe('done')
    expect(did).toEqual(['click Save', 'note click'])
  })

  it('hands back without touching anything when Jev is unsure', async () => {
    const { io, did } = world({ sure: 0.55 })
    const done = await runTask('Save it', io)
    expect(done.outcome).toBe('handback')
    expect(did).toEqual([])
    expect(done.rows.length).toBeGreaterThan(0)
  })

  it('stops when actions stop changing the screen', async () => {
    const { io } = world()
    io.click = async () => {}
    const done = await runTask('Save it', io)
    expect(done.outcome).toBe('handback')
    expect(done.said).toMatch(/changed nothing/)
    expect(done.steps.length).toBe(3)
  })
})
