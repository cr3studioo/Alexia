// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answer in the form the question arrived in (#8).
 *
 * The old setting was a toggle: `voice_notes` on meant every answer became a voice bubble,
 * whatever the message was. That is right for somebody who always wants to hear Alexia and
 * wrong for everybody else — a typed question answered as a voice note is a reply that has to
 * be unmuted on a bus, and a voice note answered as a wall of text is the opposite annoyance.
 * `mirror` is the new default: the reply matches how the question came in, and the two ends
 * (`never`, `always`) are still there for whoever actually does want one behaviour always.
 *
 * The migration is the point of keeping `voiceMode` and `speaks` apart from the settings
 * object itself — an old install has `voice_notes: true` sitting in storage forever, and it
 * has to keep meaning what it meant, which is `always`, not silently become `mirror` the day
 * this ships.
 */

/** The three choices `voice_replies` can be — anything else in storage is not one of them. */
export const VOICE_MODES = ['never', 'mirror', 'always']

/** The mode in effect, reading the new setting first and falling back to the old toggle. */
export function voiceMode(settings) {
  const chosen = settings?.voice_replies
  if (VOICE_MODES.includes(chosen)) return chosen
  if (settings?.voice_notes === true) return 'always'
  return 'mirror'
}

/** Whether this particular answer should be spoken, given the mode and how the question came in. */
export function speaks(mode, cameAsVoice) {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return cameAsVoice === true
}
