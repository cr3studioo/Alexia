// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { table } from '../decide.js'
import { recipe } from '../recipes.js'
import { fill, ground, runTask } from '../task.js'

/** An answer that picks `choice` with probability `p`, the rest shared out. */
const answer = (options, choice, p) => {
  const rest = (1 - p) / (options.length - 1)
  const probabilities = Object.fromEntries(options.map((one) => [one, one === choice ? p : rest]))
  return { type: 'choice', choice, probabilities, confidence: (options.length * p - 1) / (options.length - 1) }
}

/** A decider (Laya or Jev) that chooses the control called `name` with probability `p`. */
const decider = (name, p, calls = []) => async (body) => {
  calls.push(body)
  const criteria = body.questions.target.criteria
  const offered = Object.keys(criteria)
  const chosen = offered.find((key) => criteria[key].includes(`“${name}”`)) ?? offered[0]
  return { answers: { target: answer(offered, chosen, p) } }
}

/** A Save As dialog: typing the name then pressing Save closes it and shows “Saved”. */
function world() {
  const screen = { named: false, saved: false }
  const did = []
  const rowsNow = () =>
    screen.saved ?
      [{ name: 'report.txt', type: 'Window', x: 0, y: 0 }, { name: 'Saved', type: 'Button', x: 5, y: 5 }]
    : [
        { name: 'Save As', type: 'Window', x: 0, y: 0 },
        { name: 'Save As:', type: 'TextField', x: 10, y: 10 },
        { name: 'Cancel', type: 'Button', x: 20, y: 20 },
        { name: 'Save', type: 'Button', x: 30, y: 30 },
      ]
  return {
    did,
    io: {
      look: async () => rowsNow(),
      press: async (row) => {
        did.push(`press ${row.name}`)
        if (row.name === 'Save' && screen.named) screen.saved = true
        return { found: true, how: 'invoke' }
      },
      click: async (row) => {
        did.push(`click ${row.name}`)
        if (row.name === 'Save' && screen.named) screen.saved = true
      },
      type: async (text) => {
        did.push(`type ${text}`)
        screen.named = true
      },
      key: async () => {},
      scroll: async (row, down) => did.push(`scroll ${String(down)} at ${String(row?.x)},${String(row?.y)}`),
      note: async () => {},
    },
  }
}

const saving = [
  { do: 'type', target: 'Save As:', text: 'report.txt' },
  { do: 'press', target: 'Save', expect: 'Saved' },
]

describe('runTask: the chat model’s plan, with no model in the loop', () => {
  it('runs the plan it was handed, and asks no model at all', async () => {
    const { io, did } = world()
    const asked = []
    io.laya = decider('Save', 0.9, asked)
    const done = await runTask('Save this as report.txt', io, { steps: saving })
    expect(done.outcome).toBe('done')
    // Pressing “Save” by name would reach the “Save As:” field first, so it is clicked instead.
    expect(did).toEqual(['click Save As:', 'type report.txt', 'click Save'])
    expect(asked).toEqual([])
    expect(done.rungs).toMatchObject({ exact: 2 })
  })

  it('hands back at once, with what is on screen, when there is no plan', async () => {
    const { io, did } = world()
    const done = await runTask('Save this', io, {})
    expect(done.outcome).toBe('handback')
    expect(done.rows.length).toBeGreaterThan(0)
    expect(did).toEqual([])
  })

  it('shows the plan as it goes: done points, then the running one, then what waits', async () => {
    const { io } = world()
    const shown = []
    io.onPlan = (stages) => shown.push(stages.map((one) => `${one.state}:${one.label}`))
    await runTask('Save this as report.txt', io, { steps: saving })
    expect(shown[0]).toEqual(['waiting:Type into “Save As:”', 'waiting:Press “Save”'])
    expect(shown).toContainEqual(['done:Type into “Save As:”', 'running:Press “Save”'])
    expect(shown.at(-1)).toEqual(['done:Type into “Save As:”', 'done:Press “Save”'])
  })

  it('reads a value off the screen and answers with it, word for word', async () => {
    const rows = [
      { name: 'Mark Rober - YouTube', type: 'Window', x: 0, y: 0 },
      { name: '34:23', type: 'Link', x: 480, y: 830, web: true },
      { name: 'Last Cheater Standing Wins $10,000!', type: 'Link', x: 417, y: 947, web: true },
      { name: 'I Outsmarted Pro Car Thieves', type: 'Link', x: 791, y: 947, web: true },
    ]
    const done = await runTask('the newest Mark Rober video', {
      look: async () => rows,
      note: async () => {},
    }, { steps: [{ do: 'read', target: 'the first video', as: 'title' }, { do: 'answer', text: 'The newest is “{title}”.' }] })
    expect(done.outcome).toBe('done')
    expect(done.answer).toBe('The newest is “Last Cheater Standing Wins $10,000!”.')
    expect(done.values).toEqual({ title: 'Last Cheater Standing Wins $10,000!' })
  })

  it('hands back with the steps still to do when a control cannot be found', async () => {
    const { io, did } = world()
    const done = await runTask('Save', io, { steps: [{ do: 'press', target: 'Export to PDF' }, { do: 'press', target: 'Save' }] })
    expect(done.outcome).toBe('handback')
    expect(done.remaining).toEqual([{ do: 'press', target: 'Export to PDF' }, { do: 'press', target: 'Save' }])
    expect(did).toEqual([])
  })

  it('scrolls the middle of the window when the thing to scroll is not found', async () => {
    const { io, did } = world()
    const done = await runTask('Scroll', io, { steps: [{ do: 'scroll', target: 'the search results list', down: 15 }] })
    expect(done.outcome).toBe('done')
    expect(did).toEqual(['scroll 15 at 0,0'])
  })

  it('shows a plan that commits something first, and runs nothing until it is confirmed', async () => {
    const { io, did } = world()
    const plan = [{ do: 'press', target: 'Send' }]
    expect((await runTask('Send it', io, { steps: plan })).outcome).toBe('confirm')
    expect(did).toEqual([])
    io.look = async () => [{ name: 'Mail', type: 'Window', x: 0, y: 0 }, { name: 'Send', type: 'Button', x: 1, y: 1 }]
    await runTask('Send it', io, { steps: plan, confirmed: true })
    expect(did).toEqual(['press Send'])
  })

  it('waits while the person has the controls, then carries on', async () => {
    const { io, did } = world()
    let release
    const held = new Promise((resolve) => (release = resolve))
    let paused = true
    io.paused = () => (paused ? held : undefined)
    const running = runTask('Save this as report.txt', io, { steps: saving })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(did).toEqual([])
    paused = false
    release()
    expect((await running).outcome).toBe('done')
  })

  it('stops when actions stop changing the screen', async () => {
    const done = await runTask('Press it', {
      look: async () => [{ name: 'App', type: 'Window', x: 0, y: 0 }, { name: 'Go', type: 'Button', x: 1, y: 1 }],
      press: async () => ({ found: true, how: 'invoke' }),
      click: async () => {},
      note: async () => {},
    }, { steps: [{ do: 'press', target: 'Go' }, { do: 'press', target: 'Go' }, { do: 'press', target: 'Go' }] })
    expect(done.outcome).toBe('handback')
    expect(done.said).toMatch(/changed nothing/)
    expect(done.remaining).toEqual([{ do: 'press', target: 'Go' }])
  })

  it('counts a press on something already on as done, and does not press it', async () => {
    const pressed = []
    const rows = [
      { name: 'Video', type: 'Window', x: 0, y: 0 },
      { name: 'like this video along with 3 other people', type: 'Button', x: 5, y: 5, on: true },
    ]
    const done = await runTask('Like the video', {
      look: async () => rows,
      press: async (row) => pressed.push(row.name),
      click: async (row) => pressed.push(row.name),
      note: async () => {},
    }, { steps: [{ do: 'press', target: 'Like' }] })
    expect(pressed).toEqual([])
    expect(done.outcome).toBe('done')
    expect(done.steps[0]).toMatchObject({ how: 'already', detail: 'already on' })
  })
})

describe('ground: names first, Laya only to break a close call', () => {
  const list = table([
    { name: 'Notes', type: 'Window', x: 0, y: 0 },
    { name: 'New note', type: 'Button', x: 1, y: 1 },
    { name: 'Share', type: 'Button', x: 2, y: 2 },
    { name: 'Delete note', type: 'Button', x: 3, y: 3 },
    { name: 'Search', type: 'TextField', x: 4, y: 4 },
  ])
  const at = { goal: 'Make a note', window: 'Notes', rows: list }

  it('an exact name needs no model at all', async () => {
    const asked = []
    const found = await ground({ ...at, step: { do: 'press', target: 'New note' } }, { laya: decider('New note', 0.9, asked) })
    expect(found.by).toBe('exact')
    expect(asked).toEqual([])
  })

  it('a role needs no model either', async () => {
    const form = table([
      { name: 'Find', type: 'Window', x: 0, y: 0 },
      { name: 'Query', type: 'TextField', x: 1, y: 1 },
      { name: 'Go', type: 'Button', x: 2, y: 2 },
    ])
    const found = await ground({ goal: 'Find it', window: 'Find', rows: form, step: { do: 'type', target: 'the search box' } }, {})
    expect(found).toMatchObject({ by: 'role', row: { name: 'Query' } })
  })

  it('takes Laya’s word only when it is sure and agrees with what the words favour', async () => {
    const sure = await ground({ ...at, step: { do: 'press', target: 'share it' } }, { laya: decider('Share', 0.95) })
    expect(sure).toMatchObject({ by: 'laya', row: { name: 'Share' } })
    const against = await ground({ ...at, step: { do: 'press', target: 'share it' } }, { laya: decider('New note', 0.95) })
    expect(against.row).toBeUndefined()
    const unsure = await ground({ ...at, step: { do: 'press', target: 'share it' } }, { laya: decider('Share', 0.5) })
    expect(unsure.row).toBeUndefined()
  })

  it('never presses something that commits on a role or a guess', async () => {
    const found = await ground({ ...at, step: { do: 'press', target: 'remove this note' } }, { laya: decider('Delete note', 0.7) })
    expect(found.row).toBeUndefined()
  })
})

describe('recipes and answers', () => {
  it('knows the channel page for a newest-video goal, and nothing for a goal it has no plan for', () => {
    expect(recipe('the latest video from Mark Rober')?.[0].url).toBe('https://www.youtube.com/@MarkRober/videos')
    expect(recipe("MrBeast's newest video")?.[0].url).toBe('https://www.youtube.com/@MrBeast/videos')
    expect(recipe('search youtube for lofi beats')?.[0].url).toBe('https://www.youtube.com/results?search_query=lofi+beats')
    expect(recipe('turn on Bluetooth')).toBeUndefined()
  })

  it('reads a title without the length YouTube appends to it', async () => {
    const rows = [
      { name: 'Channel', type: 'Window', x: 0, y: 0 },
      { name: 'Last Cheater Standing Wins $10,000! 34 minutes', type: 'Link', x: 417, y: 947, web: true },
    ]
    const done = await runTask('newest', { look: async () => rows, note: async () => {} }, { steps: [{ do: 'read', target: 'the first video', as: 'title' }] })
    expect(done.values.title).toBe('Last Cheater Standing Wins $10,000!')
  })

  it('fills an answer from what was read, and leaves a value never read visible', () => {
    expect(fill('It is “{title}” ({when}).', { title: 'X' })).toBe('It is “X” ({when}).')
  })
})
