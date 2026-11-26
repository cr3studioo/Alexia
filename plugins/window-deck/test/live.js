// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process'
import { createDeck } from '../deck.js'
import { macosBackend } from '../macos.js'
import { shell, windowsBackend } from '../windows.js'
import { assert, fakeStorage, slowTest } from './harness.js'

/**
 * This computer, for real: real PowerShell or osascript, nothing faked but the layout table.
 * `deck.test.js` imports this file; nothing here is registered unless `ALEXIA_WINDOW_LIVE=1`.
 *
 * The listing is read-only. The rest, only on Windows, opens **a window of its own** and moves that one: the deck is shown nothing
 * else, so no window of yours is ever touched, and no title of yours is printed. Quitting is
 * tried on Character Map, and only when none was running beforehand.
 */
const LIVE = process.env.ALEXIA_WINDOW_LIVE === '1'
const windows = process.platform === 'win32'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, check) {
  const deadline = Date.now() + 40_000
  for (;;) {
    const found = await check()
    if (found) return found
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await wait(500)
  }
}

if (LIVE) {
  slowTest('live: this computer lists its screens and windows', async () => {
    const backend = windows ? windowsBackend() : macosBackend()
    const found = await backend.list()
    assert.ok(found.monitors.some((one) => one.primary))
    for (const one of found.windows) {
      assert.match(one.id, windows ? /^\d+$/ : /^\d+:\d+:/)
      assert.ok(found.monitors.some((monitor) => monitor.id === one.monitor))
    }
  })

  if (windows) {
    slowTest('live: a window of our own is snapped, moved, saved, restored and closed', async () => {
      const title = `Alexia deck test ✓ ${String(process.pid)}`
      const form = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$form = New-Object System.Windows.Forms.Form',
        `$form.Text = '${title}'`,
        '$form.Width = 700; $form.Height = 500',
        // Closes itself in the end, so a failed test leaves nothing on the screen.
        '$timer = New-Object System.Windows.Forms.Timer',
        '$timer.Interval = 80000; $timer.Add_Tick({ $form.Close() }); $timer.Start()',
        '[System.Windows.Forms.Application]::Run($form)',
      ].join('\n')
      const child = spawn(shell(), ['-NoProfile', '-NonInteractive', '-STA', '-Command', form], { stdio: 'ignore' })
      try {
        const real = windowsBackend()
        const ours = {
          ...real,
          list: async (signal) => {
            const found = await real.list(signal)
            return { ...found, windows: found.windows.filter((one) => one.title === title) }
          },
        }
        const deck = createDeck({ backend: ours, storage: fakeStorage() })
        const mine = async () => (await ours.list()).windows[0]
        const first = await until('our window', mine)
        const { work } = (await ours.list()).monitors.find((one) => one.id === first.monitor)
        const near = (got, want, what) => assert.ok(Math.abs(got - want) <= 2, `${what}: ${String(got)} not ${String(want)}`)

        await deck.arrange({ id: first.id, do: 'snap_left' })
        let now = await mine()
        near(now.x, work.x, 'snapped x')
        near(now.y, work.y, 'snapped y')
        near(now.w, Math.floor(work.w / 2), 'snapped w')
        near(now.h, work.h, 'snapped h')

        assert.deepEqual(await deck.save('live'), { saved: 'live', windows: 1 })

        await deck.arrange({ id: first.id, do: 'move', x: work.x + 120, y: work.y + 90 })
        await deck.arrange({ id: first.id, do: 'resize', w: 640, h: 420 })
        now = await mine()
        near(now.x, work.x + 120, 'moved x')
        near(now.y, work.y + 90, 'moved y')
        near(now.w, 640, 'resized w')
        near(now.h, 420, 'resized h')

        await deck.arrange({ id: first.id, do: 'maximize' })
        assert.equal((await mine()).maximized, true)
        await deck.arrange({ id: first.id, do: 'minimize' })
        assert.equal((await mine()).minimized, true)
        await deck.arrange({ id: first.id, do: 'restore' })
        assert.equal((await mine()).minimized, false)

        await deck.arrange({ id: first.id, do: 'minimize' })
        const done = await deck.apply({ name: 'live' })
        assert.equal(done.placed, 1, done.text)
        now = await mine()
        assert.equal(now.minimized, false)
        near(now.x, work.x, 'put back x')
        near(now.w, Math.floor(work.w / 2), 'put back w')

        assert.match(await deck.arrange({ id: first.id, do: 'close' }), /^Closed/)
        assert.equal(await mine(), undefined)
      } finally {
        child.kill()
      }
    })

    slowTest('live: an app is opened by the backend and quits when asked', async () => {
      const running = () => spawnSync(shell(), ['-NoProfile', '-Command', '@(Get-Process charmap -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).stdout.trim()
      // Somebody's own Character Map is theirs: leave it alone.
      if (running() !== '0') return
      const backend = windowsBackend()
      const deck = createDeck({ backend, storage: fakeStorage() })
      await backend.open({ app: 'charmap' })
      try {
        await until('Character Map', async () => (await backend.list()).windows.find((one) => one.app.toLowerCase() === 'charmap'))
        assert.equal(await deck.quit({ app: 'charmap' }), 'charmap has quit.')
        assert.equal(running(), '0')
      } finally {
        if (running() !== '0') await deck.quit({ app: 'charmap', force: true })
      }
    })
  }
}
