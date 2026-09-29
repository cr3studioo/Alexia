// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * macOS, driven through `osascript`'s JavaScript and the frameworks already on every Mac (D148).
 *
 * The same bargain `windows.js` made, one platform over: no native module, no robotjs, no
 * nut.js, nothing compiled per Node version. PowerShell reaches .NET; `osascript -l JavaScript`
 * reaches Objective-C and C directly, so the whole of what is needed is already installed —
 * **Quartz events** for the pointer and the keyboard, the **accessibility API** for the control
 * tree, `screencapture` for the picture. One spawn per action, about 100 ms, which is nothing
 * next to the model call on either side of it.
 *
 * Same exports as `windows.js`, so `index.js` and `replay.js` never ask which one they have.
 * The one place the two cannot agree is key notation — SendKeys' `^c` means nothing here — so
 * each backend describes its own, and the tool's description is built from that.
 *
 * **Everything here happens in the plugin process**, exactly as on Windows: core spawns this
 * and reads JSON from a pipe, and a screenshot crosses it as a path.
 *
 * **macOS asks the person, and names the app.** Posting input and reading another app's
 * controls both need *Accessibility*; the screenshot needs *Screen & System Audio Recording*.
 * macOS grants them to the app responsible for this process — Alexia — never to the plugin,
 * and a refused event is not an error: it is silently dropped. So every action checks first
 * and answers with the place in System Settings, rather than reporting a click that went
 * nowhere.
 */

export const supported = () => process.platform === 'darwin'

/** What a person reads when this platform is named in a sentence. */
export const engine = 'macOS'

const NOT_TRUSTED =
  'macOS has not allowed Alexia to control this Mac, so nothing was done. Turn Alexia on in System ' +
  'Settings → Privacy & Security → Accessibility, then try again.'

/**
 * Run a script with its arguments and parse what it printed.
 *
 * Arguments arrive through `argv` and never as script text, so nothing a model wrote is ever
 * code — the job `quoted` does in `windows.js`, done here by not building scripts from values.
 *
 * **One `osascript` stays running and takes every call** (computer use v2). Starting one costs
 * about 150 ms before a line of the script runs — measured, and more than most scripts take — and
 * a task that looks, presses and looks again paid it three times a step. The worker loads the
 * frameworks once, compiles each script the first time it sees it, and answers over a pipe. If it
 * cannot start, or dies, the call falls back to a process of its own, so a broken worker is a
 * slower Mac and never a broken one. `ALEXIA_COMPUTER_SPAWN=1` forces the old way, to compare.
 */
export function run(script, args = [], signal) {
  if (process.env.ALEXIA_COMPUTER_SPAWN === '1' || worker.broken) return runOnce(script, args, signal)
  return worker.call(script, args.map(String), signal).catch((error) => {
    if (error?.workerDied && !signal?.aborted) return runOnce(script, args, signal)
    throw error
  })
}

/** A script in a process of its own: the fallback, and what every call did before the worker. */
function runOnce(script, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${PRELUDE}\n${script}`, ...args.map(String)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        const why = said.trim().replace(/^.*execution error:\s*(Error:\s*)*/s, '').replace(/\s*\(-?\d+\)$/, '')
        return reject(new Error(why || `osascript exited ${String(code)}`))
      }
      settle(out, resolve, reject)
    })
  })
}

/** What a script printed, as an answer or as the refusal it carried. */
function settle(out, resolve, reject) {
  let answer
  try {
    answer = JSON.parse(out || 'null')
  } catch (error) {
    return reject(error)
  }
  if (answer && answer.refused) return reject(new Error(answer.refused))
  resolve(answer)
}

/**
 * The worker's side: read one JSON line, run it, write one JSON line, forever.
 *
 * Each script is compiled once, the first time its key arrives with its text, and kept — the
 * scripts are this file's constants, so there are a dozen of them and never more. Every script
 * defines its own `run(argv)`, which is exactly the function the wrapper hands back.
 */
const WORKER = `
const input = $.NSFileHandle.fileHandleWithStandardInput, output = $.NSFileHandle.fileHandleWithStandardOutput;
const compiled = {}, NL = String.fromCharCode(10);
const send = (reply) => output.writeData($(JSON.stringify(reply) + NL).dataUsingEncoding($.NSUTF8StringEncoding));
function run() {
  let buffer = '';
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) return '';
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let at;
    while ((at = buffer.indexOf(NL)) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let ask = {};
      try {
        ask = JSON.parse(line);
        if (ask.script !== undefined) compiled[ask.key] = eval(['(function () {', ask.script, ';return run;', '})()'].join(NL));
        const script = compiled[ask.key];
        if (!script) { send({ id: ask.id, unknown: true }); continue; }
        // AppKit only learns an app started, quit or came to the front when the run loop turns,
        // and this loop blocks on stdin instead. Unturned, the list of running apps is the one
        // from when the worker started: a browser opened since is "not open", forever.
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
        send({ id: ask.id, out: script(ask.args) });
      } catch (error) {
        send({ id: ask.id, error: String((error && error.message) || error) });
      }
    }
  }
}`

/** How long an idle worker is kept before it is let go. Five minutes, like an idle plugin. */
const IDLE_MS = 5 * 60_000

const worker = {
  child: undefined,
  broken: false,
  known: new Set(),
  keys: new Map(),
  waiting: new Map(),
  next: 1,
  idle: undefined,

  start() {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${PRELUDE}\n${WORKER}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.known = new Set()
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        this.answer(line)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', () => {
      this.broken = true
      this.stop(child)
    })
    child.on('close', () => this.stop(child))
    child.stdin.on('error', () => {})
    return child
  },

  /** A worker that went away takes its waiting calls with it; they retry in a process each. */
  stop(child) {
    if (this.child !== child) return
    this.child = undefined
    for (const [, one] of this.waiting) one.reject(Object.assign(new Error('the macOS worker stopped'), { workerDied: true }))
    this.waiting.clear()
  },

  answer(line) {
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    const one = this.waiting.get(reply.id)
    if (!one) return
    this.waiting.delete(reply.id)
    this.rest()
    if (reply.unknown) {
      // The worker restarted between two calls and never saw this script: send it again.
      this.known.delete(one.key)
      return one.retry()
    }
    if (reply.error !== undefined) return one.reject(new Error(reply.error.replace(/^(Error:\s*)+/, '')))
    settle(reply.out, one.resolve, one.reject)
  },

  /** Keep the plugin process alive only while an answer is owed; let an idle worker go. */
  rest() {
    if (!this.child) return
    if (this.waiting.size > 0) {
      this.child.ref()
      this.child.stdout.ref()
      return
    }
    this.child.unref()
    this.child.stdout.unref()
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.child?.kill(), IDLE_MS)
    this.idle.unref()
  },

  call(script, args, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      let key = this.keys.get(script)
      if (key === undefined) {
        key = String(this.keys.size + 1)
        this.keys.set(script, key)
      }
      const send = () => {
        const child = this.child ?? this.start()
        const id = this.next++
        const first = !this.known.has(key)
        this.known.add(key)
        this.waiting.set(id, { key, resolve, reject, retry: send })
        this.rest()
        child.stdin.write(`${JSON.stringify({ id, key, args, ...(first && { script }) })}\n`)
        // A call cannot be interrupted halfway inside the worker, so an abort ends the worker;
        // the next call starts a fresh one.
        signal?.addEventListener('abort', () => {
          if (!this.waiting.has(id)) return
          this.waiting.delete(id)
          reject(signal.reason ?? new Error('aborted'))
          child.kill()
        }, { once: true })
      }
      send()
    })
  },
}

/** Let the worker go now rather than when it is idle. For tests and scripts that want to exit. */
export const close = () => worker.child?.kill()

/**
 * Shared by every script: the frameworks, the coordinate flip, and the accessibility helpers.
 *
 * **Coordinates are points from the top left of the main display**, which is what Quartz
 * events and the accessibility API both use, and what `windows.js` hands back on Windows.
 * AppKit alone counts from the bottom, so `flip` is the one place that is undone.
 */
const PRELUDE = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices');
const refuse = (why) => JSON.stringify({ refused: why });
const trusted = () => $.AXIsProcessTrusted();
const mainHeight = () => $.NSScreen.screens.objectAtIndex(0).frame.size.height;
// Wrapped as an object on the way out, always: a raw ref from an out-parameter cannot be handed
// back to the accessibility API ("Ref has incompatible type"), and the same value wrapped can.
const unwrap = (value) => (value === null || value === undefined ? null : ObjC.unwrap(value));
const get = (element, name) => { const found = Ref(); return $.AXUIElementCopyAttributeValue(element, $(name), found) === 0 ? ObjC.castRefToObject(found[0]) : null; };
const text = (element, name) => { const value = unwrap(get(element, name)); return typeof value === 'string' ? value : ''; };
const children = (element, name) => { const all = get(element, name || 'AXChildren'); if (all === null) return []; const out = []; for (let i = 0; i < Number(all.count); i++) out.push(all.objectAtIndex(i)); return out; };
// An AXValue does not unpack through the bridge, and its description is stable: "x:10.0 y:20.0".
const numbers = (element, name, a, b) => { const value = get(element, name); if (value === null) return null; const said = value.description.js; const found = new RegExp(a + ':(-?[0-9.]+) ' + b + ':(-?[0-9.]+)').exec(said); return found ? [Number(found[1]), Number(found[2])] : null; };
const regularApps = () => { const all = $.NSWorkspace.sharedWorkspace.runningApplications; const out = []; for (let i = 0; i < all.count; i++) { const app = all.objectAtIndex(i); if (Number(app.activationPolicy) === 0) out.push(app); } return out; };
`

/** The screens together, as one rectangle in points. */
export const bounds = (signal) =>
  run(
    `function run() {
  const screens = $.NSScreen.screens, top = mainHeight();
  let left = Infinity, up = Infinity, right = -Infinity, down = -Infinity;
  for (let i = 0; i < screens.count; i++) {
    const f = screens.objectAtIndex(i).frame;
    const y = top - (f.origin.y + f.size.height);
    left = Math.min(left, f.origin.x); up = Math.min(up, y);
    right = Math.max(right, f.origin.x + f.size.width); down = Math.max(down, y + f.size.height);
  }
  return JSON.stringify({ x: left, y: up, width: right - left, height: down - up });
}`,
    [],
    signal,
  )

/** Spawn a system program and resolve when it succeeds, with its stderr as the reason when not. */
function program(path, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    let said = ''
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(said.trim() || `${path} exited ${String(code)}`))))
  })
}

/**
 * Every screen, as one PNG **in points** — so a coordinate read off the picture is a coordinate
 * `click` can use.
 *
 * `screencapture` writes a Retina screen at twice its point size, and a model told *coordinates
 * are measured from the top left of this image* would then click at double the distance. The
 * picture is scaled to the size the pointer moves in, which costs detail nobody here reads.
 */
export async function screenshot(to, signal) {
  const area = await bounds(signal)
  try {
    await program('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', `${area.x},${area.y},${area.width},${area.height}`, to], signal)
  } catch (error) {
    // The refusal macOS gives for a missing Screen Recording permission is this sentence, and
    // it reads like a broken display rather than a switch somebody has to turn on.
    if (/could not create image/i.test(error.message)) {
      throw new Error(
        'macOS has not allowed Alexia to record the screen, so there is no picture. Turn Alexia on in ' +
          'System Settings → Privacy & Security → Screen & System Audio Recording, then reopen Alexia.',
        { cause: error },
      )
    }
    throw error
  }
  await program('/usr/bin/sips', ['--resampleWidth', String(Math.round(area.width)), to], signal)
  return { width: Math.round(area.width), height: Math.round(area.height) }
}

/** Where the pointer is now. Needs no permission: it is where the person can already see it. */
export const cursor = (signal) =>
  run(
    `function run() {
  const at = $.NSEvent.mouseLocation;
  return JSON.stringify({ x: Math.round(at.x), y: Math.round(mainHeight() - at.y) });
}`,
    [],
    signal,
  )

/** Post mouse events. `kind` is `move`, or a button with a click count. */
const MOUSE = `
function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const [x, y, button, count] = [Number(argv[0]), Number(argv[1]), argv[2], Number(argv[3])];
  const at = $.CGPointMake(x, y);
  const post = (type, which, clicks) => {
    const event = $.CGEventCreateMouseEvent(null, type, at, which);
    if (clicks) $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clicks);
    $.CGEventPost($.kCGHIDEventTap, event);
  };
  post($.kCGEventMouseMoved, $.kCGMouseButtonLeft, 0);
  if (button === 'move') return JSON.stringify({ ok: true });
  delay(0.04);
  const kinds = {
    left: [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft],
    right: [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight],
    middle: [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGMouseButtonCenter],
  };
  const [down, up, which] = kinds[button] || kinds.left;
  // A double click is two presses whose second one *says* it is the second: macOS reads the
  // click state off the event rather than timing the gap, so two plain clicks are two clicks.
  for (let n = 1; n <= count; n++) {
    post(down, which, n); delay(0.03); post(up, which, n);
    if (n < count) delay(0.06);
  }
  return JSON.stringify({ ok: true });
}`

export const click = (x, y, button = 'left', double = false, signal) =>
  run(MOUSE, [Math.round(x), Math.round(y), button, double ? 2 : 1], signal)

export const move = (x, y, signal) => run(MOUSE, [Math.round(x), Math.round(y), 'move', 0], signal)

/**
 * Turn the wheel over a point: `down` lines down (negative is up), `right` lines right.
 *
 * The pointer goes there first, because a Mac scrolls whatever is under the pointer and not
 * whatever has focus. `CGEventCreateScrollWheelEvent2` rather than the classic call, which is
 * variadic and has no way across the JavaScript bridge.
 */
export const scroll = (x, y, down = 3, right = 0, signal) =>
  run(
    `function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const at = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, at, $.kCGMouseButtonLeft));
  delay(0.03);
  // Lines, and the sign the other way round from how a person says it: positive wheel is up.
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent2(null, 1, 2, -Number(argv[2]), -Number(argv[3]), 0));
  return JSON.stringify({ ok: true });
}`,
    [Math.round(x), Math.round(y), Math.max(-50, Math.min(50, Math.round(down))), Math.max(-50, Math.min(50, Math.round(right)))],
    signal,
  )

/** What `open` needs to be handed to reach an app by name, and nothing a name could smuggle. */
const APP_NAME = /^[\p{L}\p{N} ._&'()+-]{1,80}$/u

/**
 * Open an app by its name, or bring it to the front when it is already open.
 *
 * `open -a`, which is what Spotlight and the Dock do: Launch Services finds the app by the name
 * a person would say, wherever it is installed. The four keystrokes a model reached for instead
 * — cmd+space, the name, enter, then hunting for the window — were four chances to type into
 * the wrong place. Answers with the process id, so the next call can name the window.
 */
export async function openApp(name, signal) {
  const wanted = String(name ?? '').trim().replace(/\.app$/i, '')
  if (!APP_NAME.test(wanted)) throw new Error(`“${wanted}” is not an app name this can open.`)
  await program('/usr/bin/open', ['-a', wanted], signal).catch((error) => {
    throw new Error(/Unable to find application/i.test(error.message) ? `There is no app called “${wanted}” on this Mac.` : error.message)
  })
  // `open` returns once the app is asked to start, not once it has a window. Half a second of
  // looking is enough for most, and an app that takes longer is still opening, not missing.
  for (let tries = 0; tries < 10; tries += 1) {
    const found = (await windows(signal)).find((one) => one.ProcessName.toLowerCase() === wanted.toLowerCase())
    if (found) return { pid: found.Id, name: found.ProcessName, title: found.MainWindowTitle }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { name: wanted }
}

/** The web addresses `openUrl` takes. Not `file:`, not `javascript:`, not an app's own scheme. */
const WEB = /^(https?:\/\/|mailto:)/i

/**
 * Open a web address in the browser the person chose in settings, else the default one — the
 * one they are signed in to. A chosen browser is opened by name, the way `openApp` opens apps.
 */
export async function openUrl(url, signal, browser) {
  const address = String(url ?? '').trim()
  if (!WEB.test(address) || /\s/.test(address)) throw new Error(`“${address}” is not a web address. Give one that starts with https://.`)
  const named = typeof browser === 'string' && APP_NAME.test(browser) ? ['-a', browser] : []
  await program('/usr/bin/open', [...named, address], signal).catch((error) => {
    throw new Error(named.length > 0 && /Unable to find application/i.test(error.message) ? `${browser} is not installed. Choose another browser in Computer control’s settings.` : error.message)
  })
}

/** Spawn a program and give back what it printed, with a time limit it cannot argue with. */
function captured(path, args, signal, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: ms })
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code, killed) => {
      if (killed) return reject(new Error(`It was still running after ${String(ms / 1000)} seconds, so it was stopped.`))
      if (code !== 0) return reject(new Error(said.trim().replace(/^.*execution error:\s*/s, '') || `${path} exited ${String(code)}`))
      resolve(out.trim().slice(0, 4000))
    })
  })
}

/**
 * Run an AppleScript, the way the app itself would be asked (the API rung, before any clicking).
 *
 * Music, Mail, Finder, Safari, Notes, Calendar and most of Apple's own apps answer AppleScript
 * with their real objects — *play the playlist*, *the subject of the selected message* — which is
 * one call where the screen would be a dozen presses. The script is what a model wrote, so it is
 * run exactly as written, logged exactly as written, and only when input is allowed.
 */
export const runScript = (source, language = 'AppleScript', signal) =>
  captured('/usr/bin/osascript', ['-l', language === 'JavaScript' ? 'JavaScript' : 'AppleScript', '-e', String(source)], signal)

/** Run one of the person's own Shortcuts by name, and give back what it printed. */
export const runShortcut = (name, signal) => captured('/usr/bin/shortcuts', ['run', String(name)], signal, 60_000)

/** The names of the person's Shortcuts, so a model can see what exists before it runs one. */
export const shortcuts = (signal) => captured('/usr/bin/shortcuts', ['list'], signal).then((out) => out.split('\n').filter(Boolean))

/**
 * Type, as the keyboard would — **as characters, never as key codes**.
 *
 * A key code is a place on a keyboard, and which letter lives there is the keyboard layout's
 * business: on a Czech keyboard the key a US one calls `Y` types `Z`. Every keystroke here
 * carries the characters themselves instead, which is what an app reads, so what arrives is
 * what was asked for on any layout. Return and Tab are sent as the keys, because a text field
 * that reads a newline *character* is rarer than one that reads the Return key.
 */
export const type = (text, signal) =>
  run(
    `function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  // The characters go in as UTF-16 bytes through a pointer. Handed a string, the bridge passes
  // nothing — the event keeps its key code, which is \`a\`, and "žluťoučký" arrives as "aaaaaaaaa".
  // Measured by reading the event back before posting it, which is how this was found.
  ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']]);
  const post = (code, chars) => {
    const bytes = chars ? $(chars).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding) : null;
    for (const down of [true, false]) {
      const event = $.CGEventCreateKeyboardEvent(null, code, down);
      $.CGEventSetFlags(event, 0);
      if (bytes) $.CGEventKeyboardSetUnicodeString(event, Number(bytes.length) / 2, bytes.bytes);
      $.CGEventPost($.kCGHIDEventTap, event);
    }
    delay(0.008);
  };
  // One character an event. Sixteen to an event was faster and most apps read them all, but
  // Calculator reads only the first: "762672787*1000=" arrived as "7". \`for…of\` walks code
  // points, so an emoji still goes in whole.
  for (const character of argv[0]) {
    if (character === '\\n' || character === '\\t') { post(character === '\\n' ? 36 : 48, ''); continue; }
    post(0, character);
  }
  return JSON.stringify({ ok: true });
}`,
    [String(text)],
    signal,
  )

// ---- keys ------------------------------------------------------------------------------------

/** Named keys, by the virtual key code a Mac keyboard sends for them. Layout-independent. */
const NAMED = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  forwarddelete: 117, del: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, help: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
}

/** Modifier names a model will reach for, and the Quartz flag each one sets. */
const MODIFIERS = {
  cmd: 0x100000, command: 0x100000, '⌘': 0x100000, meta: 0x100000, super: 0x100000, win: 0x100000,
  shift: 0x20000, '⇧': 0x20000,
  alt: 0x80000, option: 0x80000, opt: 0x80000, '⌥': 0x80000,
  ctrl: 0x40000, control: 0x40000, '⌃': 0x40000,
  fn: 0x800000,
}

/** What the `key` tool tells a model, because the notation is this backend's to define. */
export const KEY_HELP =
  'Press a key or a combination, written with plus signs — enter, tab, escape, f5, up, cmd+c ' +
  'for copy, cmd+v for paste, cmd+tab to switch apps, cmd+space for Spotlight, cmd+shift+4. ' +
  'Modifiers are cmd, shift, option and ctrl. Use for anything that is not ordinary text.'
export const KEY_NOTATION = 'The combination, like cmd+c, cmd+shift+t or escape.'

/**
 * A combination, parsed — or the sentence that says why it is not one.
 *
 * Pure, and exported, so the grammar is tested on any machine: the refusal carries the grammar,
 * which is what makes a model's next attempt a corrected one rather than a repeat.
 */
export function parseKeys(combination) {
  const combo = String(combination ?? '').trim()
  const wrong = (why) => ({
    error:
      `"${combo}" is not a key combination${why ? ` — ${why}` : ''}. Write it with plus signs: enter, ` +
      'escape, tab, f5, cmd+c for copy, cmd+shift+4, option+left. Ordinary text goes to the type tool.',
  })
  if (combo === '') return wrong('there is nothing in it')
  // SendKeys habits, named, because a model that learned Windows notation will try it here.
  if (/[{}^%]/.test(combo.replace(/^\{(\w+)\}$/, '$1'))) return wrong('that is Windows notation, and this is a Mac')
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  let flags = 0
  for (const part of parts.slice(0, -1)) {
    const flag = MODIFIERS[part.trim().toLowerCase()]
    if (flag === undefined) return wrong(`"${part.trim()}" is not a modifier`)
    flags |= flag
  }
  const last = parts.at(-1)?.trim().replace(/^\{(\w+)\}$/, '$1') ?? ''
  if (last === '') return wrong('it ends without a key')
  const named = NAMED[last.toLowerCase()]
  if (named !== undefined) return { code: named, flags }
  if ([...last].length === 1 && last !== ' ') return { char: last.toLowerCase(), flags }
  return wrong(`"${last}" is not a key this knows`)
}

export function key(combination, signal) {
  const parsed = parseKeys(combination)
  if (parsed.error) return Promise.reject(new Error(parsed.error))
  return run(
    `function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const flags = Number(argv[0]);
  let code = Number(argv[1]);
  const wanted = argv[2];
  // A character becomes a key code **on this keyboard**: every code is asked what it types, and
  // the one that types the wanted character is pressed. So cmd+z undoes on a Czech keyboard
  // too, where the key a US layout calls Z is somewhere else.
  if (wanted) {
    code = -1;
    for (let candidate = 0; candidate < 128 && code < 0; candidate++) {
      const probe = $.NSEvent.eventWithCGEvent($.CGEventCreateKeyboardEvent(null, candidate, true));
      if (!probe.isNil() && probe.charactersIgnoringModifiers.js === wanted) code = candidate;
    }
    if (code < 0) return refuse('No key on this keyboard types "' + wanted + '". Nothing was pressed.');
  }
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, code, down);
    $.CGEventSetFlags(event, flags);
    $.CGEventPost($.kCGHIDEventTap, event);
    delay(0.02);
  }
  return JSON.stringify({ ok: true });
}`,
    [parsed.flags, parsed.code ?? -1, parsed.char ?? ''],
    signal,
  )
}

// ---- windows ---------------------------------------------------------------------------------

/**
 * Every app with windows, and each window's title where macOS will say it.
 *
 * Titles come from the accessibility API, so without that permission the apps are still listed
 * — by name, with no titles — rather than the list pretending nothing is open.
 */
/** The app in front, by name and process id: what a task's trust and saved runs are kept under. */
export const front = (signal) =>
  run(
    `function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify(app.isNil() ? null : { pid: Number(app.processIdentifier), name: app.localizedName.js });
}`,
    [],
    signal,
  )

export const windows = (signal) =>
  run(
    `function run() {
  const rows = [];
  const allowed = trusted();
  for (const app of regularApps()) {
    const name = app.localizedName.isNil() ? '' : app.localizedName.js;
    const pid = Number(app.processIdentifier);
    const titles = allowed ? children($.AXUIElementCreateApplication(pid), 'AXWindows').map((w) => text(w, 'AXTitle')).filter((t) => t !== '') : [];
    if (titles.length === 0) rows.push({ Id: pid, ProcessName: name, MainWindowTitle: '' });
    for (const title of titles) rows.push({ Id: pid, ProcessName: name, MainWindowTitle: title });
    if (rows.length >= 40) break;
  }
  return JSON.stringify(rows.slice(0, 40));
}`,
    [],
    signal,
  )

/** Bring one app to the front, by process id — its windows with it. */
export const focus = (pid, signal) =>
  run(
    `function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (app.isNil()) return refuse('There is no app running with process id ' + argv[0] + '.');
  if (app.hidden) app.unhide;
  app.activateWithOptions($.NSApplicationActivateAllWindows);
  // Asking is not always enough since macOS 14, which lets the app in front decline to give way.
  // Accessibility can set it outright, and does when it is allowed to.
  if (trusted()) $.AXUIElementSetAttributeValue($.AXUIElementCreateApplication(Number(argv[0])), $('AXFrontmost'), $(true));
  return JSON.stringify({ ok: true });
}`,
    [Math.round(pid)],
    signal,
  )

// ---- the control tree ------------------------------------------------------------------------

/**
 * **The accessibility tree: macOS's answer to UI Automation**, and the reason `elements`, `read`
 * and `press` work the same way here as they do on Windows.
 *
 * Every control an app exposes has a role, a title or a description, an identifier, and a
 * position and size **in screen points** — exactly what a click needs and what a picture does
 * not carry. VoiceOver reads the same tree, which is why nearly every Mac app keeps it honest.
 *
 * Where it is blind is where UI Automation is blind: a game, a canvas, a remote desktop.
 */

/**
 * Where a walk starts, and the walk itself, shared by the three readers.
 *
 * By process id: that app's windows, then its menu bar — *File → Save* is a control too. By
 * title: the first window of any app whose title contains it. With neither: the focused window
 * of whatever is in front, which is what almost every request is about.
 */
const WALK = `
const VISIT = 2500;
const lower = (value) => String(value || '').toLowerCase();
function starts(argv) {
  const pid = Number(argv[0]), title = lower(argv[1]);
  if (pid > 0) {
    const app = $.AXUIElementCreateApplication(pid);
    const bar = get(app, 'AXMenuBar');
    return [...children(app, 'AXWindows'), ...(bar === null ? [] : [bar])];
  }
  if (title) {
    for (const running of regularApps()) {
      const found = children($.AXUIElementCreateApplication(Number(running.processIdentifier)), 'AXWindows').find((w) => lower(text(w, 'AXTitle')).includes(title));
      if (found) return [found];
    }
    return [];
  }
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.isNil()) return [];
  const app = $.AXUIElementCreateApplication(Number(front.processIdentifier));
  const window = get(app, 'AXFocusedWindow') || get(app, 'AXMainWindow');
  return window === null ? children(app, 'AXWindows').slice(0, 1) : [window];
}
function row(element) {
  const value = unwrap(get(element, 'AXValue'));
  const said = text(element, 'AXTitle') || text(element, 'AXDescription') || (typeof value === 'string' && value.length <= 80 ? value : '');
  const where = numbers(element, 'AXPosition', 'x', 'y'), size = numbers(element, 'AXSize', 'w', 'h');
  const shown = where !== null && size !== null && size[0] > 0 && size[1] > 0;
  return {
    name: said,
    // AXButton says Button in eleven fewer characters, on a list read by something paid by the token.
    type: text(element, 'AXRole').replace(/^AX/, ''),
    id: text(element, 'AXIdentifier'),
    x: shown ? Math.round(where[0] + size[0] / 2) : null,
    y: shown ? Math.round(where[1] + size[1] / 2) : null,
    w: shown ? Math.round(size[0]) : null,
    h: shown ? Math.round(size[1]) : null,
    off: !shown,
  };
}
const matches = (found, wanted) => lower(found.name).includes(wanted) || lower(found.id).includes(wanted);
function find(argv, skipStart) {
  const wanted = lower(argv[2]);
  const first = starts(argv);
  const queue = [...first];
  let seen = 0;
  while (queue.length > 0 && seen < VISIT) {
    const element = queue.shift();
    seen++;
    queue.push(...children(element));
    if (skipStart && first.includes(element)) continue;
    if (!wanted) return element;
    if (matches(row(element), wanted)) return element;
  }
  return null;
}
`

function treeElements({ pid, title, match, limit = 60 } = {}, signal) {
  const most = Math.min(300, Math.max(1, Math.round(Number(limit) || 60)))
  return run(
    `${WALK}
function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const wanted = lower(argv[2]), most = Number(argv[3]);
  const queue = starts(argv), rows = [], listed = {};
  let seen = 0;
  // Breadth first, for the reason windows.js gives: what a person means is near the top of a
  // window, and a depth-first walk that hits the cap spends it inside the first toolbar.
  while (queue.length > 0 && rows.length < most && seen < VISIT) {
    const element = queue.shift();
    seen++;
    const found = row(element);
    // A closed menu's items are not on screen, and there are dozens of them — the Apple menu
    // alone is twenty. Walked, they filled a sixty-row list before Calculator's keypad or its
    // display was reached. Listing stops at the menu bar's titles; *finding* one by name (press,
    // read, a match here) still walks into the menus, so "press Quit" still works.
    if (wanted || found.type !== 'MenuBarItem') queue.push(...children(element));
    if (found.name === '' && found.id === '') continue;
    if (wanted && !matches(found, wanted)) continue;
    // Chromium hangs one control under more than one parent, so a browser listed every tab and
    // the address bar two to four times over — half the list spent saying nothing new.
    const same = [found.name, found.id, found.type, found.x, found.y].join('|');
    if (listed[same]) continue;
    listed[same] = true;
    rows.push(found);
  }
  return JSON.stringify(rows);
}`,
    [Number(pid) > 0 ? Math.round(Number(pid)) : 0, typeof title === 'string' ? title.trim() : '', typeof match === 'string' ? match.trim() : '', most],
    signal,
  )
}

/**
 * What one control says: its value, its title or description, and for a container with no value
 * of its own, the words inside it — a scroll area holding a text view is how most Mac apps hold
 * a document, and *read the editor* should return the document.
 */
function treeRead({ pid, title, match } = {}, signal) {
  return run(
    `${WALK}
function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const element = find(argv, false);
  if (element === null) return JSON.stringify({ found: false });
  const found = row(element);
  const own = unwrap(get(element, 'AXValue'));
  let said = typeof own === 'string' ? own : own === null ? '' : String(own);
  if (said === '' && argv[2]) {
    const queue = children(element);
    let seen = 0;
    while (queue.length > 0 && said.length < 4000 && seen < 400) {
      const inside = queue.shift();
      seen++;
      const value = unwrap(get(inside, 'AXValue'));
      if (typeof value === 'string' && value !== '') said += (said ? '\\n' : '') + value;
      queue.push(...children(inside));
    }
  }
  if (said === '') said = found.name;
  // Direction marks are invisible and real: Calculator's display says "\\u200e9", and a check
  // that the display says 9 would fail on a character nobody can see.
  said = said.replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '');
  return JSON.stringify({ found: true, text: said.slice(0, 4000), name: found.name, type: found.type, x: found.x, y: found.y });
}`,
    [Number(pid) > 0 ? Math.round(Number(pid)) : 0, typeof title === 'string' ? title.trim() : '', typeof match === 'string' ? match.trim() : ''],
    signal,
  )
}

/**
 * Press a control **through the control itself**, with no pointer and no keystroke — the Mac
 * spelling of the UI Automation patterns, and the same order of preference: press, then pick,
 * then open its menu. Where it offers none, the point comes back for the caller to decide on.
 */
function treeInvoke({ pid, title, match } = {}, signal) {
  return run(
    `${WALK}
function run(argv) {
  if (!trusted()) return refuse(${JSON.stringify(NOT_TRUSTED)});
  const element = find(argv, true);
  if (element === null) return JSON.stringify({ found: false });
  const found = row(element);
  if (unwrap(get(element, 'AXEnabled')) === false) return JSON.stringify({ found: true, how: 'disabled', name: found.name });
  const listed = Ref();
  const actions = $.AXUIElementCopyActionNames(element, listed) === 0 ? (ObjC.deepUnwrap(ObjC.castRefToObject(listed[0])) || []) : [];
  const role = text(element, 'AXRole');
  const order = [['AXPress', role === 'AXCheckBox' || role === 'AXRadioButton' ? 'toggle' : 'invoke'], ['AXPick', 'select'], ['AXShowMenu', 'expand']];
  for (const [action, how] of order) {
    if (actions.includes(action) && $.AXUIElementPerformAction(element, $(action)) === 0) {
      return JSON.stringify({ found: true, how, name: found.name });
    }
  }
  return JSON.stringify({ found: true, how: 'none', name: found.name, x: found.x, y: found.y });
}`,
    [Number(pid) > 0 ? Math.round(Number(pid)) : 0, typeof title === 'string' ? title.trim() : '', String(match ?? '').trim()],
    signal,
  )
}

// ---- inside a web page ---------------------------------------------------------------------

/**
 * **A browser's page, read and pressed through the browser itself.**
 *
 * Chromium builds its accessibility tree for a page only when it believes a screen reader is
 * listening, and Comet refuses both ways of saying so (`AXManualAccessibility` answers
 * -25205, `AXEnhancedUserInterface` -25208). So a YouTube window listed forty-six controls —
 * tabs, the address bar, bookmarks — and not one of them on the page. Every browser that
 * answers AppleScript can run a line of JavaScript in its front tab instead, which lists the
 * page's buttons, links and fields in tens of milliseconds and presses them with no pointer.
 *
 * It needs *View → Developer → Allow JavaScript from Apple Events* in Chromium browsers
 * (*Develop → Allow JavaScript from Apple Events* in Safari), which is the person's to turn
 * on. Off, the page is simply not listed, and {@link webNote} says why.
 *
 * **The page script is this constant.** What a model asked for reaches it as one JSON string
 * argument, never as code.
 */
const BROWSERS = [
  'ai.perplexity.comet', 'com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary', 'org.chromium.Chromium',
  'com.brave.Browser', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera',
  'com.apple.Safari',
]

/**
 * In the page: every control a person could press or type into and can see now, in document
 * order, with its middle in screen points. `ask` is `{ match, press, read }`.
 */
const PAGE = `(function (ask) {
  const zoom = window.outerWidth / window.innerWidth || 1;
  const left = window.screenX, top = window.screenY + (window.outerHeight - window.innerHeight * zoom);
  const PICK = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=textbox],[role=searchbox],[role=combobox],[contenteditable=""],[contenteditable=true]';
  const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label) return clean(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = clean(by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ')); if (t) return t; }
    if (el.labels && el.labels[0]) { const t = clean(el.labels[0].innerText); if (t) return t; }
    const t = clean(el.innerText); if (t) return t.slice(0, 100);
    const img = el.querySelector && el.querySelector('img[alt]');
    return clean(el.getAttribute('title') || el.getAttribute('placeholder') || (img && img.alt) || (el.type !== 'password' ? el.value : ''));
  };
  const kind = (el) => {
    const role = el.getAttribute('role'), tag = el.tagName;
    if (role) return { button: 'Button', link: 'Link', tab: 'Tab', menuitem: 'MenuItem', checkbox: 'CheckBox', radio: 'RadioButton', switch: 'CheckBox', option: 'Option', textbox: 'TextField', searchbox: 'TextField', combobox: 'ComboBox' }[role] || 'Group';
    if (tag === 'A') return 'Link';
    if (tag === 'INPUT') return el.type === 'checkbox' ? 'CheckBox' : el.type === 'radio' ? 'RadioButton' : ['button', 'submit', 'reset', 'image'].includes(el.type) ? 'Button' : 'TextField';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'TextField';
    if (tag === 'SELECT') return 'PopUpButton';
    return 'Button';
  };
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll(PICK)) found.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const rows = [], els = [], seen = {};
  for (const el of found) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const name = nameOf(el);
    if (!name) continue;
    const x = Math.round(left + (r.left + r.width / 2) * zoom), y = Math.round(top + (r.top + r.height / 2) * zoom);
    const same = name + '|' + x + '|' + y;
    if (seen[same]) continue;
    seen[same] = true;
    rows.push({ name, type: kind(el), id: '', x, y, w: Math.round(r.width * zoom), h: Math.round(r.height * zoom), off: false, web: true,
      ...(el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.checked === true ? { on: true } : {}) });
    els.push(el);
    if (rows.length >= 300) break;
  }
  // What scrolls first, then what stays put. A header and a sidebar are fixed or sticky and
  // come first in the document, so a forty-row list was all navigation and no results.
  const pinned = new Map();
  const stays = (el) => {
    const chain = [];
    let at = el, answer = false;
    while (at && at !== document.documentElement) {
      if (pinned.has(at)) { answer = pinned.get(at); break; }
      chain.push(at);
      const position = getComputedStyle(at).position;
      if (position === 'fixed' || position === 'sticky') { answer = true; break; }
      at = at.parentElement || (at.getRootNode && at.getRootNode().host) || null;
    }
    for (const one of chain) pinned.set(one, answer);
    return answer;
  };
  const order = rows.map((row, at) => [stays(els[at]) ? 1 : 0, at]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, at]) => at);
  const sortedRows = order.map((at) => rows[at]), sortedEls = order.map((at) => els[at]);
  rows.length = 0; els.length = 0; rows.push(...sortedRows); els.push(...sortedEls);
  const wanted = String(ask.match || '').toLowerCase();
  if (!ask.press && !ask.read) return JSON.stringify({ url: location.href, ready: document.readyState, rows: wanted ? rows.filter((row) => row.name.toLowerCase().includes(wanted)) : rows });
  const at = rows.findIndex((row) => row.name.toLowerCase().includes(wanted));
  if (at < 0) return JSON.stringify({ found: false });
  const el = els[at], row = rows[at];
  if (ask.read) return JSON.stringify({ found: true, text: clean(el.value !== undefined && el.value !== '' ? el.value : el.innerText).slice(0, 4000) || row.name, name: row.name, type: row.type, x: row.x, y: row.y });
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return JSON.stringify({ found: true, how: 'disabled', name: row.name });
  el.focus();
  el.click();
  return JSON.stringify({ found: true, how: 'invoke', name: row.name });
})`

const IN_PAGE = `
function run(argv) {
  const pid = Number(argv[0]);
  const app = pid > 0 ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid) : $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app.isNil()) return JSON.stringify({ skip: true });
  const id = app.bundleIdentifier.isNil() ? '' : app.bundleIdentifier.js;
  if (!${JSON.stringify(BROWSERS)}.includes(id)) return JSON.stringify({ skip: true });
  const code = ${JSON.stringify(PAGE)} + '(' + argv[1] + ')';
  try {
    const browser = Application(id);
    if (browser.windows.length === 0) return JSON.stringify({ skip: true });
    const out = id === 'com.apple.Safari' ? browser.doJavaScript(code, { in: browser.windows[0].currentTab }) : browser.windows[0].activeTab.execute({ javascript: code });
    return JSON.stringify({ out: String(out || '') });
  } catch (error) {
    return JSON.stringify({ off: String((error && error.message) || error), browser: app.localizedName.js });
  }
}`

let lastWeb = ''
let lastPage

/** The address and load state of the page last read, or `undefined` when none was. */
export const pageState = () => lastPage

/** Why the page in front was not read, when it was not — a sentence for the model, or ''. */
export const webNote = () => lastWeb

/** Ask the browser's front tab. `undefined` when the app is no browser or the page cannot be read. */
async function page(pid, ask, signal) {
  const said = await run(IN_PAGE, [Number(pid) > 0 ? Math.round(Number(pid)) : 0, JSON.stringify(ask)], signal).catch(() => undefined)
  if (!said || said.skip) return undefined
  if (said.off !== undefined) {
    lastWeb = /turned off|Allow JavaScript/i.test(said.off) ?
        `${said.browser} would not let its page be read: turn on View → Developer → Allow JavaScript from Apple Events in ${said.browser} (the person has to do this), and the page’s buttons and links will be listed.`
      : `${said.browser}’s page could not be read (${said.off}).`
    return undefined
  }
  lastWeb = ''
  try {
    return JSON.parse(said.out)
  } catch {
    return undefined
  }
}

/**
 * The controls in a window: **the page first** when it is a browser's, then the window's own
 * tree — so a press by name and this list agree on which "Search" is meant.
 */
export async function elements({ pid, title, match, limit = 60 } = {}, signal) {
  const most = Math.min(300, Math.max(1, Math.round(Number(limit) || 60)))
  const web = title ? undefined : await page(pid, { match: match ?? '' }, signal)
  lastPage = web?.rows ? { url: web.url, ready: web.ready } : undefined
  const rows = web?.rows ?? []
  if (rows.length >= most) return rows.slice(0, most)
  return [...rows, ...(await treeElements({ pid, title, match, limit: most - rows.length }, signal))]
}

export async function readElement({ pid, title, match } = {}, signal) {
  if (match && !title) {
    const web = await page(pid, { match, read: true }, signal)
    if (web?.found) return web
  }
  return treeRead({ pid, title, match }, signal)
}

export async function invoke({ pid, title, match } = {}, signal) {
  if (match && !title) {
    const web = await page(pid, { match, press: true }, signal)
    if (web?.found) return web
  }
  return treeInvoke({ pid, title, match }, signal)
}
