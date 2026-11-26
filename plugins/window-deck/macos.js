// SPDX-License-Identifier: AGPL-3.0-only
import { createBackend, runProgram } from './backend.js'

/**
 * macOS, through `osascript`'s JavaScript: System Events for the windows, AppKit for the screens
 * and the running apps.
 *
 * Reading and moving another app's windows needs *Accessibility*, which macOS grants to Alexia,
 * the app responsible for this process. Quitting and opening an app need no permission.
 *
 * Two places a Mac differs from Windows:
 *
 * - **A window has no number** System Events will give. Its id here is the process, its place in
 *   that app's list and its title; it is found again by title, and an id whose title is gone is
 *   refused rather than guessed at.
 * - **There is no maximise.** The green button is full screen. *Maximise* here fills the screen
 *   below the menu bar and beside the Dock, which is not something *restore* can undo.
 *
 * Coordinates are points from the top left of the main display, as the accessibility API counts.
 */

export const SCRIPT = `
ObjC.import('AppKit');
ObjC.import('ApplicationServices');

var NOT_TRUSTED = 'macOS has not allowed Alexia to control this Mac, so nothing was done. Turn Alexia on in ' +
  'System Settings → Privacy & Security → Accessibility, then try again.';

function safe(read, otherwise) { try { return read(); } catch (error) { return otherwise; } }
// The run loop has to turn for AppKit to notice that an app started or quit.
function turn(seconds) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds)); }

function screens() {
  var all = $.NSScreen.screens, out = [];
  var height = all.objectAtIndex(0).frame.size.height;
  function box(r) { return { x: r.origin.x, y: height - (r.origin.y + r.size.height), w: r.size.width, h: r.size.height }; }
  for (var i = 0; i < all.count; i++) {
    var screen = all.objectAtIndex(i), whole = box(screen.frame);
    out.push({ x: whole.x, y: whole.y, w: whole.w, h: whole.h, work: box(screen.visibleFrame), primary: i === 0 });
  }
  return out;
}

// The apps a person sees in the Dock.
function apps() {
  var all = $.NSWorkspace.sharedWorkspace.runningApplications, out = [];
  for (var i = 0; i < all.count; i++) {
    var app = all.objectAtIndex(i);
    if (Number(app.activationPolicy) !== 0) continue;
    out.push({
      handle: app,
      pid: Number(app.processIdentifier),
      name: app.localizedName.isNil() ? '' : app.localizedName.js,
      path: app.bundleURL.isNil() ? '' : app.bundleURL.path.js
    });
  }
  return out;
}

function windowsOf(pid) {
  var found = safe(function () { return Application('System Events').applicationProcesses.whose({ unixId: pid })(); }, []);
  if (found.length === 0) return [];
  var all = safe(function () { return found[0].windows(); }, []);
  return all.filter(function (w) {
    var kind = safe(function () { return w.subrole(); }, '');
    return kind !== 'AXFloatingWindow' && kind !== 'AXSystemFloatingWindow' && kind !== 'AXUnknown';
  });
}

function titleOf(w) { return String(safe(function () { return w.name(); }, '') || ''); }
function flag(w, name) { return safe(function () { return w.attributes.byName(name).value(); }, false) === true; }
function setFlag(w, name, value) { w.attributes.byName(name).value = value; }

function boxOf(w) {
  var at = w.position(), size = w.size();
  return { x: at[0], y: at[1], w: size[0], h: size[1] };
}

function screenOf(box, all) {
  var x = box.x + box.w / 2, y = box.y + box.h / 2;
  var holding = all.filter(function (s) { return x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h; });
  return holding[0] || all.filter(function (s) { return s.primary; })[0] || all[0];
}

function near(a, b) { return Math.abs(a - b) <= 2; }

function row(app, w, index, all) {
  var title = titleOf(w), box = boxOf(w), work = screenOf(box, all).work;
  return {
    id: app.pid + ':' + index + ':' + title,
    app: app.name,
    title: title,
    x: box.x, y: box.y, w: box.w, h: box.h,
    minimized: flag(w, 'AXMinimized'),
    maximized: flag(w, 'AXFullScreen') || (near(box.x, work.x) && near(box.y, work.y) && near(box.w, work.w) && near(box.h, work.h)),
    path: app.path
  };
}

function list() {
  var all = screens(), rows = [];
  apps().forEach(function (app) {
    windowsOf(app.pid).forEach(function (w, index) {
      var one = safe(function () { return row(app, w, index, all); }, null);
      if (one !== null) rows.push(one);
    });
  });
  return { windows: rows, monitors: all };
}

// The window an id names: at its old place when the title still matches, else wherever that title is now.
function find(id) {
  var parts = /^([0-9]+):([0-9]+):([\\s\\S]*)$/.exec(String(id));
  if (parts === null) return null;
  var pid = Number(parts[1]), index = Number(parts[2]), title = parts[3];
  var app = apps().filter(function (a) { return a.pid === pid; })[0];
  if (!app) return null;
  var all = windowsOf(pid);
  if (all[index] && titleOf(all[index]) === title) return { app: app, window: all[index], index: index, title: title };
  for (var i = 0; i < all.length; i++) if (titleOf(all[i]) === title) return { app: app, window: all[i], index: i, title: title };
  return null;
}

function sameTitle(pid, title) { return windowsOf(pid).filter(function (w) { return titleOf(w) === title; }).length; }

function change(op) {
  var found = find(op.id);
  if (found === null) return { id: op.id, ok: false, gone: true, why: 'That window is gone, or its title changed. List the windows again.' };
  var w = found.window, why = '', unchanged = false, gone = false;
  try {
    if (op.rect) {
      if (flag(w, 'AXFullScreen')) { setFlag(w, 'AXFullScreen', false); delay(1); }
      if (flag(w, 'AXMinimized')) { setFlag(w, 'AXMinimized', false); delay(0.3); }
      var now = boxOf(w);
      var pick = function (key) { return op.rect[key] === undefined || op.rect[key] === null ? now[key] : op.rect[key]; };
      var x = pick('x'), y = pick('y'), width = pick('w'), height = pick('h');
      // Placed, sized, placed again: a window is held to the screen it is on while it resizes.
      w.position = [x, y];
      w.size = [width, height];
      w.position = [x, y];
    }
    if (op.then === 'minimize') {
      setFlag(w, 'AXMinimized', true);
    } else if (op.then === 'maximize') {
      if (flag(w, 'AXMinimized')) { setFlag(w, 'AXMinimized', false); delay(0.3); }
      var work = screenOf(boxOf(w), screens()).work;
      w.position = [work.x, work.y];
      w.size = [work.w, work.h];
      w.position = [work.x, work.y];
    } else if (op.then === 'restore') {
      if (flag(w, 'AXMinimized')) setFlag(w, 'AXMinimized', false);
      else if (flag(w, 'AXFullScreen')) setFlag(w, 'AXFullScreen', false);
      else unchanged = true;
    } else if (op.then === 'close') {
      var before = sameTitle(found.app.pid, found.title);
      var buttons = w.buttons.whose({ subrole: 'AXCloseButton' })();
      if (buttons.length === 0) {
        why = 'That window has no close button.';
      } else {
        buttons[0].click();
        for (var i = 0; i < 20 && !gone; i++) { delay(0.1); gone = sameTitle(found.app.pid, found.title) < before; }
      }
    }
  } catch (error) {
    why = 'macOS would not change that window: ' + String((error && error.message) || error);
  }
  var result = { id: op.id, ok: why === '', why: why, gone: gone, unchanged: unchanged };
  if (!gone) {
    var seen = safe(function () { return row(found.app, w, found.index, screens()); }, null);
    if (seen !== null) result.window = seen;
  }
  return result;
}

function quit(ask) {
  var wanted = String(ask.app).toLowerCase(), spare = ask.spare || [];
  var targets = apps().filter(function (a) { return a.name.toLowerCase() === wanted && spare.indexOf(a.pid) === -1; });
  var trusted = $.AXIsProcessTrusted();
  function count() { return targets.reduce(function (sum, a) { return sum + (a.handle.terminated ? 0 : windowsOf(a.pid).length); }, 0); }
  function running() { return targets.filter(function (a) { return !a.handle.terminated; }).length; }
  var windows = trusted ? count() : null;
  targets.forEach(function (a) { if (ask.force) a.handle.forceTerminate; else a.handle.terminate; });
  for (var waited = 0; waited < ask.waitMs && running() > 0; waited += 200) turn(0.2);
  return { found: targets.length, windows: windows, open: trusted && running() > 0 ? count() : 0, running: running() };
}

function open(ask) {
  var space = $.NSWorkspace.sharedWorkspace;
  var done = ask.path ? space.openURL($.NSURL.fileURLWithPath($(ask.path))) : false;
  if (!done) done = space.launchApplication($(ask.app));
  return done ? { opened: true } : { refused: 'macOS could not open ' + ask.app + '.' };
}

function run(argv) {
  var ask = JSON.parse(argv[0]);
  if ((ask.do === 'list' || ask.do === 'apply') && !$.AXIsProcessTrusted()) return JSON.stringify({ refused: NOT_TRUSTED });
  if (ask.do === 'list') return JSON.stringify(list());
  if (ask.do === 'apply') return JSON.stringify({ results: ask.ops.map(change) });
  if (ask.do === 'quit') return JSON.stringify(quit(ask));
  if (ask.do === 'open') return JSON.stringify(open(ask));
  return JSON.stringify({ refused: 'That is not something this can do with windows.' });
}
`

/** The real runner: the question is the script's one argument, never part of its text. */
export const osascript = (script, question, signal) =>
  runProgram('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(question)], {
    signal,
    explain: (complaint) =>
      complaint
        .replace(/^.*execution error:\s*(Error:\s*)*/s, '')
        .replace(/\s*\(-?\d+\)$/, '')
        .trim(),
  })

export const macosBackend = ({ run = osascript } = {}) => createBackend(run, SCRIPT)
