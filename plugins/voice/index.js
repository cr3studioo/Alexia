// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import * as expression from './expression.js'
import * as fish from './fish.js'
import * as piper from './piper.js'
import * as whisper from './whisper.js'

/**
 * Voice — the plugin the contract was designed against (M2-3, M2-4).
 *
 * It is here because it exercises every hard mechanism at once: two large downloads with
 * progress, binaries spawned as child processes, permissions a person has to actually agree
 * to, and capabilities that cannot be answered until a file finishes arriving.
 *
 * **The microphone is opened in this process and only text goes back.** That is not a policy
 * written down somewhere — it is a property of where the code runs. Core spawns this plugin
 * and reads JSON from a pipe; there is no audio on that pipe, and no way for core to ask for
 * any. Process isolation was bought for exactly this, and this is the first place it is
 * visible.
 */

const alexia = plugin()

/** Set once at startup, so nothing has to spawn anything to answer a settings screen. */
let own

/**
 * What the user chose, with the manifest's defaults filled in.
 *
 * **Which voice speaks is this plugin's own, not a setting** (M6-6). It used to be a `choice`
 * over three fixed options, which stopped being the truth the moment a person could add one
 * of their own — a dropdown whose options are fixed in a manifest cannot list a file that
 * arrived afterwards. So the panel's list is the picker and the answer lives here, in the
 * plugin's own key-value store, where it can name a voice nobody published.
 */
async function chosen() {
  const settings = await alexia.settings()
  const path = (key) =>
    typeof settings[key] === 'string' && settings[key] !== '' ? settings[key] : undefined
  const picked = await alexia.storage.get('voice').catch(() => undefined)
  return {
    size: whisper.MODELS[settings.model_size] ? settings.model_size : 'base',
    voice: typeof picked === 'string' && picked !== '' ? picked : 'lessac',
    threads: Number(settings.threads) || 4,
    hearing: path('whisper_path'),
    speaking: path('piper_path'),
    // The second engine (M7-4). **There is no engine switch**: a voice is picked in one
    // place, and where it lives is a property of the voice rather than a second setting to
    // keep in step with it. `cloud:` means somebody's own voice; anything else is a Piper
    // stem, exactly as before.
    key: path('fish_key'),
    clip: path('clip'),
    clipText: typeof settings.clip_text === 'string' ? settings.clip_text.trim() : '',
    expressive: settings.expression === true,
    // What the panel's search boxes hold. They are a question rather than a preference,
    // which is why they live beside the list they filter and not on the settings screen.
    find: typeof settings.find === 'string' ? settings.find.trim() : '',
    tags: Array.isArray(settings.find_tags) ? settings.find_tags : [],
    langs: Array.isArray(settings.find_langs) ? settings.find_langs : [],
  }
}

/**
 * The published voices somebody kept (M7-4 had only the ones cloning made).
 *
 * A voice on the catalogue needs nothing on this disk and nothing on the account — the id
 * is the whole of what makes it speakable — so keeping one is a line in this plugin's own
 * store rather than a copy of anything. Which also means **removing one only removes the
 * line**: it stays published, and saying otherwise would be the lie M7-4 already refused to
 * tell about a clone.
 */
async function kept() {
  const saved = await alexia.storage.get('kept').catch(() => undefined)
  return Array.isArray(saved) ? saved.filter((one) => one && typeof one.id === 'string') : []
}

/**
 * What the last search found, by id.
 *
 * A row action carries `{ id }` and nothing else, so Keep would otherwise have no name to
 * write down — and asking the vendor again for a row that is on screen is a second call to
 * learn something this process was told a moment ago.
 */
const lastFound = new Map()

/** The voices on the account, if there is a key. An empty list is the ordinary state. */
async function cloned(key, signal) {
  if (!key) return []
  return fish.mine(key, signal).catch((error) => {
    // A bad key, or the API having a moment. Neither is a reason for the panel to be empty
    // of the local voices too, so it is logged and the list is short.
    log.info(String(error instanceof Error ? error.message : error))
    return []
  })
}

/**
 * The runtime half of `provides` (D59).
 *
 * Both capabilities are declared in the manifest — that is the promise, and it is what the
 * library shows and what another plugin's `requires` resolves against. This is the statement
 * about *right now*: a plugin whose model is still downloading cannot turn speech into text,
 * and a caller is better served by `-32050` than by a tool that fails halfway. So each
 * binding goes on and off with its own files, separately, because hearing and speaking are
 * two downloads and one of them can be finished while the other is not.
 */
async function bind() {
  const { size, voice, hearing, speaking, key, expressive } = await chosen()
  const hears = own ? await whisper.ready(own, size, hearing) : false
  // A cloned voice needs no file on this machine — the key is the whole of what makes it
  // speakable, so `speaks` is true for one the moment there is a key to reach it with.
  const cloud = fish.idOf(voice) !== undefined
  const speaks = cloud ? key !== undefined : own ? await piper.ready(own, voice, speaking) : false
  heard.update({ _meta: hears ? { 'alexia/provides': ['voice.transcribe'] } : {} })
  said.update({ _meta: speaks ? { 'alexia/provides': ['voice.speak'] } : {} })
  // Only the cloud engine returns a format a message can carry, so the binding follows the
  // chosen voice rather than the plugin being enabled.
  rendered.update({ _meta: cloud && key !== undefined ? { 'alexia/provides': ['voice.render'] } : {} })
  await alexia
    .status('ready', state({ hears, speaks, size, voice, hearing, speaking, cloud, key, expressive }))
    .catch(() => {})
  return { hears, speaks }
}

/**
 * One line for two halves.
 *
 * `●` only when both work, because a plugin that can hear and not answer is not ready — it
 * is halfway, and the person looking at this screen is the one who has to decide whether to
 * wait. Only `▲` is coloured (D67): being ready is not something happening.
 */
function state({ hears, speaks, size, voice, hearing, speaking, cloud, key, expressive }) {
  /**
   * **Expression is off and says so** when a local voice is speaking (M7-4).
   *
   * Piper has no expression control of any kind, and the predecessor proved the
   * sampling-parameter workaround inert on this hardware. A switch that appears to work and
   * does nothing is worse than one that is greyed out, so the state line carries the answer
   * rather than leaving somebody to wonder why nothing changed.
   */
  const mood =
    !expressive ? ''
    : cloud ? ', with expression'
    : ' — expression is off, Piper has none'
  if (cloud && !key) return '▲ A cloned voice is picked and there is no fish.audio key'
  if (hears && speaks) return `● Ready — ${size}, ${voice}${mood}`
  if (!whisper.build() && !hearing) return '▲ Point at a Whisper program'
  if (!piper.build() && !speaking) return '▲ Point at a Piper program'
  // A voice somebody added has no published size, and inventing one would be a number on
  // a screen that means nothing.
  const mb = cloud ? undefined : piper.VOICES[voice]?.mb
  if (hears) return mb === undefined ? `▲ Hearing only — ${voice} is not loading` : `▲ Hearing only — the ${voice} voice is ${mb} MB`
  if (speaks) return `▲ Speaking only — the ${size} model is ${whisper.MODELS[size].mb} MB`
  return mb === undefined ?
      `■ Not downloaded — the ${size} model is ${whisper.MODELS[size].mb} MB`
    : `■ Not downloaded — ${whisper.MODELS[size].mb + mb + 30} MB`
}

/**
 * Fetch whatever is missing, reporting it, then re-answer the question of what we can do.
 *
 * `half` is which of the two is actually needed: transcribing does not download a voice, and
 * saying one sentence out loud does not download a speech model. Only the button fetches
 * both, because that is the one place somebody asked for all of it.
 */
async function fetching(ctx, half) {
  const { size, voice, hearing, speaking } = await chosen()
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  const report = (done, total, message) => alexia.progress(ctx, done, total, message)
  await alexia.status('ready', '▲ Downloading').catch(() => {})
  try {
    if (half !== 'speaking') {
      if (!whisper.build() && !hearing) throw new Error(missing('Whisper', 'Whisper program'))
      await whisper.install(own, size, hearing, report)
    }
    if (half !== 'hearing') {
      if (!piper.build() && !speaking) throw new Error(missing('Piper', 'Piper program'))
      await piper.install(own, voice, speaking, report)
    }
  } finally {
    await bind()
  }
}

const missing = (what, setting) =>
  `There is no prebuilt ${what} for ${process.platform}/${process.arch}. Install one and set “${setting}” to it.`

const heard = alexia.tool(
  'transcribe',
  {
    description:
      'Turn a recording into text, using Whisper on this machine. Takes the path of an audio file — wav, mp3, flac or ogg — and returns what was said. Use when the user refers to a recording, a voice note or an audio file.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { file: { type: 'string', description: 'The path of the audio file to read.' } },
      required: ['file'],
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ file }, ctx) => {
    const { size, threads, hearing } = await chosen()
    if (!(await whisper.ready(own, size, hearing))) await fetching(ctx, 'hearing')
    const found = await whisper.programs(own, size, hearing)
    const text = whisper.spoken(await whisper.transcribe({ ...found, file, threads, signal: ctx.mcpReq.signal }))
    await keep(text, 'file')
    return { content: [{ type: 'text', text: text || 'There was nothing to hear in that file.' }] }
  },
)

/**
 * The microphone, and the reason this plugin exists.
 *
 * **No `readOnlyHint`, and that is the decision rather than an omission.** Reading a file
 * somebody named is one thing; opening the microphone is a thing a person wants to be asked
 * about, and an undeclared tool is one the permission gate stops to ask about in every mode
 * but Full trust. Declaring this read-only would be true about the disk and wrong about the
 * room.
 */
alexia.tool(
  'listen',
  {
    description:
      'Listen on the microphone and return what was said, as text. Waits for the person to speak and stops when they stop. Use when the user asks to talk, to dictate, or to be listened to.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'How long to wait for someone to start speaking, at most. Defaults to 15.',
        },
      },
    }),
    annotations: { openWorldHint: false },
  },
  async ({ seconds = 15 }, ctx) => {
    const { size, threads, hearing } = await chosen()
    if (!(await whisper.ready(own, size, hearing))) await fetching(ctx, 'hearing')
    const found = await whisper.programs(own, size, hearing)
    if (!found?.stream) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This Whisper build has no whisper-stream beside it, so the microphone cannot be opened. Clear “Whisper program” to let Alexia download one that has.',
          },
        ],
      }
    }
    await alexia.status('ready', '▲ Listening').catch(() => {})
    try {
      const text = await whisper.listen({ ...found, seconds, threads, signal: ctx.mcpReq.signal })
      await keep(text, 'microphone')
      return { content: [{ type: 'text', text: text || 'I did not hear anything.' }] }
    } finally {
      await bind()
    }
  },
)

/**
 * Out loud (M2-4).
 *
 * `voice.speak` is *text in, audio played, nothing out* — so this returns a confirmation and
 * not a file. The sound is made here and played here; nothing about it goes back over the
 * wire, which is the same property as `listen` running the other way.
 *
 * No `readOnlyHint` either. Making a noise in somebody's room is not read-only in any sense
 * a person cares about, and the answer to *may this play sound* belongs to them.
 */
const said = alexia.tool(
  'speak',
  {
    description:
      'Say something out loud through the speakers, using Piper on this machine. Use when the user asks to be told something aloud, to have an answer read out, or to hear it rather than read it.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say.' } },
      required: ['text'],
    }),
    annotations: { openWorldHint: false },
  },
  async ({ text }, ctx) => {
    const words = String(text ?? '').trim()
    if (!words) return { isError: true, content: [{ type: 'text', text: 'There was nothing to say.' }] }
    const picked = await chosen()
    const { voice, speaking } = picked
    const id = fish.idOf(voice)

    if (id !== undefined) {
      if (!picked.key) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${voice} is a cloned voice and there is no fish.audio key to reach it with.` }],
        }
      }
      await alexia.status('ready', '▲ Speaking').catch(() => {})
      try {
        const marked = picked.expressive ? await annotate(words, ctx) : words
        const audio = await fish.say(picked.key, { text: marked, id, signal: ctx.mcpReq.signal })
        // Written where Piper writes its own, so one file is overwritten rather than
        // accumulated and the purge that takes the folder takes this too.
        const { wav } = piper.where(own, 'lessac')
        await writeFile(wav, audio)
        await piper.play(wav, ctx.mcpReq.signal)
        return { content: [{ type: 'text', text: 'Said it, in your own voice.' }] }
      } finally {
        await bind()
      }
    }

    if (!(await piper.ready(own, voice, speaking))) await fetching(ctx, 'speaking')
    const found = await piper.programs(own, voice, speaking)
    await alexia.status('ready', '▲ Speaking').catch(() => {})
    try {
      // Markers are not stripped from Piper's input for a reason: nothing puts them there.
      // `annotate` is only ever reached on the path that can read them.
      const wav = await piper.say({ ...found, text: words, signal: ctx.mcpReq.signal })
      await piper.play(wav, ctx.mcpReq.signal)
      return { content: [{ type: 'text', text: `Said it, in ${voice}’s voice.` }] }
    } finally {
      await bind()
    }
  },
)

/**
 * The reply, marked up for delivery (M7-4).
 *
 * One small model call through `sampling`, which means it goes on the same rungs, under the
 * same cap, and — since a plugin working on its own clock spends nothing but free (G12,
 * D96) — on a free model or not at all. **Anything that goes wrong falls back to the plain
 * words**, because losing the answer to decorate it would be the worst trade in the plugin.
 */
async function annotate(words, ctx) {
  try {
    const answer = await alexia.server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: expression.prompt(words) } }],
      systemPrompt: 'You insert speech-delivery markers and change nothing else.',
      maxTokens: 400,
      ...(ctx?.mcpReq?.signal && { signal: ctx.mcpReq.signal }),
    })
    const said = answer.content?.type === 'text' ? answer.content.text : ''
    // Filtered, not trusted. An unrecognised tag is *spoken* rather than dropped, so a model
    // inventing one would ship a literal bracket into somebody's ears.
    return expression.sanitize(said.trim(), words)
  } catch (error) {
    log.info(`speaking plainly: ${error instanceof Error ? error.message : String(error)}`)
    return words
  }
}

/**
 * The same words, as bytes rather than out of the speakers (M7-5).
 *
 * `voice.speak` is deliberately *text in, audio played, nothing out* — the sound is made
 * here and stays here, which is a property worth keeping. This is the other thing somebody
 * needs: a voice note to put in a message, which cannot be played on this machine's
 * speakers and be in a chat at the same time.
 *
 * **It is bound only when the format is one a caller can use.** A cloned voice returns
 * Ogg/Opus, which is exactly what a Telegram voice bubble wants. Piper returns WAV, and
 * converting one to the other is ffmpeg — a dependency this plugin has gone to some trouble
 * not to have — so with a Piper voice speaking this capability is simply not offered, and
 * the caller sends words.
 */
const rendered = alexia.tool(
  'render',
  {
    description:
      'Turn text into audio and return the bytes, rather than playing it. Use when the audio ' +
      'has to go somewhere other than these speakers — a voice note in a message, say.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say.' } },
      required: ['text'],
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ text }, ctx) => {
    const words = String(text ?? '').trim()
    if (!words) return { isError: true, content: [{ type: 'text', text: 'There was nothing to say.' }] }
    const picked = await chosen()
    const id = fish.idOf(picked.voice)
    if (id === undefined || !picked.key) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Only a cloned voice returns audio a message can carry. Piper makes WAV, and converting it would mean ffmpeg.' }],
      }
    }
    const marked = picked.expressive ? await annotate(words, ctx) : words
    const audio = await fish.say(picked.key, { text: marked, id, format: 'opus', signal: ctx?.mcpReq?.signal })
    return { content: [{ type: 'audio', data: audio.toString('base64'), mimeType: 'audio/ogg' }] }
  },
)

alexia.tool(
  'install',
  {
    description:
      'Download Whisper, Piper, the speech model and the voice, so that listening, transcribing and speaking all work. Reports progress. Use only when the user explicitly asks to install or update the speech models. Takes no arguments.',
    annotations: { openWorldHint: true },
  },
  async (ctx) => {
    const { size, voice } = await chosen()
    await fetching(ctx, 'both')
    return { content: [{ type: 'text', text: `The ${size} speech model and the ${voice} voice are ready.` }] }
  },
)

/**
 * The panel (M6-6): every voice this machine has, which one speaks, and a way to add one.
 *
 * The old dashboard's owner asked for exactly this — *can you make it so that I can switch
 * the voice?* — and what he wanted with it was a fifteen-second clip of his own voice. That
 * is not what this is, and saying so is the honest part: Piper does not clone from a clip,
 * and the vendor that does was refused at M2-4 for the dependency it costs. What a person
 * can genuinely do is bring a Piper voice they downloaded, and that is what this adds.
 */
/**
 * The cloned voices, in the shape the local ones already come in (M7-4).
 *
 * **One list, because a voice is picked in one place.** G10 asked whether cloning should be
 * a second plugin, and the answer is here: two plugins would both provide `voice.speak`, and
 * `Plugins.capability()` returns whichever one core happened to load first — with nothing on
 * any screen to say which is speaking, and no way for a person to choose. That ambiguity is
 * a worse outcome than a summary that has to mention a key.
 *
 * `here` is true because there is nothing to download; a cloned voice exists on an account
 * rather than on this disk, which is also why removing one is a call and not a file delete.
 */
async function cloudVoices(key) {
  const account = (await cloned(key)).map((one) => ({
    id: `${fish.PREFIX}${one.id}`,
    name: one.name,
    cloud: true,
    owned: true,
    here: true,
  }))
  const already = new Set(account.map((one) => one.id))
  // A voice somebody kept that turns out to be their own is one voice, listed once, and the
  // account's own answer is the truer of the two.
  const saved = (await kept())
    .filter((one) => !already.has(one.id))
    .map((one) => ({ id: one.id, name: one.name ?? one.id, cloud: true, here: true }))
  return [...account, ...saved]
}

alexia.tool(
  'voices',
  {
    description: 'List every speaking voice this machine has, which one is in use, and which are downloaded. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const { voice, key } = await chosen()
    const rows = [...(await piper.catalogue(own)), ...(await cloudVoices(key))].map((one) => ({
      id: one.id,
      name: one.name ?? one.id,
      where:
        one.cloud ? (one.owned ? 'cloned, on fish.audio' : 'kept from fish.audio')
        : one.mine ? 'yours'
        : 'published',
      // Two facts, and the row says both: whether it is the one that speaks, and whether it
      // is actually here. The chosen voice not being downloaded yet is an ordinary state —
      // it arrives on the first thing said in it — and a row claiming only the first would
      // be the row somebody stares at wondering why nothing happens.
      state:
        one.id === voice && one.here ? '● speaking'
        : one.id === voice ? `▲ speaking — arrives on first use${one.mb ? `, ${one.mb} MB` : ''}`
        : one.here ? '● ready'
        : `■ not downloaded${one.mb ? ` — ${one.mb} MB` : ''}`,
    }))
    return { content: [{ type: 'text', text: `${rows.length} voices` }], structuredContent: { rows } }
  },
)

/**
 * The catalogue everybody else publishes (the predecessor's own Voice tab, arriving here).
 *
 * **The rows are the search**, which is why this one tool is both the table's `rows` and the
 * button's `tool`: the query, the tags and the languages are widgets beside the list, and a
 * press is the only thing that means *ask again*. A second tool that searched and a first
 * that listed would be two things that could disagree about what is on screen.
 *
 * Five, because that is a screenful somebody reads rather than scrolls, and the catalogue is
 * ranked — the sixth result is rarely the one.
 */
alexia.tool(
  'search_voices',
  {
    description:
      'Search the voices published on fish.audio, using the words and filters on the Voice panel. Returns the top few. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async (ctx) => {
    const { key, find, tags, langs } = await chosen()
    if (!key) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Add a fish.audio key on the plugins screen to browse the voices published there.' }],
      }
    }
    const held = new Set((await kept()).map((one) => one.id))
    const results = await fish.search(key, {
      text: find,
      tags,
      languages: langs,
      count: 5,
      signal: ctx?.mcpReq?.signal,
    })
    lastFound.clear()
    const rows = results.map((one) => {
      const id = `${fish.PREFIX}${one.id}`
      lastFound.set(id, one.name)
      return {
        id,
        name: one.name,
        tags: one.tags.slice(0, 4).join(' · '),
        likes: String(one.likes),
        state: held.has(id) ? '● kept' : '■ not kept',
      }
    })
    return {
      content: [{ type: 'text', text: rows.length === 0 ? 'Nothing matched that.' : `${rows.length} voices found.` }],
      structuredContent: { rows },
    }
  },
)

alexia.tool(
  'keep_voice',
  {
    description:
      'Keep one of the voices found on fish.audio, so it joins the list and can be chosen. Takes the voice’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which voice.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    if (fish.idOf(id) === undefined) {
      return { isError: true, content: [{ type: 'text', text: `${id} is not a fish.audio voice.` }] }
    }
    const held = await kept()
    if (held.some((one) => one.id === id)) return { content: [{ type: 'text', text: 'That one is already in the list.' }] }
    const name = lastFound.get(id)
    if (name === undefined) {
      // Rather than writing the id down as a name. A row whose name is a hex string is a row
      // nobody can pick out of a list, and the fix is one press of Search.
      return { isError: true, content: [{ type: 'text', text: 'Search again, then keep the voice from the row it appears on.' }] }
    }
    await alexia.storage.set('kept', [...held, { id, name }])
    await bind()
    return { content: [{ type: 'text', text: `${name} is in the list. Choose it to speak in it.` }] }
  },
)

/**
 * What it sounds like, before it is the voice that answers.
 *
 * **Spoken rather than played back.** The vendor publishes a sample clip per voice, and the
 * predecessor put an `<audio>` element on it — but a plugin here does not draw its own
 * controls, and the clip's format is whatever its author uploaded, which the operating
 * system's own player may or may not open. One short sentence through the engine that would
 * actually be speaking costs a free call and answers the real question: *what will this
 * sound like when it is answering me.*
 */
alexia.tool(
  'hear_voice',
  {
    description: 'Say one short sentence in a voice without making it the one that speaks. Takes the voice’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which voice.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ id }, ctx) => {
    const words = 'This is what I sound like.'
    const { key, speaking } = await chosen()
    const clone = fish.idOf(id)
    await alexia.status('ready', '▲ Speaking').catch(() => {})
    try {
      if (clone !== undefined) {
        if (!key) return { isError: true, content: [{ type: 'text', text: 'That voice lives on fish.audio and there is no key to reach it with.' }] }
        const { wav } = piper.where(own, 'lessac')
        await writeFile(wav, await fish.say(key, { text: words, id: clone, signal: ctx?.mcpReq?.signal }))
        await piper.play(wav, ctx?.mcpReq?.signal)
        return { content: [{ type: 'text', text: `That is ${id}.` }] }
      }
      // Deliberately not a download. A button that says *hear it* should not spend 60 MB and
      // a minute to answer; the voice arrives the first time it is actually asked to speak.
      if (!(await piper.ready(own, id, speaking))) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${id} is not downloaded yet. Choose it and it arrives the first time it speaks.` }],
        }
      }
      const there = await piper.programs(own, id, speaking)
      await piper.play(await piper.say({ ...there, text: words, signal: ctx?.mcpReq?.signal }), ctx?.mcpReq?.signal)
      return { content: [{ type: 'text', text: `That is ${id}.` }] }
    } finally {
      await bind()
    }
  },
)

alexia.tool(
  'use_voice',
  {
    description: 'Make one of the installed voices the one that speaks. Takes the voice’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which voice.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const { key } = await chosen()
    const known = [...(await piper.catalogue(own)), ...(await cloudVoices(key))].find((one) => one.id === id)
    if (!known) return { isError: true, content: [{ type: 'text', text: `There is no voice called ${id}.` }] }
    await alexia.storage.set('voice', id)
    await bind()
    // Downloading is not done here: a published voice that is not on disk yet arrives on the
    // first thing said in it, the same as it always did.
    return {
      content: [
        { type: 'text', text: known.here ? `${id} is speaking now.` : `${id} is speaking now, and downloads the first time it is used.` },
      ],
    }
  },
)

alexia.tool(
  'drop_voice',
  {
    description: 'Delete a voice you added. Takes the voice’s id. A published voice cannot be deleted this way.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which voice.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const { key } = await chosen()
    const clone = fish.idOf(id)
    // A kept voice first, because it is the one case where removing is *forgetting*: it
    // belongs to whoever published it, this machine holds only a line saying it is in the
    // list, and calling the vendor's delete for it would be asking to delete somebody
    // else's voice.
    const held = await kept()
    if (held.some((one) => one.id === id)) {
      await alexia.storage.set('kept', held.filter((one) => one.id !== id))
      if ((await chosen()).voice === id) await alexia.storage.set('voice', 'lessac')
      await bind()
      return { content: [{ type: 'text', text: `${id} is out of the list. It is still published on fish.audio.` }] }
    }
    if (clone !== undefined) {
      if (!key) return { isError: true, content: [{ type: 'text', text: 'There is no fish.audio key, so there is nothing to remove it with.' }] }
      // Gone from the account, not from a folder. The selection falls back rather than
      // dangling: a chosen voice that no longer exists is silence with no explanation.
      await fish.remove(key, clone)
      if ((await chosen()).voice === id) await alexia.storage.set('voice', 'lessac')
      await bind()
      return { content: [{ type: 'text', text: `${id} is gone from fish.audio. Lessac is speaking.` }] }
    }
    const known = (await piper.catalogue(own)).find((one) => one.id === id)
    if (!known?.mine) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${id} is one of the published voices. Alexia downloads those, so removing one only means it is fetched again.`,
          },
        ],
      }
    }
    const { model, config } = piper.where(own, id)
    await rm(model, { force: true })
    await rm(config, { force: true })
    if ((await chosen()).voice === id) await alexia.storage.set('voice', 'lessac')
    await bind()
    return { content: [{ type: 'text', text: `${id} is gone. Lessac is speaking.` }] }
  },
)

alexia.tool(
  'add_voice',
  {
    description:
      'Copy a Piper voice you have downloaded into Alexia, so it can speak in it. Reads the path in the “Add a voice” box. Takes no arguments.',
    annotations: { openWorldHint: false },
  },
  async () => {
    const settings = await alexia.settings()
    const from = typeof settings.add_voice === 'string' ? settings.add_voice.trim() : ''
    if (from === '') return { isError: true, content: [{ type: 'text', text: 'Point “Add a voice” at a Piper .onnx file first.' }] }
    if (!from.endsWith('.onnx')) {
      return { isError: true, content: [{ type: 'text', text: 'A Piper voice is a .onnx file, with its .onnx.json beside it.' }] }
    }
    const stem = basename(from, '.onnx')
    const there = piper.where(own, stem)
    try {
      // Both halves or neither: Piper will not load a voice without its config, and the
      // config is where the sample rate lives — so half a voice is silence, not an error.
      await copyFile(from, there.model)
      await copyFile(join(dirname(from), `${stem}.onnx.json`), there.config)
    } catch (error) {
      await rm(there.model, { force: true })
      return {
        isError: true,
        content: [{ type: 'text', text: `Could not copy it: ${error.message}. A Piper voice is two files — ${stem}.onnx and ${stem}.onnx.json.` }],
      }
    }
    await bind()
    return { content: [{ type: 'text', text: `${stem} is here. Choose it in the list to speak in it.` }] }
  },
)

/**
 * Fifteen seconds and a transcript in, a voice out (M7-4).
 *
 * **The `file` widget was asked for again here and lost again** (G7, D89). D89 refused it
 * because its only user could not do the thing it was wanted for; this is that user, and the
 * answer is still `path` — because the alternative D89 named, *record the clip through
 * `audio.input`*, turns out not to be free either. This plugin has no raw recorder: Whisper's
 * `whisper-stream` listens and returns **text**, and putting a wav recorder in would mean a
 * platform-specific capture path per operating system for one screen. Somebody cloning a
 * voice already has the recording, so `path` is an equal first minute — the same shape
 * `add_voice` above already uses, and one less mechanism.
 *
 * It is deliberately **not** something the model can decide to do: the clip and its words
 * leave this machine, and that is a decision belonging to whoever pressed the button.
 */
alexia.tool(
  'clone_voice',
  {
    description:
      'Make a voice that sounds like a recording, using the file in the “A recording to clone” ' +
      'box and the words in “What the recording says”. Needs a fish.audio key. Takes no arguments.',
    // It reaches an API and it puts something on somebody's account, so it says both.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (ctx) => {
    const { key, clip, clipText } = await chosen()
    const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
    if (!key) return refuse('Add a fish.audio key on the plugins screen first. Piper cannot clone a voice from a recording.')
    if (!clip) return refuse('Point “A recording to clone” at a .wav of the voice you want.')
    if (clipText === '') return refuse('Put the words that were said in the clip into “What the recording says”.')

    const name = basename(clip).replace(/\.[^.]+$/, '') || 'my voice'
    await alexia.status('ready', '▲ Cloning').catch(() => {})
    try {
      const made = await fish.clone(key, { name, wav: clip, transcript: clipText, signal: ctx?.mcpReq?.signal })
      // Picked straight away. Somebody who has just cloned their own voice wanted to hear
      // it, and making them find it in a list first is a step with no decision in it.
      await alexia.storage.set('voice', `${fish.PREFIX}${made.id}`)
      // Said out loud because it is the one thing about this that a delete cannot undo: the
      // voice is on somebody's account, not on this disk, so removing the plugin does not
      // remove it. **Remove** on the panel is what does.
      return {
        content: [
          {
            type: 'text',
            text: `${made.name} is cloned and speaking now. It lives on your fish.audio account — deleting this plugin will not remove it, but Remove on the Voice panel will.`,
          },
        ],
      }
    } catch (error) {
      return refuse(`That did not work: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await bind()
    }
  },
)

/**
 * What was said, kept in this plugin's own namespace — which is also the point: it is one
 * `DROP TABLE` away, and deleting the folder takes it with it (invariant 5).
 */
const keep = (text, source) =>
  text ? alexia.storage.insert('transcripts', { text, source, at: Date.now() }).catch(() => {}) : undefined

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
// The model and the voice are the things that decide whether either capability is answerable
// at all, so a change to any of them re-asks rather than assuming the last answer still holds.
alexia.onSettingsChanged((changed) => {
  if (['model_size', 'whisper_path', 'piper_path'].some((key) => key in changed)) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
