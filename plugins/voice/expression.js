// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a reply is spoken, rather than whether it is (M7-4).
 *
 * `[marker]` tags placed inline, mid-sentence, at no token and no latency cost — the
 * difference between a voice and a reading. The S2 family reads them out of the text itself,
 * which is why this is possible at all: there is no second parameter to tune and no second
 * request to make.
 *
 * **It is a cloud-engine capability and it says so.** Piper has no expression control of any
 * kind, and the predecessor proved the sampling-parameter trick inert on this machine — two
 * runs forced to greedy decoding returned audio of different lengths, so the sampler never
 * saw those parameters. With a local voice selected this is *off and says so*, rather than
 * a switch that appears to work.
 *
 * **The vocabulary is not invented.** Every tag below is quoted from the vendor's own
 * published emotion reference (2026-08-13). Beyond instructing the model to use only these,
 * its output is **filtered** against them afterwards — because an unrecognised tag is not
 * dropped by the engine, it is *spoken*, and a model inventing `[sultry]` would ship a
 * literal bracket into the audio.
 *
 * **A model call rather than a keyword table**, because keyword matching cannot tell *I'm
 * fine.* from *I'm fine!* and that judgement is the whole feature.
 */

const BASIC = [
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'satisfied',
  'delighted', 'scared', 'worried', 'upset', 'frustrated', 'depressed', 'empathetic',
  'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful', 'curious', 'sarcastic',
]
const ADVANCED = [
  'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain', 'doubtful',
  'confused', 'disappointed', 'regretful', 'guilty', 'ashamed', 'jealous', 'envious', 'hopeful',
  'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored', 'contemptuous', 'sympathetic',
  'compassionate', 'determined', 'resigned',
]
const TONE = ['in a hurry tone', 'shouting', 'screaming', 'whispering', 'soft tone', 'emphasis']
const EFFECTS = [
  'laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing', 'groaning', 'panting',
  'gasping', 'yawning', 'snoring', 'clear throat',
]
const PAUSES = ['break', 'long-break']

export const MARKERS = new Set([...BASIC, ...ADVANCED, ...TONE, ...EFFECTS, ...PAUSES])

/**
 * How many survive one reply.
 *
 * The vendor's own guidance is at most three combined emotions per sentence, and a spoken
 * reply here is a couple of sentences by design because length is latency. More than this is
 * a model decorating rather than acting.
 */
export const MAX = 6

const TAG = /\[([^[\]]{1,40})\]/g

/** The speakable text, with every tag taken out. */
export const strip = (text) => String(text ?? '').replace(/\s*\[[^[\]]{1,40}\]\s*/g, ' ').trim()

/** Letters and digits only: whitespace around an inserted tag may legitimately move. */
const bones = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Keep the real markers, drop the invented ones — and throw the whole annotation away if the
 * words changed.
 *
 * Two failure modes, both of which put literal bracket text into somebody's ears:
 *
 * - the model inventing a plausible-sounding marker, and
 * - the model decorating every clause until the delivery is a caricature.
 *
 * And one worse than either: **the annotator rewriting what was said.** Its job is to mark
 * up, never to edit, so if the stripped text no longer matches the original the annotation
 * is discarded entirely and the original words are spoken plainly. A voice that says
 * something slightly different from the answer on screen is a bug nobody can see.
 */
export function sanitize(annotated, original) {
  if (!annotated) return original
  let kept = 0
  const cleaned = String(annotated)
    .replace(TAG, (_whole, tag) => {
      const marker = String(tag).trim().toLowerCase()
      if (!MARKERS.has(marker) || kept >= MAX) return ''
      kept += 1
      return `[${marker}]`
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return bones(strip(cleaned)) === bones(original) ? cleaned : original
}

/** The instruction. Closed, and the list of markers is in it rather than described. */
export const prompt = (text) =>
  [
    'You add speech-delivery markers to text that is about to be spoken aloud.',
    '',
    'Rules, all absolute:',
    '1. Return the SAME text, word for word. Never reword, shorten, translate, add or remove',
    '   a word. You only insert markers.',
    '2. Markers are square brackets, like [happy] or [sighing].',
    '3. Use ONLY markers from this list:',
    `   ${[...MARKERS].join(', ')}`,
    '4. An emotion marker goes at the START of the sentence it applies to. Tone markers and',
    '   sound effects may go anywhere, including mid-sentence.',
    `5. At most ${String(MAX)} markers in total. Fewer is better. None is a fine answer.`,
    '6. Return the marked-up text and nothing else — no explanation, no quotes.',
    '',
    'Text:',
    text,
  ].join('\n')
