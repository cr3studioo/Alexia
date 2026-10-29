// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answer in the form the question arrived in — the window's half of what Telegram's
 * `reply.js` already does for a phone.
 *
 * Three answers to one question, *when does she say it out loud*: `never`, every reply is
 * text; `mirror`, the default, a reply is spoken when the question was — heard through the
 * microphone during that task; `always`, every reply is spoken, typed questions too. Asking
 * for something to be read out still works under `never`: that is a request, and this setting
 * is only about what happens when nobody asked.
 */

/** The three choices `speak_replies` can be — anything else in storage is not one of them. */
export const REPLY_MODES = ['never', 'mirror', 'always']

/** The mode in effect, with the manifest's default for anything that is not one of the three. */
export function replyMode(settings) {
  const chosen = settings?.speak_replies
  return REPLY_MODES.includes(chosen) ? chosen : 'mirror'
}

/**
 * Whether this answer should be spoken.
 *
 * `spoke` is the model having already said something out loud during the task — somebody who
 * asked *read me that* has heard it, and hearing the whole answer a second time straight after
 * is the opposite of what they asked for.
 */
export function speaksReply(mode, { heard = false, spoke = false } = {}) {
  if (spoke || mode === 'never') return false
  return mode === 'always' || heard
}

/**
 * An answer written to be read, made into one to be heard.
 *
 * A model answers in Markdown, and a speech engine reads what it is given: asterisks,
 * backticks, a URL letter by letter and a code block symbol by symbol. So the marks go and the
 * words stay. Code is not read out at all — nobody follows a function by ear — and is
 * replaced by a sentence saying it is on the screen.
 */
export function aloud(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' There is some code on the screen. ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link on the screen')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}
