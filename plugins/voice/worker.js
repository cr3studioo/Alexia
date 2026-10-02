// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as piperEngine from './piper.js'
import * as qwenEngine from './qwen.js'
import * as whisperEngine from './whisper.js'

/**
 * This plugin as a compute worker: the three pieces of inference, and what they need.
 *
 * **Only the model running is here.** Opening the microphone, playing a recording, reading the
 * file somebody pointed at, choosing a voice and asking the vendor's API are all the
 * interaction computer's and are in `index.js`. What is left is a recording in and words out,
 * or words in and a recording out — which is exactly what can be sent to another computer.
 *
 * Three operations rather than one, because they do not weigh the same. Whisper and Piper are
 * small programs that run beside a loaded chat model without anybody noticing. Qwen3-TTS is
 * a model of several gigabytes on the graphics card, and has to wait its turn like one.
 */

/** A recording in, the words in it out. */
export const RECOGNIZE = 'voice.recognize'
/** Words in, a recording out, in a Piper voice. */
export const SYNTHESIZE = 'voice.synthesize'
/** Words in, a recording out, in a voice cloned from a clip. */
export const IMITATE = 'voice.imitate'

const MB = 1e6

/** What a job says when the computer it was sent to has not been set up for it. */
const notSetUp = (what) => `${what} is not installed on the computer chosen for this. Install it from that computer’s setup list.`

const noPrebuilt = (what, setting) =>
  `There is no prebuilt ${what} for ${process.platform}/${process.arch}. Install one and set “${setting}” to it.`

/**
 * The three operations.
 *
 * `settings()` is this computer's own answers — where its programs are, how many threads it
 * has to give — because those are facts about the machine doing the work. What the *person*
 * chose travels in the plan: which size of model, which voice, what to say.
 *
 * `fetching(report, half, want)` is the download-on-first-use this plugin has always done, and
 * it is only ever called when `io.here` — the tool that planned this is in this process, with
 * the person watching its bar. A job from another computer never downloads: it writes what it
 * wanted into `wanted`, so the setup list can offer it, and says so.
 */
export function operations({ own, settings, fetching, wanted, hold, whisper = whisperEngine, piper = piperEngine, qwen = qwenEngine }) {
  const folder = () => {
    const dir = own()
    if (!dir) throw new Error('Alexia has not given this plugin a folder to work in.')
    return dir
  }
  const path = (value, what) => {
    if (typeof value !== 'string' || value === '') throw new Error(`There was no ${what} to work on.`)
    return value
  }

  return {
    async [RECOGNIZE](plan, { here = false, signal, report = () => {} } = {}) {
      const dir = folder()
      const file = path(plan?.file, 'recording')
      const mine = await settings()
      const size = whisper.MODELS[plan?.size] ? plan.size : mine.size
      if (!(await whisper.ready(dir, size, mine.hearing))) {
        if (!here) {
          await wanted.note('sizes', size)
          throw new Error(notSetUp(`The ${size} speech model`))
        }
        await fetching(report, 'hearing', { size })
      }
      const found = await whisper.programs(dir, size, mine.hearing)
      const held = hold(signal)
      try {
        return { text: whisper.spoken(await whisper.transcribe({ ...found, file, threads: mine.threads, signal: held.signal })) }
      } finally {
        held.done()
      }
    },

    async [SYNTHESIZE](plan, { here = false, signal, report = () => {} } = {}) {
      const dir = folder()
      const voice = path(plan?.voice, 'voice')
      const text = path(plan?.text, 'text')
      const mine = await settings()
      // A voice somebody added arrives with the job, as its two files. A published one is
      // this computer's to have, and is the only kind there is anything to download for.
      const sent = typeof plan.model === 'string' && typeof plan.config === 'string'
      const ready = async () =>
        sent ? (await piper.programs(dir, voice, mine.speaking)) !== undefined : piper.ready(dir, voice, mine.speaking)
      if (!(await ready())) {
        if (!here) {
          await wanted.note('voices', voice)
          throw new Error(notSetUp(sent ? 'Piper' : `The ${voice} voice`))
        }
        // Only when somebody asked to hear it for real. *Hear it* on a card should not spend
        // sixty megabytes and a minute to answer.
        if (plan.fetch === true) await fetching(report, 'speaking', { voice })
        if (!(await ready())) throw new Error(`${voice} is not downloaded yet. Choose it and it arrives the first time it speaks.`)
      }
      const there = await piper.programs(dir, voice, mine.speaking)
      // One file, overwritten, on the computer the person is at — where the next thing said
      // replaces it. A worker may be saying two things at once, so each of its gets its own.
      const wav = here ? there.wav : join(dir, `spoken-${randomUUID()}.wav`)
      const held = hold(signal)
      try {
        await piper.say({ ...there, ...(sent && { model: plan.model, config: plan.config }), wav, text, signal: held.signal })
        return { files: [wav] }
      } finally {
        held.done()
      }
    },

    async [IMITATE](plan, { here = false, signal } = {}) {
      const dir = folder()
      const voice = path(plan?.voice, 'voice')
      const text = path(plan?.text, 'text')
      const clip = path(plan?.clip, 'recording of the voice')
      const { qwen: python } = await settings()
      // Never installed on anybody's behalf, here or anywhere: this engine is a Python that
      // is already on the machine, or it is a sentence saying there is none.
      if (!python) throw new Error(`${voice} is a Qwen3-TTS voice and no Python has been pointed at.`)
      const out = here ? qwen.where(dir, voice).out : join(dir, `imitated-${randomUUID()}.wav`)
      const held = hold(signal)
      try {
        await qwen.speak({ python, clip, transcript: String(plan.transcript ?? ''), text, out, signal: held.signal })
        return { files: [out] }
      } finally {
        held.done()
      }
    },
  }
}

/** How many of the things other computers asked for are remembered. The list is a prompt, not a history. */
const REMEMBERED = 6

/**
 * What jobs wanted that this computer did not have.
 *
 * A setup list can only offer what it knows somebody wants. The voice and the model size are
 * chosen on the computer the person sits at, so the first job that asks for one this computer
 * lacks is how it finds out — and writing that down is what turns *it failed* into a button.
 */
export function wanting(storage) {
  const read = async () => {
    const said = await storage.get('wanted').catch(() => undefined)
    const list = (key) => (Array.isArray(said?.[key]) ? said[key].filter((one) => typeof one === 'string') : [])
    return { sizes: list('sizes'), voices: list('voices') }
  }
  return {
    read,
    async note(kind, value) {
      const said = await read()
      if (said[kind].includes(value)) return
      await storage.set('wanted', { ...said, [kind]: [...said[kind], value].slice(-REMEMBERED) }).catch(() => {})
    },
  }
}

/**
 * What is missing before the operations can run on this computer, with sizes.
 *
 * One line per thing somebody would actually press: hearing at a given size, speaking in a
 * given voice. Each carries the megabytes of whatever half of it is absent — the program, the
 * model, or both — because that is the number the person is agreeing to. A platform with no
 * prebuilt program is not a download at all, and says what to do instead.
 */
export async function requirements({ own, chosen, wanted = { sizes: [], voices: [] }, whisper = whisperEngine, piper = piperEngine }) {
  if (!own) return []
  const found = []
  const once = (one) => {
    if (!found.some((other) => other.id === one.id)) found.push(one)
  }

  const sizes = [...new Set([chosen.size, ...wanted.sizes])].filter((size) => whisper.MODELS[size])
  for (const size of sizes) {
    if (await whisper.ready(own, size, chosen.hearing)) continue
    if (!whisper.build() && !chosen.hearing) {
      once({
        id: 'whisper',
        kind: 'runtime',
        title: 'Whisper',
        action: 'instructions',
        instructions: noPrebuilt('Whisper', 'Whisper program'),
        blocks: [RECOGNIZE],
      })
      continue
    }
    const lacking = await whisper.lacking(own, size, chosen.hearing)
    if (lacking.mb === 0) {
      // Everything Alexia would fetch is here, so what is missing is the program somebody
      // pointed at — and that is theirs to put right, not a download.
      once({
        id: 'whisper',
        kind: 'runtime',
        title: 'Whisper',
        action: 'instructions',
        instructions: '“Whisper program” points at something that is not there. Clear it and Alexia can download one, or point it at one that is.',
        blocks: [RECOGNIZE],
      })
      continue
    }
    once({
      id: `hearing:${size}`,
      kind: 'model',
      title: lacking.program ? `Whisper and its ${size} speech model` : `The ${size} speech model`,
      detail: 'Turns a recording into text on this computer.',
      bytes: lacking.mb * MB,
      action: 'install',
      blocks: [RECOGNIZE],
    })
  }

  // The voice this computer has chosen counts only while Piper is the engine it chose.
  const voices = [...new Set([...(chosen.family === 'piper' && chosen.voice ? [chosen.voice] : []), ...wanted.voices])]
  for (const voice of voices) {
    if (await piper.ready(own, voice, chosen.speaking)) continue
    if (!piper.build() && !chosen.speaking) {
      once({
        id: 'piper',
        kind: 'runtime',
        title: 'Piper',
        action: 'instructions',
        instructions: noPrebuilt('Piper', 'Piper program'),
        blocks: [SYNTHESIZE],
      })
      continue
    }
    const lacking = await piper.lacking(own, voice, chosen.speaking)
    // A voice somebody added travels with each job, so only the program can be missing for it.
    if (!lacking.program && !lacking.voice) continue
    const published = piper.VOICES[voice] !== undefined
    once({
      id: published ? `speaking:${voice}` : 'speaking',
      kind: lacking.voice ? 'model' : 'runtime',
      title:
        !published ? 'Piper'
        : lacking.program ? `Piper and the ${voice} voice`
        : `The ${voice} voice`,
      detail: 'Speaks text on this computer.',
      bytes: lacking.mb * MB,
      action: 'install',
      blocks: [SYNTHESIZE],
    })
  }

  if (!chosen.qwen) {
    once({
      id: 'qwen',
      kind: 'dependency',
      title: 'Qwen3-TTS',
      detail: 'Speaks in a voice cloned from a recording. Alexia never installs it for you.',
      action: 'instructions',
      instructions:
        'Install qwen-tts into a Python on this computer, then put that Python’s path in this plugin’s “Qwen program” setting.',
      blocks: [IMITATE],
    })
  }
  return found
}

/**
 * Install one requirement: the half of this plugin it names, at the size or voice it names.
 *
 * Called only from the `install` hook, which core calls only after a person pressed the
 * button beside that requirement. These are the same two downloads the *Download* button on
 * this computer has always run — `whisper.install` and `piper.install` — and nothing else.
 */
export async function installing(requirementId, { own, chosen, report, whisper = whisperEngine, piper = piperEngine }) {
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  const [half, name] = String(requirementId).split(':')
  if (half === 'hearing' && whisper.MODELS[name]) return void (await whisper.install(own, name, chosen.hearing, report))
  if (half === 'speaking' && (name === undefined || piper.VOICES[name])) {
    // With no voice named it is the program alone: a voice nobody published has no download.
    return void (await piper.install(own, name ?? '', chosen.speaking, report))
  }
  throw new Error('There is nothing here to install by that name.')
}
