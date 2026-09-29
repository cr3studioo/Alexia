// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  byRole,
  commits,
  askJev,
  clearly,
  askLaya,
  enough,
  exact,
  forLaya,
  groundRequest,
  jevCost,
  onJevScale,
  pressReaches,
  readChoice,
  readSteps,
  risky,
  shortlist,
  SURE_RISKY,
  table,
  valid,
} from '../decide.js'

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

describe('shortlist and exact', () => {
  const many = table([
    ...Array.from({ length: 40 }, (_, n) => ({ name: `Toolbar ${String(n)}`, type: 'Button', x: n, y: 1 })),
    { name: 'Export as PDF…', type: 'MenuItem', x: 5, y: 5 },
    { name: 'Search', type: 'TextField', x: 9, y: 9 },
  ])

  it('puts the control a step names first, however deep in the tree it was', () => {
    expect(shortlist(many, { do: 'press', target: 'Export as PDF' })[0].name).toBe('Export as PDF…')
    expect(shortlist(many, { do: 'type', target: 'the search box' })[0].name).toBe('Search')
  })

  it('keeps every row’s own number, so pressing by name still means that row', () => {
    const first = shortlist(many, { do: 'press', target: 'Export as PDF' })[0]
    expect(first.index).toBe('41')
  })

  it('answers without a model only when exactly one control is called that', () => {
    const list = table(rows)
    expect(exact(list, { do: 'press', target: 'save' })?.name).toBe('Save')
    expect(exact(list, { do: 'type', target: 'Save' })).toBeUndefined()
    expect(exact(table([...rows, { name: 'Save', type: 'Button', x: 1, y: 1 }]), { do: 'press', target: 'Save' })).toBeUndefined()
  })
})

describe('readSteps', () => {
  it('takes steps in the contract and drops everything else', () => {
    const plan = readSteps(
      '```json\n{"steps": [{"do": "press", "target": "Save"}, {"do": "rm", "target": "/"}, {"do": "type", "target": "File name", "text": "a.txt", "expect": "Saved"}, {"do": "type", "target": "x"}]}\n```',
    )
    expect(plan).toEqual([
      { do: 'press', target: 'Save' },
      { do: 'type', target: 'File name', text: 'a.txt', expect: 'Saved' },
    ])
  })

  it('takes an array as it is, keeps read and answer, and nothing for prose', () => {
    expect(readSteps([{ do: 'read', target: 'the first video', as: 'title' }, { do: 'answer', text: 'It is {title}.' }, { do: 'read' }])).toEqual([
      { do: 'read', target: 'the first video', as: 'title' },
      { do: 'answer', text: 'It is {title}.' },
    ])
    expect(readSteps('sure, I will press Save')).toBeUndefined()
    expect(readSteps([])).toBeUndefined()
  })
})

describe('grounding answers', () => {
  it('refuses a choice that was never offered', () => {
    expect(valid({ choice: '9', probabilities: { 1: 1 }, confidence: 1 }, ['1'])).toBe(false)
  })

  it('reads the chosen row and how sure', () => {
    const list = table(rows)
    const body = groundRequest({ goal: 'Save it', window: 'Notepad', step: { do: 'press', target: 'Save' }, rows: list })
    const choice = readChoice({ answers: { target: answer(Object.keys(body.questions.target.criteria), '2', 0.9) } }, body, list, 'Laya')
    expect(choice.row.name).toBe('Save')
    expect(enough(choice)).toBe(true)
  })

  it('asks for more certainty before anything that sends, deletes or pays', () => {
    expect(risky('Odeslat')).toBe(true)
    expect(risky('Sender settings')).toBe(false)
    expect(enough({ row: { name: 'Send' }, sure: 0.7 })).toBe(false)
    expect(enough({ row: { name: 'Send' }, sure: SURE_RISKY })).toBe(true)
    expect(enough({ row: { name: 'Next' }, sure: 0.7 })).toBe(true)
  })
})

describe('spending', () => {
  it('prices Jev by its own usage', () => {
    expect(jevCost({ usage: { input_tokens: 1_000_000 } }, {})).toBeCloseTo(0.042)
  })
})

describe('Laya on the wire', () => {
  const body = () => groundRequest({ goal: 'Save it', window: 'Notepad', step: { do: 'press', target: 'Save' }, rows: table(rows) })

  it('sends instructions as text, options without their numbers, and the checkpoint asked for', () => {
    const sent = forLaya(body(), 'typed-decisions')
    expect(sent.model).toBe('typed-decisions')
    expect(typeof sent.questions.target.instructions).toBe('string')
    expect(sent.questions.target.instructions).toMatch(/goal: Save it/)
    expect(sent.questions.target.criteria['2']).toBe('MenuItem “Save”')
    expect(forLaya(body(), 'auto').model).toBeUndefined()
  })

  it('puts Laya’s confidence on Jev’s scale, so the same thresholds mean the same thing', () => {
    expect(onJevScale({ choice: 'a', probabilities: { a: 0.9, b: 0.05, c: 0.05 }, confidence: 0.6 }).confidence).toBeCloseTo(0.85)
    expect(onJevScale({ choice: 'a', probabilities: { a: 1 }, confidence: 0 }).confidence).toBe(1)
  })

  it('asks laya-serve on this machine and names the checkpoint that answered', async () => {
    const sentTo = []
    const fetch = async (url, init) => {
      sentTo.push(url)
      const asked = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ model: 'typed-decisions', answers: { target: answer(Object.keys(asked.questions.target.criteria), '2', 0.9) } }) }
    }
    const result = await askLaya({ address: 'http://127.0.0.1:8000/', body: body(), fetch })
    expect(sentTo).toEqual(['http://127.0.0.1:8000/v1/systemone'])
    expect(result.model).toBe('laya typed-decisions')
  })

  it('says Laya is not running rather than failing quietly', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(askLaya({ body: body(), fetch })).rejects.toThrow(/not answering.*laya-serve/)
  })

  it('says a refused TypeSafe key rather than a status number', async () => {
    const fetch = async () => ({ ok: false, status: 401 })
    await expect(askJev({ key: 'k', body: {}, fetch })).rejects.toThrow(/refused the key/)
  })
})

describe('words alone, when they are plain enough', () => {
  const rows = table([
    { name: 'like this video along with 3,655,423 other people', type: 'Button', x: 1, y: 1 },
    { name: 'Dislike this video', type: 'Button', x: 2, y: 2 },
    { name: 'Share', type: 'Button', x: 3, y: 3 },
  ])

  it('takes a whole word over the same letters inside a longer one', () => {
    expect(clearly(rows, { do: 'press', target: 'Like' })?.name).toMatch(/^like this video/)
    expect(shortlist(rows, { do: 'press', target: 'Like' })[0].name).toMatch(/^like this video/)
  })

  it('leaves it to a model when two controls answer as well as each other', () => {
    expect(clearly(rows, { do: 'press', target: 'this video' })).toBeUndefined()
  })

  it('never acts on words alone for something that commits', () => {
    const sending = table([
      { name: 'Send now', type: 'Button', x: 1, y: 1 },
      { name: 'Cancel', type: 'Button', x: 2, y: 2 },
    ])
    expect(clearly(sending, { do: 'press', target: 'Send' })).toBeUndefined()
  })
})

describe('whole plans', () => {
  it('keeps pages and apps to open, and the words for a person', () => {
    const plan = readSteps([
      { do: 'open_url', url: 'https://example.com/results?q=a', say: 'Search', expect: 'Filters' },
      { do: 'open_app', name: 'Calculator' },
      { do: 'open_url', url: 'javascript:alert(1)' },
    ])
    expect(plan).toEqual([
      { do: 'open_url', url: 'https://example.com/results?q=a', say: 'Search', expect: 'Filters' },
      { do: 'open_app', name: 'Calculator' },
    ])
  })

  it('knows a plan that commits something from one that only looks', () => {
    expect(commits([{ do: 'press', target: 'Send' }])).toBe(true)
    expect(commits([{ do: 'type', target: 'the message box', text: 'hi' }, { do: 'key', keys: 'enter' }])).toBe(true)
    expect(commits([{ do: 'type', target: 'the search box', text: 'hi' }, { do: 'key', keys: 'enter' }])).toBe(false)
    expect(commits([{ do: 'open_url', url: 'https://youtube.com' }, { do: 'read', target: 'the first video' }])).toBe(false)
  })
})

describe('byRole: a control found by what it is', () => {
  // Recorded from a YouTube channel page in Comet, session 96.
  const page = table(
    [
      ['Search', 'ComboBox', 555, 187, true],
      ['Search', 'Button', 863, 187, true],
      ['Address and search bar', 'TextField', 400, 97, false],
      ['YouTube Home', 'Link', 118, 187, true],
      ['Latest', 'Tab', 347, 687, true],
      ['Popular', 'Tab', 423, 687, true],
      ['34:23', 'Link', 482, 831, true],
      ['Last Cheater Standing Wins $10,000! 34 minutes', 'Link', 417, 947, true],
      ['25:20', 'Link', 848, 831, true],
      ['I Outsmarted Pro Car Thieves 25 minutes', 'Link', 791, 947, true],
      ['Mark Rober', 'Link', 111, 400, true],
    ].map(([name, type, x, y, web]) => ({ name, type, x, y, web, id: '', off: false })),
  )

  it('finds the page’s own search box, not the browser’s', () => {
    expect(byRole(page, { do: 'type', target: 'the search box' })).toMatchObject({ name: 'Search', type: 'ComboBox' })
    expect(byRole(page, { do: 'type', target: 'the browser address bar' })?.name).toBe('Address and search bar')
  })

  it('reads the first, newest and second item in reading order, skipping durations', () => {
    expect(byRole(page, { do: 'read', target: 'the first video' })?.name).toBe('Last Cheater Standing Wins $10,000! 34 minutes')
    expect(byRole(page, { do: 'press', target: 'the newest video' })?.name).toBe('Last Cheater Standing Wins $10,000! 34 minutes')
    expect(byRole(page, { do: 'press', target: 'the second video' })?.name).toBe('I Outsmarted Pro Car Thieves 25 minutes')
  })

  it('skips the channel’s own card on a search page, which is titled but is not a video', () => {
    const results = table(
      [
        ['MrBeast @MrBeast • 480M subscribers Subscribe', 'Link', 400, 300, true],
        ['I Survived 100 Days In A Circle 24 minutes', 'Link', 400, 520, true],
        ['$1 vs $1,000,000 Hotel Room 18 minutes', 'Link', 400, 700, true],
      ].map(([name, type, x, y, web]) => ({ name, type, x, y, web, id: '', off: false })),
    )
    expect(byRole(results, { do: 'press', target: 'the first video' })?.name).toBe('I Survived 100 Days In A Circle 24 minutes')
  })

  it('finds a tab by its name and kind, and nothing for words it cannot read as a role', () => {
    expect(byRole(page, { do: 'press', target: 'the Latest tab' })?.type).toBe('Tab')
    expect(byRole(page, { do: 'press', target: 'something nice' })).toBeUndefined()
  })
})
