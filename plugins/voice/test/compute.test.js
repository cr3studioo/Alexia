// SPDX-License-Identifier: AGPL-3.0-only
import { readManifest } from '@alexia/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { holding, split } from '../compute.js'
import * as piper from '../piper.js'
import * as whisper from '../whisper.js'
import { IMITATE, RECOGNIZE, SYNTHESIZE, installing, operations, requirements, wanting } from '../worker.js'

/**
 * Voice as a compute worker (remote-compute.md §4).
 *
 * What is held still here is the line itself: the model running is an operation and may be on
 * another computer, and everything about the person — their microphone, their speakers, their
 * files — is not. Then the three things a worker owes the computer it runs on: it says what
 * is missing and how big it is, it downloads only when told to, and it lets go when asked.
 *
 * Nothing is downloaded and no model is run. Whisper, Piper and Qwen are stand-ins that write
 * down what they were asked; the reading of what is on disk is the real code.
 */

const own = mkdtempSync(join(tmpdir(), 'alexia-voice-compute-'))
afterAll(() => rmSync(own, { recursive: true, force: true }))

/** This computer's own answers, as `chosen()` gives them. */
const chosen = (over = {}) => ({ size: 'base', threads: 4, family: 'piper', voice: 'lessac', hearing: undefined, speaking: undefined, qwen: undefined, ...over })

/** The three engines, answering the way the real ones do and running nothing. */
function engines({ hears = false, speaks = false } = {}) {
  const calls = []
  return {
    calls,
    whisper: {
      MODELS: whisper.MODELS,
      PROGRAM_MB: whisper.PROGRAM_MB,
      build: () => ({}),
      ready: async () => hears,
      lacking: async (_own, size) => ({ program: true, model: true, mb: whisper.PROGRAM_MB + whisper.MODELS[size].mb }),
      programs: async (dir, size) => ({ cli: 'whisper-cli', model: join(dir, 'models', size) }),
      install: async (dir, size) => void calls.push(['whisper.install', size]),
      transcribe: async (asked) => {
        calls.push(['whisper.transcribe', asked.file, asked.model, asked.threads])
        return '[00:00:00.000 --> 00:00:02.000]   Hello there.'
      },
      spoken: whisper.spoken,
    },
    piper: {
      VOICES: piper.VOICES,
      PROGRAM_MB: piper.PROGRAM_MB,
      build: () => ({}),
      ready: async () => speaks,
      lacking: async (_own, voice) => ({ program: true, voice: piper.VOICES[voice] !== undefined, mb: piper.PROGRAM_MB + (piper.VOICES[voice]?.mb ?? 0) }),
      programs: async (dir, voice) => (speaks ? { exe: 'piper', ...piper.where(dir, voice) } : undefined),
      install: async (dir, voice) => void calls.push(['piper.install', voice]),
      say: async (asked) => {
        calls.push(['piper.say', asked.model, asked.config, asked.text])
        return asked.wav
      },
    },
    qwen: {
      where: (dir) => ({ out: join(dir, 'qwen', 'spoken.wav') }),
      speak: async (asked) => {
        calls.push(['qwen.speak', asked.python, asked.clip, asked.transcript, asked.text])
        return asked.out
      },
    },
  }
}

const memory = () => {
  const kept = new Map()
  return { kept, get: async (key) => kept.get(key), set: async (key, value) => void kept.set(key, value) }
}

function worker({ settings = chosen(), ...state } = {}) {
  const fake = engines(state)
  const fetched = []
  const wanted = wanting(memory())
  const held = holding()
  const run = operations({
    own: () => own,
    settings: async () => settings,
    fetching: async (_report, half, want) => void fetched.push([half, want]),
    wanted,
    hold: held.hold,
    ...fake,
  })
  return { run, fetched, wanted, held, calls: fake.calls }
}

test('the manifest declares the inference as compute operations, and the rest as nothing of the kind', () => {
  const manifest = readManifest(join(import.meta.dirname, '..'))
  expect(manifest.alexia_protocol).toBe(13)
  expect(Object.fromEntries(manifest.compute.operations.map((one) => [one.cap, one.weight]))).toEqual({
    [RECOGNIZE]: 'light',
    [SYNTHESIZE]: 'light',
    [IMITATE]: 'heavy',
  })
  // Every operation is something this plugin provides, and what a person asks for is still there.
  expect(manifest.provides).toEqual(expect.arrayContaining(['voice.transcribe', 'voice.speak', 'voice.render', RECOGNIZE, SYNTHESIZE, IMITATE]))
  // The microphone, the speakers and the cloud voice are not operations: they stay with the person.
  for (const stays of ['voice.transcribe', 'voice.speak', 'voice.render']) {
    expect(manifest.compute.operations.map((one) => one.cap)).not.toContain(stays)
  }
  expect([...manifest.compute.hooks].sort()).toEqual(['install', 'release', 'setup'])
})

/** The SDK as far as `split` uses it. */
function sdk(run) {
  const registered = new Map()
  const reported = []
  return {
    registered,
    reported,
    computeOperation: (cap, handler) => void registered.set(cap, handler),
    progress: (ctx, done, total, message) => reported.push({ done, total, message }),
    compute: { run: (cap, args, options) => run({ cap, args, options, registered }) },
  }
}

test('with nothing paired the operation runs here, under the bar the person is watching', async () => {
  // What core does when this computer is the one chosen: it calls the plugin's own operation.
  const alexia = sdk(async ({ cap, args, registered }) => registered.get(cap)(args, { mcpReq: {} }))
  const compute = split(alexia)
  const seen = []
  compute.operation(RECOGNIZE, async (plan, io) => {
    seen.push({ plan, here: io.here })
    io.report(10, 148, 'Downloading the base model')
    return { text: 'Hello there.' }
  })
  const said = []
  const made = await compute.run(RECOGNIZE, { file: '/notes/memo.wav', size: 'base' }, { report: (...frame) => said.push(frame) })
  expect(made).toEqual({ text: 'Hello there.', files: [] })
  expect(seen).toEqual([{ plan: { file: '/notes/memo.wav', size: 'base' }, here: true }])
  expect(said).toEqual([[10, 148, 'Downloading the base model']])
  expect(alexia.reported).toEqual([])
})

test('with a computer chosen the recording is sent with the request and nothing is inferred here', async () => {
  let sent
  const alexia = sdk(async ({ args, options }) => {
    sent = { args, inputs: options.inputs }
    return { text: 'Hello there.', files: [] }
  })
  const compute = split(alexia)
  let performed = 0
  compute.operation(RECOGNIZE, async () => {
    performed += 1
    return { text: '' }
  })
  const inputs = [{ name: 'memo.wav', path: '/notes/memo.wav', mime: 'audio/wav' }]
  const made = await compute.run(RECOGNIZE, { file: '/notes/memo.wav', size: 'small' }, { inputs })
  expect(performed).toBe(0)
  expect(made.text).toBe('Hello there.')
  // The file is named in the plan by the path it is sent under, which is how core swaps it
  // for the copy on the other computer.
  expect(sent.args).toMatchObject({ file: '/notes/memo.wav', size: 'small' })
  expect(sent.inputs).toEqual(inputs)
})

test('a computer that cannot do the job is an error, and never quietly this computer instead', async () => {
  const alexia = sdk(async () => {
    throw Object.assign(new Error('MCP error -32050: That computer is not ready to run this capability.'), { code: -32050 })
  })
  const compute = split(alexia)
  let performed = 0
  compute.operation(SYNTHESIZE, async () => {
    performed += 1
    return { files: [] }
  })
  await expect(compute.run(SYNTHESIZE, { voice: 'lessac', text: 'Done.' })).rejects.toThrow(/^That computer is not ready/)
  expect(performed).toBe(0)

  // The one refusal that means there is no other computer to have chosen: then it is here.
  const none = sdk(async () => {
    throw Object.assign(new Error('MCP error -32050: compute is not available for voice.synthesize'), { code: -32050 })
  })
  const alone = split(none)
  alone.operation(SYNTHESIZE, async (_plan, io) => ({ files: [`here:${io.here}`] }))
  expect(await alone.run(SYNTHESIZE, { voice: 'lessac', text: 'Done.' })).toEqual({ files: ['here:true'] })
})

test('recognising speech is Whisper over the file it was handed, and words are all that come back', async () => {
  const { run, calls } = worker({ hears: true, settings: chosen({ threads: 6 }) })
  // The size is the person's choice and travels; the threads are this machine's own.
  const made = await run[RECOGNIZE]({ file: '/staged/memo.wav', size: 'small' }, { here: false })
  expect(made).toEqual({ text: 'Hello there.' })
  expect(calls).toEqual([['whisper.transcribe', '/staged/memo.wav', join(own, 'models', 'small'), 6]])
  await expect(run[RECOGNIZE]({ size: 'small' }, { here: false })).rejects.toThrow(/no recording/)
})

test('a job from another computer never downloads: it says what is missing and remembers it', async () => {
  const { run, fetched, wanted, calls } = worker()
  await expect(run[RECOGNIZE]({ file: '/staged/memo.wav', size: 'small' }, { here: false })).rejects.toThrow(/small speech model is not installed/)
  await expect(run[SYNTHESIZE]({ voice: 'ryan', text: 'Done.', fetch: true }, { here: false })).rejects.toThrow(/ryan voice is not installed/)
  expect(fetched).toEqual([])
  expect(calls).toEqual([])
  // So the setup list on that computer can offer exactly what was wanted.
  expect(await wanted.read()).toEqual({ sizes: ['small'], voices: ['ryan'] })
})

test('on the computer the person is at, a missing voice still arrives the first time it speaks', async () => {
  const { run, fetched } = worker()
  // Not ready before and — in this stand-in — not ready after, so the sentence is the one
  // this plugin has always said. What matters is that the download was asked for, once.
  await expect(run[SYNTHESIZE]({ voice: 'amy', text: 'Done.', fetch: true }, { here: true })).rejects.toThrow(/amy is not downloaded yet/)
  expect(fetched).toEqual([['speaking', { voice: 'amy' }]])

  // *Hear it* on a card is not a download.
  const preview = worker()
  await expect(preview.run[SYNTHESIZE]({ voice: 'amy', text: 'Done.' }, { here: true })).rejects.toThrow(/amy is not downloaded yet/)
  expect(preview.fetched).toEqual([])

  // And hearing fetches its model the same way, at the size that was asked for.
  const hearing = worker()
  await hearing.run[RECOGNIZE]({ file: '/notes/memo.wav', size: 'tiny' }, { here: true })
  expect(hearing.fetched).toEqual([['hearing', { size: 'tiny' }]])
})

test('speaking makes a recording: the one scratch file here, a file of its own on a worker', async () => {
  const { run, calls } = worker({ speaks: true })
  const here = await run[SYNTHESIZE]({ voice: 'lessac', text: 'Done.' }, { here: true })
  expect(here.files).toEqual([piper.where(own, 'lessac').wav])

  const one = await run[SYNTHESIZE]({ voice: 'lessac', text: 'Done.' }, { here: false })
  const two = await run[SYNTHESIZE]({ voice: 'lessac', text: 'Done.' }, { here: false })
  // Two jobs at once must not write over each other.
  expect(one.files[0]).not.toBe(two.files[0])
  expect(one.files[0]).not.toBe(piper.where(own, 'lessac').wav)
  expect(one.files[0].startsWith(own)).toBe(true)

  // A voice somebody added travels as its two files, and those are what Piper is given.
  await run[SYNTHESIZE]({ voice: 'my-own', text: 'Hi.', model: '/staged/my-own.onnx', config: '/staged/my-own.onnx.json' }, { here: false })
  expect(calls.at(-1)).toEqual(['piper.say', '/staged/my-own.onnx', '/staged/my-own.onnx.json', 'Hi.'])
})

test('a cloned voice is spoken from the clip that came with the request, by a Python that is already there', async () => {
  const none = worker()
  await expect(none.run[IMITATE]({ voice: 'qwen:me', text: 'Hi.', clip: '/staged/me.wav', transcript: 'It is me.' }, { here: false })).rejects.toThrow(
    /no Python has been pointed at/,
  )
  expect(none.calls).toEqual([])

  const { run, calls } = worker({ settings: chosen({ qwen: '/opt/venv/bin/python' }) })
  const made = await run[IMITATE]({ voice: 'qwen:me', text: 'Hi.', clip: '/staged/me.wav', transcript: 'It is me.' }, { here: false })
  expect(calls).toEqual([['qwen.speak', '/opt/venv/bin/python', '/staged/me.wav', 'It is me.', 'Hi.']])
  expect(made.files).toHaveLength(1)
  expect(made.files[0].startsWith(own)).toBe(true)
})

test('what is missing is listed with its size before anything is installed', async () => {
  const fake = engines()
  const found = await requirements({ own, chosen: chosen(), wanted: { sizes: ['small'], voices: ['ryan'] }, ...fake })
  const sizes = Object.fromEntries(found.map((one) => [one.id, one.bytes]))
  expect(sizes).toEqual({
    // The program and the model together, because that is what pressing it downloads.
    'hearing:base': (whisper.PROGRAM_MB + whisper.MODELS.base.mb) * 1e6,
    'hearing:small': (whisper.PROGRAM_MB + whisper.MODELS.small.mb) * 1e6,
    'speaking:lessac': (piper.PROGRAM_MB + piper.VOICES.lessac.mb) * 1e6,
    'speaking:ryan': (piper.PROGRAM_MB + piper.VOICES.ryan.mb) * 1e6,
    // Not a download: Alexia never installs this one, and says what to do instead.
    qwen: undefined,
  })
  expect(found.find((one) => one.id === 'hearing:base')).toMatchObject({ action: 'install', blocks: [RECOGNIZE] })
  expect(found.find((one) => one.id === 'speaking:ryan')).toMatchObject({ action: 'install', blocks: [SYNTHESIZE] })
  expect(found.find((one) => one.id === 'qwen')).toMatchObject({ action: 'instructions', blocks: [IMITATE] })
  expect(found.find((one) => one.id === 'qwen').instructions).toMatch(/Qwen program/)
  // Asking is not installing.
  expect(fake.calls).toEqual([])

  // Everything here and a Python pointed at: nothing to ask for.
  expect(await requirements({ own, chosen: chosen({ qwen: '/opt/python' }), ...engines({ hears: true, speaks: true }) })).toEqual([])
})

test('the sizes are read off what is actually on disk', async () => {
  // A build somebody pointed at is not Alexia's to download, so only the model is counted.
  expect(await whisper.lacking(own, 'small', '/opt/whisper-cli')).toEqual({ program: false, model: true, mb: whisper.MODELS.small.mb })
  expect(await piper.lacking(own, 'ryan', '/opt/piper')).toEqual({ program: false, voice: true, mb: piper.VOICES.ryan.mb })
  // A voice nobody published has nowhere to be downloaded from, and is never counted as one.
  expect(await piper.lacking(own, 'my-own', '/opt/piper')).toEqual({ program: false, voice: false, mb: 0 })
})

test('only the install hook downloads, and only what its requirement named', async () => {
  const fake = engines()
  const at = { own, chosen: chosen(), report: () => {}, ...fake }
  await installing('hearing:small', at)
  await installing('speaking:ryan', at)
  expect(fake.calls).toEqual([
    ['whisper.install', 'small'],
    ['piper.install', 'ryan'],
  ])
  // Instructions are not something a button carries out, and neither is a name never offered.
  for (const id of ['qwen', 'whisper', 'hearing:enormous', 'speaking:somebody', 'anything']) {
    await expect(installing(id, at), id).rejects.toThrow(/nothing here to install/)
  }
  expect(fake.calls).toHaveLength(2)
})

test('release ends the inference that is still running, which is all there is to let go of', async () => {
  const held = holding()
  let started
  const running = new Promise((resolve) => (started = resolve))
  const fake = engines({ hears: true })
  // Whisper, loaded and working, until something ends it.
  fake.whisper.transcribe = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      started()
    })
  const run = operations({ own: () => own, settings: async () => chosen(), fetching: async () => {}, wanted: wanting(memory()), hold: held.hold, ...fake })

  const job = run[RECOGNIZE]({ file: '/staged/memo.wav', size: 'base' }, { here: false })
  await running
  expect(held.release()).toBe(1)
  await expect(job).rejects.toThrow('stopped')
  // Nothing is held afterwards, so a second release has nothing to end.
  expect(held.release()).toBe(0)

  // A job that finished on its own is not something release still holds.
  const done = operations({ own: () => own, settings: async () => chosen(), fetching: async () => {}, wanted: wanting(memory()), hold: held.hold, ...engines({ hears: true }) })
  await done[RECOGNIZE]({ file: '/staged/memo.wav', size: 'base' }, { here: false })
  expect(held.release()).toBe(0)
})
