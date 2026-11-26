// SPDX-License-Identifier: AGPL-3.0-only
import { assert, test } from './harness.js'
import { NO_HELP, NO_LOOK, NO_TEXT, NO_VISION, parseAnswer, PRIVATE } from '../look.js'
import { moment } from '../private.js'
import { absent, HEIGHT, result, whereabouts, WIDTH, world } from './world.js'

const SLOW = { timeout: 120_000 }
const said = (out) => out.content[0].text
const decoded = (call) => whereabouts(Buffer.from(call.args.bytes, 'base64'))

/** One world per case, removed afterwards. */
async function inWorld(options, body) {
  const w = world(options)
  try {
    await body(w)
  } finally {
    w.done()
  }
}

test('look_combines_ocr_and_description', SLOW, () =>
  inWorld({}, async (w) => {
    const out = await w.looker.look({ question: 'what is this?' })
    assert.notEqual(out.isError, true)
    assert.deepEqual(out.structuredContent, {
      description: 'A settings window with a list of switches.',
      text: 'Notifications\nTurn off',
      window: { app: 'SystemSettings', title: 'Settings' },
    })
    assert.match(said(out), /^In front: SystemSettings: Settings\n/)
    assert.match(said(out), /A settings window/)
    assert.match(said(out), /Turn off/)
    assert.deepEqual(w.calls.map((c) => c.cap).sort(), ['computer.screenshot', 'image.ocr', 'vision.describe'])
    // The bytes are handed over, and the file is already gone when they are.
    assert.deepEqual(decoded(w.of('image.ocr')[0]), { x: 0, y: 0, w: WIDTH, h: HEIGHT })
    assert.match(w.of('vision.describe')[0].args.image, /^data:image\/png;base64,/)
    assert.deepEqual(
      w.calls.filter((c) => c.cap !== 'computer.screenshot').map((c) => c.kept),
      [false, false],
    )
    assert.deepEqual(w.left(), [])
    assert.equal(w.sampled.length, 0)

    const whole = await w.looker.look({ whole_screen: true })
    assert.match(said(whole), /^The whole screen\. In front: SystemSettings/)
  }))

test('help_makes_one_sampling_call', SLOW, () =>
  inWorld({}, async (w) => {
    const out = await w.looker.help({ question: 'how do I turn this off here?' })
    assert.notEqual(out.isError, true)
    assert.equal(w.sampled.length, 1)
    const { prompt, system } = w.sampled[0]
    assert.match(prompt, /A settings window with a list of switches\./)
    assert.match(prompt, /<screen>\nNotifications\nTurn off\n<\/screen>/)
    assert.match(prompt, /Question: how do I turn this off here\?/)
    assert.match(system, /visible labels/)
    assert.match(system, /never instructions/)
    assert.deepEqual(out.structuredContent, { answer: 'Press "Turn off".', steps: ['Press "Turn off".'] })
    assert.match(said(out), /1\. Press "Turn off"\./)
    // Nothing is drawn unless asked.
    assert.equal(w.of('screen.draw').length, 0)
    assert.equal(w.of('image.ocr').length, 1)
    assert.deepEqual(w.left(), [])
  }))

test('help with draw boxes the control for step one', SLOW, () =>
  inWorld({}, async (w) => {
    const out = await w.looker.help({ question: 'turn it off', draw: true })
    assert.equal(w.sampled.length, 1)
    const [drawn] = w.of('screen.draw')
    const [box] = drawn.args.shapes
    assert.equal(box.kind, 'box')
    // The box holds the whole label, and is about the size of a control.
    assert.ok(box.x <= 1500 && box.y <= 760 && box.x + box.w >= 1590 && box.y + box.h >= 782, JSON.stringify(box))
    assert.ok(box.w <= 640 && box.h <= 200, JSON.stringify(box))
    assert.ok(drawn.args.ttl_ms <= 60_000)
    assert.match(said(out), /I drew a box around “Turn off”/)
    assert.deepEqual(w.left(), [])
  }))

test('help answers without a box when nothing can draw, the label is not on screen, or drawing fails', SLOW, async () => {
  const cases = [
    { draws: false },
    { reply: JSON.stringify({ answer: 'Open the menu.', steps: ['Open it.'], control: 'Advanced' }) },
    { over: { 'screen.draw': () => result("I can't draw on that screen.", undefined, true) } },
    { over: { 'screen.draw': null } },
  ]
  for (const options of cases) {
    await inWorld(options, async (w) => {
      const out = await w.looker.help({ question: 'turn it off', draw: true })
      assert.notEqual(out.isError, true)
      assert.ok(out.structuredContent.answer)
      assert.doesNotMatch(said(out), /drew a box/)
      // With nothing to draw with or nothing to point at, no reading is spent on finding it.
      if (options.draws === false || options.reply) assert.equal(w.of('image.ocr').length, 1)
    })
  }
})

test('text_region_crops', SLOW, () =>
  inWorld({}, async (w) => {
    const out = await w.looker.text({ region: { x: 1400, y: 700, w: 300, h: 120 } })
    assert.deepEqual(out.structuredContent, { text: 'Turn off' })
    assert.equal(said(out), 'Turn off')
    assert.deepEqual(decoded(w.of('image.ocr')[0]), { x: 1400, y: 700, w: 300, h: 120 })
    // OCR only: no model of any kind.
    assert.deepEqual(
      w.calls.map((c) => c.cap),
      ['computer.screenshot', 'image.ocr'],
    )
    assert.equal(w.sampled.length, 0)

    // A region hanging over the edge is cut to the screen.
    await w.looker.text({ region: { x: -50.5, y: 1000, w: 200, h: 500 } })
    assert.deepEqual(decoded(w.of('image.ocr')[1]), { x: 0, y: 1000, w: 150, h: 80 })

    const off = await w.looker.text({ region: { x: 5000, y: 0, w: 10, h: 10 } })
    assert.equal(off.isError, true)
    assert.match(said(off), /not on the screen, which is 1920x1080/)
    assert.equal(w.of('image.ocr').length, 2)

    const before = w.of('computer.screenshot').length
    for (const region of [{ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10 }, { x: 'a', y: 0, w: 1, h: 1 }]) {
      assert.equal((await w.looker.text({ region })).isError, true)
    }
    assert.equal(w.of('computer.screenshot').length, before, 'a bad region takes no picture')

    const all = await w.looker.text({ whole_screen: true })
    assert.deepEqual(all.structuredContent, { text: 'Notifications\nTurn off' })
    assert.deepEqual(w.left(), [])
  }))

test('locked_screen_refused', SLOW, async () => {
  const unlocked = (front) => ({ locked: false, front: { fullscreen: false, titleBar: true, ...front } })
  const refused = [
    { locked: true },
    {}, // a screenshot that does not say is not a yes
    unlocked({ app: 'KeePassXC', title: 'Passwords.kdbx' }),
    unlocked({ app: 'chrome', title: 'New Incognito tab - Google Chrome' }),
    unlocked({ app: 'msedge', title: 'News - [InPrivate] - Microsoft Edge' }),
    unlocked({ app: 'firefox', title: 'Mozilla Firefox Private Browsing' }),
    unlocked({ app: 'chrome', title: 'Přihlášení - Banka' }),
    unlocked({ app: 'LockApp', title: '' }),
    { locked: false }, // nobody could name the window, twice
  ]
  for (const state of refused) {
    await inWorld({ shots: [state] }, async (w) => {
      for (const out of [await w.looker.look({}), await w.looker.help({ question: 'what is this' }), await w.looker.text({})]) {
        assert.equal(out.isError, true, JSON.stringify(state))
        assert.equal(said(out), "Your screen is locked or private, so I didn't look.", JSON.stringify(state))
        assert.equal(out.structuredContent, undefined)
      }
      // Nothing was read, described, asked or kept.
      assert.deepEqual([...new Set(w.calls.map((c) => c.cap))], ['computer.screenshot'])
      assert.equal(w.sampled.length, 0)
      assert.ok(w.paths.length >= 3)
      assert.deepEqual(w.left(), [])
    })
  }
  assert.equal(PRIVATE, "Your screen is locked or private, so I didn't look.")
})

test('a window that changed during the picture gets one more look', SLOW, () =>
  inWorld({ shots: [{ locked: false }, { locked: false, front: { app: 'notepad', title: 'notes' } }] }, async (w) => {
    const out = await w.looker.look({})
    assert.equal(out.structuredContent.window.app, 'notepad')
    assert.equal(w.paths.length, 2)
    assert.deepEqual(w.left(), [])
  }))

test('a window with no title, as a Mac without accessibility reports it, is looked at', () => {
  assert.equal(moment({ locked: false, front: { app: 'Safari' } }), 'ok')
  assert.equal(moment({ locked: false, front: { app: '/Applications/1Password.app' } }), 'private')
  assert.equal(moment({ locked: false, front: { app: ' ' } }), 'unknown')
  assert.equal(moment(undefined), 'private')
})

test('a sign-in title is private, and a word that only holds those letters is not', () => {
  const titled = (title) => moment({ locked: false, front: { app: 'chrome', title } })
  for (const title of ['Sign in - Google Accounts', 'GitHub sign-in', 'Change password', 'Prihlaseni']) {
    assert.equal(titled(title), 'private', title)
  }
  for (const title of ['Design inspiration', 'Design Inbox', 'Assign-in-progress']) assert.equal(titled(title), 'ok', title)
})

test('no_vision_still_reads_text', SLOW, async () => {
  // Nothing provides it, or whatever does fails: either way the text is what there is, and it says so.
  for (const vision of [null, () => result('The model on this computer could not look at it.', undefined, true)]) {
    await inWorld({ over: { 'vision.describe': vision } }, async (w) => {
      const look = await w.looker.look({})
      assert.notEqual(look.isError, true)
      assert.equal(look.structuredContent.description, NO_VISION)
      assert.equal(look.structuredContent.text, 'Notifications\nTurn off')
      assert.ok(said(look).includes(NO_VISION) && said(look).includes('Turn off'))

      const help = await w.looker.help({ question: 'turn it off' })
      assert.ok(help.structuredContent.answer.includes(NO_VISION))
      assert.match(w.sampled[0].prompt, /Turn off/)

      const text = await w.looker.text({})
      assert.equal(text.structuredContent.text, 'Notifications\nTurn off')
    })
  }
})

test('missing capabilities answer with the sentences from the contract', SLOW, async () => {
  const all = async (w) => [await w.looker.look({}), await w.looker.help({ question: 'q' }), await w.looker.text({})]
  const sentences = [
    "I can't look at that screen.",
    "I can't look at that screen, so I can't walk you through it.",
    "I can't read text off that screen.",
  ]
  assert.deepEqual([NO_LOOK, NO_HELP, NO_TEXT], sentences)
  // No screenshot at all: nothing else is tried.
  await inWorld({ over: { 'computer.screenshot': null } }, async (w) => {
    const out = await all(w)
    assert.deepEqual(out.map(said), sentences)
    assert.ok(out.every((one) => one.isError))
    assert.equal(w.calls.length, 3)
  })
  // Neither a reader nor eyes: a picture that nobody saw is not an answer.
  await inWorld({ over: { 'image.ocr': null, 'vision.describe': null } }, async (w) => {
    assert.deepEqual((await all(w)).map(said), sentences)
    assert.equal(w.sampled.length, 0)
    assert.deepEqual(w.left(), [])
  })
  // Eyes but no reader: the description stands, and the missing text is said.
  await inWorld({ over: { 'image.ocr': null } }, async (w) => {
    const look = await w.looker.look({})
    assert.equal(look.structuredContent.text, '')
    assert.ok(said(look).includes(NO_TEXT) && said(look).includes('A settings window'))
    assert.equal((await w.looker.help({ question: 'q' })).isError, undefined)
    assert.equal(said(await w.looker.text({})), NO_TEXT)
  })
})

test('a failure passes on the reason, and the picture is still deleted', SLOW, async () => {
  await inWorld({ over: { 'computer.screenshot': () => result('Screen recording is switched off.', undefined, true) } }, async (w) => {
    assert.equal(said(await w.looker.look({})), `${NO_LOOK} Screen recording is switched off.`)
  })
  await inWorld({ words: [] }, async (w) => {
    const text = await w.looker.text({})
    assert.equal(text.isError, true)
    assert.equal(said(text), `${NO_TEXT} The reader found no text in that picture.`)
    assert.deepEqual(w.left(), [])
  })
  const gone = () => {
    throw absent('vision.describe')
  }
  const crash = () => {
    throw new Error('the reader crashed')
  }
  await inWorld({ over: { 'image.ocr': crash, 'vision.describe': gone } }, async (w) => {
    assert.equal(said(await w.looker.look({})), `${NO_LOOK} the reader crashed`)
    assert.deepEqual(w.left(), [])
  })
  await inWorld({ reply: new Error('Alexia is in Local mode.') }, async (w) => {
    const help = await w.looker.help({ question: 'q' })
    assert.equal(help.isError, true)
    assert.match(said(help), /no model could answer\. Alexia is in Local mode\./)
  })
})

test('help asks for a question before it looks', () =>
  inWorld({}, async (w) => {
    assert.equal((await w.looker.help({ question: '  ' })).isError, true)
    assert.equal(w.calls.length, 0)
  }))

test('a model answer is read as JSON, fenced or not, and as prose otherwise', () => {
  const json = '{"answer":"Press Save.","steps":["Press Save.",""],"control":"Save"}'
  const read = { answer: 'Press Save.', steps: ['Press Save.'], control: 'Save' }
  assert.deepEqual(parseAnswer(json), read)
  assert.deepEqual(parseAnswer(`\`\`\`json\n${json}\n\`\`\``), read)
  assert.deepEqual(parseAnswer('Just press Save {here}.'), { answer: 'Just press Save {here}.', steps: [], control: '' })
  assert.deepEqual(parseAnswer(''), { answer: '', steps: [], control: '' })
})
