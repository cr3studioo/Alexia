// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The real overlay on the real screen, only with `ALEXIA_LIVE=1`.
 *
 * On Windows it opens a small window of its own, draws over it and **clicks through the drawing**:
 * the click must reach that window, and the overlay must never be the window in front. The mouse
 * is moved for a moment and put back, and nothing is clicked unless the test's own window is what
 * is under the point.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { createInk } from '../ink.js'
import { macos } from '../macos.js'
import { startProcess } from '../run.js'
import { parseDraw } from '../shapes.js'
import { windows } from '../windows.js'
import { assert, slowTest } from './harness.js'

/** The window underneath, and what the screen and the mouse say about a point of it. */
const TARGET = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Alexia -Name Probe -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr window, uint flags);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr window, int index);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Alexia ink test'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 200, 200
$form.Size = New-Object System.Drawing.Size 360, 240
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 64, 96)
$form.TopMost = $true
$script:clicks = 0
$form.add_MouseDown({ $script:clicks++ })
$form.Show()
$form.Activate()

function Get-Under($x, $y) {
  $point = New-Object Alexia.Probe+POINT
  $point.X = $x
  $point.Y = $y
  [Alexia.Probe]::GetAncestor([Alexia.Probe]::WindowFromPoint($point), 2).ToInt64()
}

function Write-Answer($answer) {
  [Console]::Out.WriteLine((ConvertTo-Json $answer -Compress))
  [Console]::Out.Flush()
}

$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput())
$script:pending = $reader.ReadLineAsync()
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 20
$poll.add_Tick({
  if (-not $script:pending.IsCompleted) { return }
  $line = $script:pending.Result
  if ($null -eq $line) { $form.Close(); return }
  # Stopped while this one is answered: DoEvents below would otherwise run it a second time.
  $poll.Stop()
  $ask = ConvertFrom-Json $line
  if ($ask.do -eq 'look') {
    $bitmap = New-Object System.Drawing.Bitmap 1, 1
    $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
    $canvas.CopyFromScreen($ask.x, $ask.y, 0, 0, $bitmap.Size)
    $pixel = $bitmap.GetPixel(0, 0)
    $canvas.Dispose()
    $bitmap.Dispose()
    $style = 0
    if ($ask.overlay) { $style = [Alexia.Probe]::GetWindowLong([IntPtr][long]$ask.overlay, -20) }
    Write-Answer @{ rgb = @($pixel.R, $pixel.G, $pixel.B); under = (Get-Under $ask.x $ask.y); front = [Alexia.Probe]::GetForegroundWindow().ToInt64(); style = $style }
  } elseif ($ask.do -eq 'click') {
    $mine = (Get-Under $ask.x $ask.y) -eq $form.Handle.ToInt64()
    if ($mine) {
      $was = [System.Windows.Forms.Cursor]::Position
      [void][Alexia.Probe]::SetCursorPos($ask.x, $ask.y)
      [Alexia.Probe]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      [Alexia.Probe]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      $until = [DateTime]::Now.AddSeconds(5)
      while ($script:clicks -eq 0 -and [DateTime]::Now -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
      [void][Alexia.Probe]::SetCursorPos($was.X, $was.Y)
    }
    Write-Answer @{ mine = $mine; clicks = $script:clicks; front = [Alexia.Probe]::GetForegroundWindow().ToInt64() }
  }
  $script:pending = $reader.ReadLineAsync()
  $poll.Start()
})
$poll.Start()
Write-Answer @{ window = $form.Handle.ToInt64() }
[System.Windows.Forms.Application]::Run($form)
`

/** The target window's process, asked one question at a time. */
function target() {
  const waiting = []
  const heard = []
  const helper = startProcess(
    windows().command,
    ['-NoProfile', '-NonInteractive', '-STA', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-Command', TARGET],
    {
      onLine: (line) => {
        const answer = JSON.parse(line)
        if (waiting.length > 0) waiting.shift().resolve(answer)
        else heard.push(answer)
      },
    },
  )
  helper.exit.then(({ said }) => {
    for (const one of waiting.splice(0)) one.reject(new Error(`the target window stopped: ${said}`))
  })
  const next = () =>
    heard.length > 0 ? Promise.resolve(heard.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  return {
    next,
    ask: (question) => {
      const answer = next()
      helper.send(JSON.stringify(question))
      return answer
    },
    stop: async () => {
      helper.close()
      const late = setTimeout(() => helper.kill(), 10_000)
      await helper.exit
      clearTimeout(late)
    },
  }
}

const near = (a, b) => a.every((value, at) => Math.abs(value - b[at]) <= 12)

/** Ask until the answer is the wanted one, for as long as a loaded machine might need. */
async function until(ask, wanted, what, ms = 30_000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await ask()
    if (wanted(last)) return last
    await sleep(50)
  }
  assert.fail(`${what}: last saw ${JSON.stringify(last)}`)
}

export function live() {
  if (process.env.ALEXIA_LIVE !== '1') return

  if (process.platform === 'win32') {
    slowTest('live: it draws on top, lets a click through, takes no focus and takes itself down', async () => {
      const under = target()
      const warned = []
      const started = []
      const ink = createInk({
        backend: windows(),
        start: (...args) => {
          const one = startProcess(...args)
          started.push(one)
          return one
        },
        warn: (why) => warned.push(why),
      })
      const background = [32, 64, 96]
      const green = [52, 199, 89]
      const middle = { x: 380, y: 320 }
      try {
        const { window } = await under.next()
        const look = (point, overlay) => under.ask({ do: 'look', ...point, overlay })
        const before = await until(() => look(middle), (seen) => near(seen.rgb, background), 'the target window shows')
        assert.equal(before.under, window)

        // A solid dot right where the click will go.
        const dot = { kind: 'dot', x: middle.x, y: middle.y, w: 60, color: '#34C759', text: 'Živě: here' }
        await ink.draw(parseDraw({ shapes: [dot], ttl_ms: 60_000 })).catch((error) => {
          assert.fail(`${error.message}; ${warned.join('; ')}`)
        })
        const overlay = ink.running().window
        const seen = await until(() => look(middle, overlay), (now) => near(now.rgb, green), 'the dot is on top')
        assert.equal(seen.under, window, 'the mouse finds the window underneath')
        assert.notEqual(seen.front, overlay)
        assert.equal(seen.front, before.front, 'what was in front still is')
        assert.equal(seen.style & 0x080800a0, 0x080800a0)

        const click = await under.ask({ do: 'click', ...middle })
        assert.equal(click.mine, true)
        assert.equal(click.clicks, 1, 'the click went through the dot')
        assert.notEqual(click.front, overlay)

        await ink.clear()
        await until(() => look(middle), (now) => near(now.rgb, background), 'clear removes it')

        // Her cursor, which hides by itself.
        await ink.cursor({ x: 260, y: 260, label: 'Alexia' })
        await ink.cursor({ ...middle, label: 'Alexia' })
        const purple = await until(() => look(middle, overlay), (now) => near(now.rgb, [124, 92, 255]), 'her cursor arrives')
        assert.equal(purple.under, window)
        await until(() => look(middle), (now) => near(now.rgb, background), 'her cursor hides when idle')

        // A box for two seconds: its top edge shows, then goes.
        const edge = { x: 340, y: 262 }
        const box = { kind: 'box', x: 240, y: 260, w: 200, h: 120, color: '#34C759' }
        const arrow = { kind: 'arrow', x: 500, y: 410, to: { x: 450, y: 385 }, text: 'this' }
        const at = Date.now()
        await ink.draw(parseDraw({ shapes: [box, arrow], ttl_ms: 2_000 }))
        await until(() => look(edge), (now) => near(now.rgb, green), 'the box shows')
        await until(() => look(edge), (now) => near(now.rgb, background), 'the box comes down by itself')
        assert.ok(Date.now() - at >= 1_900, 'and not before its time')
        assert.deepEqual(warned, [])
      } finally {
        ink.close()
        await under.stop()
      }
      for (const one of started) assert.equal((await one.exit).code, 0, 'the overlay left when asked')
    })
  }

  if (process.platform === 'darwin') {
    slowTest('live: draw a box for 2 s', async () => {
      const warned = []
      const ink = createInk({ backend: macos(), start: startProcess, warn: (why) => warned.push(why) })
      try {
        const box = { kind: 'box', x: 200, y: 200, w: 300, h: 160, text: 'Alexia' }
        assert.equal(await ink.draw(parseDraw({ shapes: [box], ttl_ms: 2_000 })), 1)
        await ink.cursor({ x: 350, y: 280, label: 'Alexia' })
        await sleep(2_500)
        await ink.clear()
        assert.deepEqual(warned, [])
      } finally {
        ink.close()
      }
    })
  }
}
