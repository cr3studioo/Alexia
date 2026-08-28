// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { build, MODELS, passes, spoken, where } from '../whisper.js'

/**
 * The parts of Voice that are logic rather than a subprocess. Downloading Whisper and
 * opening a microphone are verified by running them; what needs a test is the reading of
 * what the program printed, because that is where a wrong answer looks like a right one.
 */

test('the timestamps whisper-stream cannot be told to omit come off here', () => {
  // `whisper-cli` takes `-nt`. Its streaming sibling has no such flag, so every line it
  // prints arrives wearing one of these.
  expect(
    spoken('[00:00:00.000 --> 00:00:04.000]   And so my fellow Americans,\n[00:00:04.000 --> 00:00:06.000]   ask not.'),
  ).toBe('And so my fellow Americans,\nask not.')
})

test('a quiet room comes back empty rather than as the words “blank audio”', () => {
  // Whisper does not answer silence with nothing. Handed on unedited, these become a model
  // being told that somebody said them.
  for (const quiet of ['[BLANK_AUDIO]', '[ Inaudible ]', '(silence)', '   ']) {
    expect(spoken(quiet), quiet).toBe('')
  }
  expect(spoken('[00:00:00.000 --> 00:00:04.000]   [ Inaudible ]')).toBe('')
})

test('something said next to something not said keeps only the said part', () => {
  expect(spoken('[BLANK_AUDIO]\n[00:00:04.000 --> 00:00:06.000]   Hello.\n(silence)')).toBe('Hello.')
})

test('every model this plugin offers has a file and a size to warn about', () => {
  // The manifest's `choice` options and this table have to agree, or a person picks a size
  // the code then quietly substitutes.
  expect(Object.keys(MODELS).sort()).toEqual(['base', 'small', 'tiny'])
  for (const [size, model] of Object.entries(MODELS)) {
    expect(model.file, size).toMatch(/^ggml-.+\.bin$/)
    expect(model.mb, size).toBeGreaterThan(0)
  }
})

test('everything downloaded lands inside the one directory a purge removes', () => {
  const own = where('/somewhere/own', 'base')
  // Invariant 5 in one assertion: if either of these escaped `ownDir`, deleting the folder
  // would leave hundreds of megabytes behind and nothing would say so.
  expect(own.bin.startsWith('/somewhere/own') || own.bin.includes('somewhere')).toBe(true)
  expect(own.model).toContain(MODELS.base.file)
  expect(own.model.replace(/\\/g, '/')).toContain('/somewhere/own/models/')
})

test('a platform with no prebuilt Whisper says so rather than guessing at one', () => {
  // `build()` answering undefined is what turns into “point at a Whisper program” on the
  // settings screen. It must never fall back to a build for a different machine.
  const spec = build()
  expect(spec === undefined || typeof spec.url === 'string').toBe(true)
  if (spec) expect(spec.url).toContain(process.arch === 'x64' ? 'x64' : process.arch)
})

test('a pass with words in it ends the wait; a pass over a quiet room does not', () => {
  const spoke = []
  const read = passes((words) => spoke.push(words))

  read('[Start speaking]\n\n')
  // Whisper's answer to silence. Reporting it would end the wait on the first cough.
  read('### Transcription 0 START | t0 = 0 ms | t1 = 3924 ms\n\n[00:00:00.000 --> 00:00:10.000]   [BLANK_AUDIO]\n\n### Transcription 0 END\n\n')
  expect(spoke).toEqual([])

  // Then somebody speaks. Two segments in one pass, each wearing a timestamp that this
  // program — unlike its file-reading sibling — has no flag to suppress.
  read('### Transcription 1 START | t0 = 4000 ms | t1 = 12000 ms\n\n[00:00:00.000 --> 00:00:04.000]   And so my fellow Americans,\n')
  // Arriving split down the middle of a line, because a pipe does that.
  read('[00:00:04.000 --> 00:00:06.000]   ask not.\n\n### Transcription 1 END\n\n')
  expect(spoke).toEqual(['And so my fellow Americans,\nask not.'])
})

test('what one pass heard is not carried into the next', () => {
  const spoke = []
  const read = passes((words) => spoke.push(words))
  read('### Transcription 0 START |\n\nHello.\n\n### Transcription 0 END\n')
  read('### Transcription 1 START |\n\n[BLANK_AUDIO]\n\n### Transcription 1 END\n')
  // The second pass heard nothing, and must not be handed the first pass's sentence.
  expect(spoke).toEqual(['Hello.'])
})
