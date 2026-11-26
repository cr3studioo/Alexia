// SPDX-License-Identifier: AGPL-3.0-only
import { cut, MAX_BUTTONS, wantsAnswer } from './notify.js'

/**
 * macOS: `osascript`, with the Standard Additions every Mac has. A notice that asks for
 * something is a `display dialog` (buttons, and `default answer` for a reply box); anything
 * else is a `display notification`. A low-urgency notice is never a dialog.
 *
 * The script is JavaScript for Automation rather than AppleScript so that it can read the
 * notice from stdin as UTF-8 JSON: nothing of the notice is ever part of the code or of argv,
 * which every process on the machine can read.
 *
 * It does not activate itself. A dialog that took the keyboard would collect whatever the
 * owner was in the middle of typing.
 */

const MAX_TEXT = 2000

/** Reads `{ mode, title, text, sound, buttons, actions, defaultButton, cancel, reply }`. */
export const SCRIPT = `
ObjC.import('Foundation')
function run() {
  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const notice = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)))
  const say = (line) =>
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(line) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const app = Application.currentApplication()
  app.includeStandardAdditions = true
  if (notice.mode === 'notification') {
    const options = { withTitle: notice.title }
    if (notice.sound) options.soundName = 'default'
    app.displayNotification(notice.text, options)
    say({ shown: true })
    return
  }
  const options = { withTitle: notice.title, buttons: notice.buttons }
  if (notice.reply) options.defaultAnswer = ''
  if (notice.defaultButton) options.defaultButton = notice.defaultButton
  if (notice.sound) app.beep()
  say({ shown: true })
  try {
    const pressed = app.displayDialog(notice.text, options)
    say({ action: notice.actions[notice.buttons.indexOf(pressed.buttonReturned)], text: pressed.textReturned })
  } catch (error) {
    // -128 is how a dialog says Cancel (a button of that name, or Escape).
    if (error.errorNumber !== -128) throw error
    say({ action: notice.cancel })
  }
}
`

/**
 * The dialog's buttons, left to right, with the action each one reports. The owner's buttons
 * come first in line for the three places; then one to send a reply, then one to close. With
 * three buttons of their own, a typed reply goes back with whichever is pressed.
 */
export function dialogButtons(notice) {
  const taken = new Set(notice.buttons.map((b) => b.label.toLowerCase()))
  const free = (...names) => names.find((name) => !taken.has(name.toLowerCase()))
  const buttons = notice.buttons.map((b, n) => ({ label: b.label, action: `b${String(n)}` }))
  let send
  if (notice.reply && buttons.length < MAX_BUTTONS) {
    send = free('Reply', 'Send', 'Send reply')
    buttons.push({ label: send, action: 'send' })
  }
  if (buttons.length < MAX_BUTTONS) buttons.unshift({ label: free('Close', 'Dismiss', 'Not now'), action: 'close' })
  return { buttons, send }
}

/** What the script is handed on stdin. */
export function dialogRequest(notice) {
  const sound = notice.urgency === 'urgent'
  const text = cut(notice.text, MAX_TEXT)
  const title = notice.title
  if (!wantsAnswer(notice) || notice.urgency === 'low') return { mode: 'notification', title, text, sound }
  const { buttons, send } = dialogButtons(notice)
  return {
    mode: 'dialog',
    title,
    text,
    sound,
    buttons: buttons.map((b) => b.label),
    actions: buttons.map((b) => b.action),
    // Only a reply has a default, so Return sends what was typed and never picks a choice.
    ...(send !== undefined && { defaultButton: send }),
    cancel: buttons.find((b) => b.label.toLowerCase() === 'cancel')?.action ?? 'close',
    reply: notice.reply,
  }
}

export const macos = {
  plan(notice) {
    const request = dialogRequest(notice)
    const asks = request.mode === 'dialog'
    return {
      command: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', SCRIPT],
      input: JSON.stringify(request),
      asks,
      // A dialog is on screen only while osascript runs.
      stays: asks,
    }
  },
  read(line) {
    if (line.shown === true) return { type: 'shown' }
    if (typeof line.action === 'string') return { type: 'action', action: line.action, text: typeof line.text === 'string' ? line.text : '' }
    return undefined
  },
}
