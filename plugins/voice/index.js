// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import * as expression from './expression.js'
import * as fish from './fish.js'
import * as piper from './piper.js'
import * as qwen from './qwen.js'
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
 * The four engines, and the three families behind them.
 *
 * **There is an engine switch now, and the comment that used to say there was not was right
 * for as long as there were two.** *A voice is picked in one place and where it lives is a
 * property of the voice* works while the only question is Piper-or-cloud; it stops working
 * the moment two engines can hold the same voice, and it never covered `expression`, which
 * had to be a toggle that did nothing on one of them and a clause in the status line
 * apologising for it. Expression is not a switch here: it is the fourth engine, because that
 * is what it actually is — the same vendor, one extra model call, said out loud on the card.
 *
 * `family` is what speaks; `engine` is what the person picked. Two names because
 * `fish_plain` and `fish_expressive` are one engine asked to behave differently, and every
 * question about *which files are on disk* wants the family rather than the choice.
 */
const ENGINES = {
  piper: { family: 'piper', label: 'Piper', expressive: false },
  qwen: { family: 'qwen', label: 'Qwen3-TTS', expressive: false },
  fish_plain: { family: 'fish', label: 'fish.audio', expressive: false },
  fish_expressive: { family: 'fish', label: 'fish.audio', expressive: true },
}

/**
 * Which family a voice id belongs to, read off the id itself.
 *
 * The prefixes are the whole of it: `cloud:` is somebody's fish.audio voice, `qwen:` is one
 * this machine cloned, and anything else is a Piper stem — which is what makes a voice
 * somebody dropped into the folder work exactly like one Alexia downloaded.
 */
const familyOf = (voice) =>
  fish.idOf(voice) !== undefined ? 'fish'
  : qwen.idOf(voice) !== undefined ? 'qwen'
  : 'piper'

/** What speaks when nobody has chosen. Only Piper has one: the other two are somebody's own. */
const FIRST = { piper: 'lessac' }

/**
 * What the user chose, with the manifest's defaults filled in.
 *
 * **Which voice speaks is this plugin's own, not a setting** (M6-6). It used to be a `choice`
 * over three fixed options, which stopped being the truth the moment a person could add one
 * of their own — a dropdown whose options are fixed in a manifest cannot list a file that
 * arrived afterwards. So the panel's list is the picker and the answer lives here, in the
 * plugin's own key-value store, where it can name a voice nobody published.
 *
 * **One picked voice per family, not one for the page.** With an engine switch above the list
 * a single answer would be wrong half the time: choosing a cloned voice, switching to Piper
 * for a fast reply and switching back would have lost it. So each family remembers its own,
 * and the engine at the top says which of them is speaking.
 */
async function chosen() {
  const settings = await alexia.settings()
  const path = (key) =>
    typeof settings[key] === 'string' && settings[key] !== '' ? settings[key] : undefined
  const engine = ENGINES[settings.engine] ? settings.engine : 'piper'
  const { family, expressive } = ENGINES[engine]
  const picked = await alexia.storage.get(`voice_${family}`).catch(() => undefined)
  // Before there were engines there was one answer for all of them, under `voice`. It is read
  // as this family's when it belongs to this family, so an upgrade keeps the voice somebody
  // was using rather than silently going back to lessac.
  const before = await alexia.storage.get('voice').catch(() => undefined)
  const inherited = typeof before === 'string' && familyOf(before) === family ? before : undefined
  return {
    size: whisper.MODELS[settings.model_size] ? settings.model_size : 'base',
    engine,
    family,
    expressive,
    voice: typeof picked === 'string' && picked !== '' ? picked : (inherited ?? FIRST[family]),
    threads: Number(settings.threads) || 4,
    hearing: path('whisper_path'),
    speaking: path('piper_path'),
    qwen: path('qwen_path'),
    key: path('fish_key'),
    clip: path('clip'),
    clipText: typeof settings.clip_text === 'string' ? settings.clip_text.trim() : '',
    // One line for the whole page rather than one per voice: the question somebody is asking
    // of a list of voices is what they sound like, not what each of them says.
    preview: (typeof settings.preview_text === 'string' ? settings.preview_text.trim() : '') || SAMPLE,
    // What the panel's search boxes hold. They are a question rather than a preference,
    // which is why they live beside the list they filter and not on the settings screen.
    find: typeof settings.find === 'string' ? settings.find.trim() : '',
    tags: Array.isArray(settings.find_tags) ? settings.find_tags : [],
    langs: Array.isArray(settings.find_langs) ? settings.find_langs : [],
  }
}

/** What a voice says when nobody has typed anything else into the preview box. */
const SAMPLE = 'This is what I sound like.'

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
 * What the last search found, by id: `{ name, preview }`.
 *
 * A row action carries `{ id }` and nothing else, so Keep would otherwise have no name to
 * write down — and asking the vendor again for a row that is on screen is a second call to
 * learn something this process was told a moment ago. The sample URL rides along for the same
 * reason: it is a public link the search already handed over, and a kept voice that lost its
 * sample would be a card with a play button until the page was reloaded and then without one.
 */
const lastFound = new Map()

/**
 * What to call a voice in a sentence somebody reads.
 *
 * A cloud voice's id is a hex string, and *That is cloud:0051da37…* is a sentence nobody can
 * check against the card they just pressed. A Piper stem and a Qwen clone are already their
 * own names, so the id is the right answer for both and the lookup is only for the one kind
 * that needs it.
 *
 * The two lists that cost nothing first — what the last search found, and what somebody kept.
 * The account is asked only when neither has it and a caller has handed over a key to ask
 * with, because that is a network call and most of these sentences do not need one.
 */
async function nameOf(id, key) {
  if (familyOf(id) !== 'fish') return qwen.idOf(id) ?? id
  const cheap = lastFound.get(id)?.name ?? (await kept()).find((one) => one.id === id)?.name
  if (cheap !== undefined || key === undefined) return cheap ?? id
  return (await cloudVoices(key)).find((one) => one.id === id)?.name ?? id
}

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
  const picked = await chosen()
  const { size, family, hearing, key } = picked
  const hears = own ? await whisper.ready(own, size, hearing) : false
  // A cloned voice needs no file on this machine — the key is the whole of what makes it
  // speakable, so `speaks` is true for one the moment there is a key to reach it with.
  const speaks = await canSpeak(picked)
  heard.update({ _meta: hears ? { 'alexia/provides': ['voice.transcribe'] } : {} })
  said.update({ _meta: speaks ? { 'alexia/provides': ['voice.speak'] } : {} })
  // Only the cloud engine returns a format a message can carry, so the binding follows the
  // engine rather than the plugin being enabled.
  rendered.update({ _meta: family === 'fish' && key !== undefined ? { 'alexia/provides': ['voice.render'] } : {} })
  await alexia.status('ready', state({ ...picked, hears, speaks })).catch(() => {})
  return { hears, speaks }
}

/** Whether the engine that is picked could say something right now, in the voice that is picked. */
async function canSpeak({ family, voice, speaking, qwen: python, key }) {
  if (voice === undefined) return false
  if (family === 'fish') return key !== undefined
  if (family === 'qwen') return python !== undefined && (await qwen.ready(own, voice, python))
  return own ? piper.ready(own, voice, speaking) : false
}

/**
 * One line for two halves.
 *
 * `●` only when both work, because a plugin that can hear and not answer is not ready — it
 * is halfway, and the person looking at this screen is the one who has to decide whether to
 * wait. Only `▲` is coloured (D67): being ready is not something happening.
 *
 * **It stopped having to apologise for `expression`.** The old line ended
 * *"— expression is off, Piper has none"*, which is what a status line has to say when a
 * toggle is on screen that does nothing where it is. The engine is on screen now and it is
 * the thing that decides, so there is nothing left to explain away.
 */
function state({ hears, speaks, size, engine, family, voice, hearing, speaking, qwen: python, key }) {
  const named = ENGINES[engine].label
  if (voice === undefined) return `▲ ${named} is picked and no voice under it is chosen`
  if (family === 'fish' && !key) return `▲ ${named} is picked and there is no key to reach it with`
  if (family === 'qwen' && !python) return `▲ ${named} is picked and no Python has been pointed at`
  if (hears && speaks) return `● Ready — ${size}, ${voice} on ${named}`
  if (!whisper.build() && !hearing) return '▲ Point at a Whisper program'
  if (family === 'piper' && !piper.build() && !speaking) return '▲ Point at a Piper program'
  // A voice somebody added has no published size, and inventing one would be a number on
  // a screen that means nothing.
  const mb = family === 'piper' ? piper.VOICES[voice]?.mb : undefined
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
  const { size, family, voice, hearing, speaking } = await chosen()
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  const report = (done, total, message) => alexia.progress(ctx, done, total, message)
  await alexia.status('ready', '▲ Downloading').catch(() => {})
  try {
    if (half !== 'speaking') {
      if (!whisper.build() && !hearing) throw new Error(missing('Whisper', 'Whisper program'))
      await whisper.install(own, size, hearing, report)
    }
    // Only Piper has anything to fetch. The other two engines are a key and a Python that is
    // already there, and a download bar for either would be a bar for nothing.
    if (half !== 'hearing' && family === 'piper') {
      if (!piper.build() && !speaking) throw new Error(missing('Piper', 'Piper program'))
      await piper.install(own, voice, speaking, report)
    }
  } finally {
    await bind()
  }
}

/**
 * Text in, audio bytes out, from whichever engine the **voice** belongs to.
 *
 * One function rather than a branch in each of the two callers. *Say this reply out loud* and
 * *say my line in that voice* are the same question asked of the same three engines, and the
 * version where each caller knew about all three is the version where hearing a voice and
 * speaking in it could disagree about what a voice even is.
 *
 * The voice rather than the chosen engine, because a preview is asked of a row: somebody
 * auditioning a Piper voice while fish.audio is picked wants to hear that voice, not a
 * refusal about which engine is at the top of the page.
 *
 * `ctx` is only for expression, and it is the only reason this takes one — a preview has
 * nothing to mark up an emotion against, so it passes none and gets the plain words.
 */
async function utter(settings, { id, text, signal, ctx, format = 'wav' }) {
  const family = familyOf(id)
  if (family === 'fish') {
    if (!settings.key) throw new Error(`${id} lives on fish.audio and there is no key to reach it with.`)
    const marked = settings.expressive && ctx ? await annotate(text, ctx) : text
    const bytes = await fish.say(settings.key, { text: marked, id: fish.idOf(id), format, signal })
    return { bytes, wav: format === 'wav' }
  }
  if (family === 'qwen') {
    if (!settings.qwen) throw new Error(`${id} is a Qwen3-TTS voice and no Python has been pointed at.`)
    return { bytes: await readFile(await qwen.say(own, { python: settings.qwen, voice: id, text, signal })), wav: true }
  }
  if (!(await piper.ready(own, id, settings.speaking))) {
    throw new Error(`${id} is not downloaded yet. Choose it and it arrives the first time it speaks.`)
  }
  const there = await piper.programs(own, id, settings.speaking)
  return { bytes: await readFile(await piper.say({ ...there, text, signal })), wav: true }
}

/**
 * The last few previews, as `data:` URIs, in memory and nowhere else.
 *
 * **Not stored anywhere is true by construction rather than by a cleanup routine**: this map
 * dies with the process, and lazy spawn means the process dies five minutes after anybody
 * stops looking. What reaches the page is the URI on the row, which the browser holds for as
 * long as the card is drawn.
 *
 * Bounded because a `data:` URI is the audio: three of them is a few hundred kilobytes and
 * forty of them is a plugin holding somebody's afternoon of auditioning in RAM.
 */
const previews = new Map()
const PREVIEWS = 3

const remember = (id, bytes, type) => {
  previews.set(id, `data:${type};base64,${bytes.toString('base64')}`)
  for (const old of [...previews.keys()].slice(0, -PREVIEWS)) previews.delete(old)
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
    const { engine, family, voice, speaking } = picked
    if (voice === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${ENGINES[engine].label} is the engine and no voice under it has been chosen yet.` }],
      }
    }

    // Only Piper has anything to download, and only the chosen voice is worth downloading:
    // this is the moment somebody actually asked to hear it.
    if (family === 'piper' && !(await piper.ready(own, voice, speaking))) await fetching(ctx, 'speaking')
    await alexia.status('ready', '▲ Speaking').catch(() => {})
    try {
      // Written where Piper writes its own, so one file is overwritten rather than
      // accumulated and the purge that takes the folder takes this too.
      const { wav } = piper.where(own, 'lessac')
      // Markers are not stripped from a local engine's input for a reason: nothing puts them
      // there. `annotate` is only ever reached on the path that can read them.
      const { bytes } = await utter(picked, { id: voice, text: words, signal: ctx.mcpReq.signal, ctx })
      await writeFile(wav, bytes)
      await piper.play(wav, ctx.mcpReq.signal)
      return { content: [{ type: 'text', text: `Said it, in ${voice}’s voice.` }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
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
    where: 'Cloned by you, and living on your fish.audio account.',
    here: true,
    ...(one.preview && { preview: one.preview }),
  }))
  const already = new Set(account.map((one) => one.id))
  // A voice somebody kept that turns out to be their own is one voice, listed once, and the
  // account's own answer is the truer of the two.
  const saved = (await kept())
    .filter((one) => !already.has(one.id))
    .map((one) => ({
      id: one.id,
      name: one.name ?? one.id,
      where: 'Published on fish.audio by somebody else, and kept by you.',
      here: true,
      ...(one.preview && { preview: one.preview }),
    }))
  return [...account, ...saved]
}

/**
 * Every voice, under the engine it belongs to.
 *
 * **One list rather than one per engine**, because the question is *what can this machine
 * sound like* and the answer does not divide into three screens. `group` puts a labelled row
 * across the grid before the first card carrying it, in the order the rows arrive — so the
 * engine picked at the top comes first and the rest follow it, which is the order somebody
 * reading this page is actually in.
 *
 * The size moved out of `state` and into `meta`, so the states are a fixed short vocabulary
 * again — which is what lets the manifest say `dim: "■ not downloaded"` and mean it.
 */
alexia.tool(
  'voices',
  {
    description: 'List every speaking voice this machine has, which one is in use, and which are downloaded. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const picked = await chosen()
    const held = new Map(
      await Promise.all(
        ['piper', 'qwen', 'fish'].map(async (one) => [one, await alexia.storage.get(`voice_${one}`).catch(() => undefined)]),
      ),
    )
    const local = (await piper.catalogue(own)).map((one) => ({
      ...one,
      name: one.id,
      where: one.mine ? 'A voice you added, from a file of your own.' : 'Published for Piper, and downloaded on first use.',
    }))
    const families = {
      piper: local,
      qwen: await qwen.catalogue(own),
      fish: await cloudVoices(picked.key),
    }
    // The engine somebody is looking at first, then the other two in a fixed order — so the
    // grid does not reshuffle itself every time the engine above it changes.
    const order = [picked.family, ...['piper', 'qwen', 'fish'].filter((one) => one !== picked.family)]
    const rows = order.flatMap((family) =>
      families[family].map((one) => ({
        id: one.id,
        name: one.name ?? one.id,
        group: ENGINES[family === 'fish' ? 'fish_plain' : family].label,
        summary: one.where ?? '',
        // Three facts and the row says all of them: whether it is the one speaking, whether
        // it is this family's pick while another family is speaking, and whether it is
        // actually here. The chosen voice not being downloaded is an ordinary state — it
        // arrives on the first thing said in it — and a row claiming only the first is the
        // row somebody stares at wondering why nothing happens.
        state:
          one.id === picked.voice && family === picked.family ? (one.here ? '● speaking' : '▲ speaking — arrives on first use')
          : one.id === held.get(family) ? '◆ picked'
          : one.here ? '● ready'
          : '■ not downloaded',
        ...(one.mb && { meta: `${one.mb} MB` }),
        // Whatever was generated for it since this process started, and otherwise the
        // vendor's own sample where there is one. Both play in the row; neither is stored.
        ...((previews.get(one.id) ?? one.preview) && { preview: previews.get(one.id) ?? one.preview }),
      })),
    )
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
      lastFound.set(id, { name: one.name, ...(one.preview && { preview: one.preview }) })
      return {
        id,
        name: one.name,
        // The author's own sentence about the voice, which is what somebody reads to decide.
        // The tag list is the fallback rather than the summary: *character-voice · energetic*
        // is four words that mean less than one line of description.
        summary: one.about ?? one.tags.slice(0, 4).join(' · '),
        meta: [...one.tags.slice(0, 3), `${one.likes} likes`].join(' · '),
        state: held.has(id) ? '● kept' : '■ not kept',
        // The vendor's published sample, on the row, until somebody asks to hear their own
        // line in it. A public URL needing no key, no proxy and nothing stored.
        ...((previews.get(id) ?? one.preview) && { preview: previews.get(id) ?? one.preview }),
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
    const found = lastFound.get(id)
    if (found === undefined) {
      // Rather than writing the id down as a name. A row whose name is a hex string is a row
      // nobody can pick out of a list, and the fix is one press of Search.
      return { isError: true, content: [{ type: 'text', text: 'Search again, then keep the voice from the row it appears on.' }] }
    }
    const { name } = found
    await alexia.storage.set('kept', [...held, { id, name, ...(found.preview && { preview: found.preview }) }])
    await bind()
    return { content: [{ type: 'text', text: `${name} is in the list. Choose it to speak in it.` }] }
  },
)

/**
 * What it sounds like saying **your** line, before it is the voice that answers.
 *
 * **It plays on the row rather than out of the speakers, and that is the change.** The old
 * version spoke through the operating system's own player, which was the right answer while a
 * plugin had no way to put a control on a page: the vendor's sample is whatever format its
 * author uploaded, and handing that to `SoundPlayer` was a coin toss. A row can carry a
 * player now, so the audio goes there — where the voice it belongs to is, next to the button
 * that made it, and stoppable.
 *
 * The bytes go into a `Map` that dies with the process and never touch disk beyond the one
 * scratch file Piper overwrites anyway. *Not stored anywhere* is therefore a property of
 * where this lives rather than a cleanup routine somebody has to remember to run.
 *
 * **Deliberately not a download.** A button that says *hear it* should not spend 60 MB and a
 * minute to answer; a Piper voice arrives the first time it is actually asked to speak.
 */
alexia.tool(
  'preview_voice',
  {
    description:
      'Say the line in the preview box in one voice, without making it the voice that speaks. ' +
      'The audio appears on that voice’s own card. Takes the voice’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which voice.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ id }, ctx) => {
    const picked = await chosen()
    await alexia.status('ready', '▲ Speaking').catch(() => {})
    try {
      // Mp3 from the cloud engine, because a `data:` URI *is* the audio and a WAV of one
      // sentence is a couple of megabytes of base64 through a JSON body for no gain. The
      // local engines make WAV and there is nothing here that would convert it.
      const cloud = familyOf(id) === 'fish'
      const { bytes } = await utter(picked, {
        id,
        text: picked.preview,
        signal: ctx?.mcpReq?.signal,
        ...(cloud && { format: 'mp3' }),
      })
      remember(id, bytes, cloud ? 'audio/mpeg' : 'audio/wav')
      return { content: [{ type: 'text', text: `That is ${await nameOf(id)}. Press play on its card.` }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
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
    const picked = await chosen()
    const family = familyOf(id)
    const known = (await voicesIn(family, picked)).find((one) => one.id === id)
    if (!known) return { isError: true, content: [{ type: 'text', text: `There is no voice called ${id}.` }] }
    await alexia.storage.set(`voice_${family}`, id)
    await bind()
    // Downloading is not done here: a published voice that is not on disk yet arrives on the
    // first thing said in it, the same as it always did.
    const called = known.name ?? id
    const arriving = known.here ? '' : ', and downloads the first time it is used'
    // **The engine is not switched here, and that is deliberate.** A plugin may only write its
    // own `status` — everything else on that screen is the user's answer, and a plugin that
    // could rewrite a choice could quietly undo a decision somebody made. So a voice under
    // another engine becomes that engine's voice and the sentence says which press is left.
    return {
      content: [
        {
          type: 'text',
          text:
            family === picked.family ?
              `${called} is speaking now${arriving}.`
            : `${called} is ${ENGINES[family === 'fish' ? 'fish_plain' : family].label}'s voice now${arriving}. Choose that engine at the top to hear it.`,
        },
      ],
    }
  },
)

/** One family's voices, asked the same way the list above asks for all three. */
async function voicesIn(family, picked) {
  if (family === 'fish') return cloudVoices(picked.key)
  if (family === 'qwen') return qwen.catalogue(own)
  return piper.catalogue(own)
}

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
    const family = familyOf(id)
    const clone = fish.idOf(id)
    /**
     * Forget it as this family's pick, if it was.
     *
     * A chosen voice that no longer exists is silence with no explanation, so the selection
     * falls back rather than dangling — to Piper's lessac, and to nothing at all for the two
     * families whose voices are all somebody's own. *Nothing chosen* is an honest state and
     * the status line says it; inventing a replacement would not be.
     */
    const forget = async () => {
      if ((await alexia.storage.get(`voice_${family}`).catch(() => undefined)) !== id) return ''
      await alexia.storage.set(`voice_${family}`, FIRST[family] ?? '')
      return FIRST[family] ? ` ${FIRST[family]} is speaking.` : ' Nothing is chosen under that engine now.'
    }

    // A kept voice first, because it is the one case where removing is *forgetting*: it
    // belongs to whoever published it, this machine holds only a line saying it is in the
    // list, and calling the vendor's delete for it would be asking to delete somebody
    // else's voice.
    // Asked before anything is removed, because on the cloud engine the name is on the
    // account and the next line is what takes it off.
    const called = await nameOf(id, key)
    const held = await kept()
    if (held.some((one) => one.id === id)) {
      await alexia.storage.set('kept', held.filter((one) => one.id !== id))
      const said = await forget()
      await bind()
      return { content: [{ type: 'text', text: `${called} is out of the list. It is still published on fish.audio.${said}` }] }
    }
    if (clone !== undefined) {
      if (!key) return { isError: true, content: [{ type: 'text', text: 'There is no fish.audio key, so there is nothing to remove it with.' }] }
      // Gone from the account, not from a folder.
      await fish.remove(key, clone)
      const said = await forget()
      await bind()
      return { content: [{ type: 'text', text: `${called} is gone from fish.audio.${said}` }] }
    }
    if (family === 'qwen') {
      const gone = await qwen.remove(own, id)
      if (!gone) return { isError: true, content: [{ type: 'text', text: `There is no Qwen3-TTS voice called ${id}.` }] }
      const said = await forget()
      await bind()
      return { content: [{ type: 'text', text: `${called} is gone from this machine.${said}` }] }
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
    const said = await forget()
    await bind()
    return { content: [{ type: 'text', text: `${called} is gone.${said}` }] }
  },
)

alexia.tool(
  'add_voice',
  {
    description:
      'Copy a Piper voice you have downloaded into Alexia, so it can speak in it. Reads the file chosen in the “Add a Piper voice” box. Takes no arguments.',
    annotations: { openWorldHint: false },
  },
  async () => {
    const settings = await alexia.settings()
    // **A path, exactly as before.** The box above it is a file picker now rather than a
    // typed path, and this function did not change: core writes the bytes somewhere inside
    // this plugin's own folder and stores the path it made, so what arrives here is what
    // always arrived here. That is the whole of what made `file` possible (D89).
    const from = typeof settings.add_voice === 'string' ? settings.add_voice.trim() : ''
    if (from === '') return { isError: true, content: [{ type: 'text', text: 'Choose a Piper .onnx file above first.' }] }
    if (!from.endsWith('.onnx')) {
      return { isError: true, content: [{ type: 'text', text: 'A Piper voice is a .onnx file, with its .onnx.json beside it.' }] }
    }
    /**
     * Both halves, chosen separately.
     *
     * The typed-path version could find the config beside the model because it knew where the
     * model was on somebody's disk. A picker hands over one file and no folder, so the second
     * half is a second picker — which is the honest shape anyway: **a Piper voice is two
     * files**, and the box that says so is better than a folder convention nobody was told.
     */
    const config = typeof settings.add_config === 'string' ? settings.add_config.trim() : ''
    if (config === '') {
      return { isError: true, content: [{ type: 'text', text: 'Choose the matching .onnx.json as well. Piper will not load a voice without it.' }] }
    }
    const stem = basename(from, '.onnx')
    const there = piper.where(own, stem)
    try {
      // Both halves or neither: Piper will not load a voice without its config, and the
      // config is where the sample rate lives — so half a voice is silence, not an error.
      await copyFile(from, there.model)
      await copyFile(config, there.config)
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
      'Make a voice that sounds like a recording, using the file chosen in the “A recording to clone” ' +
      'box and the words in “What the recording says”. Takes no arguments.',
    // It may reach an API and put something on somebody's account, so it says both.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (ctx) => {
    const { engine, family, key, qwen: python, clip, clipText } = await chosen()
    const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
    if (family === 'piper') return refuse('Piper cannot clone a voice from a recording. Choose Qwen3-TTS or fish.audio at the top.')
    if (family === 'fish' && !key) return refuse('Add a fish.audio key at the bottom of this page first.')
    if (family === 'qwen' && !python) return refuse('Point “Qwen program” at a Python that has qwen-tts installed first.')
    if (!clip) return refuse('Choose a recording of the voice you want, above.')
    if (clipText === '') return refuse('Put the words that were said in the clip into “What the recording says”.')

    const name = basename(clip).replace(/\.[^.]+$/, '') || 'my voice'
    await alexia.status('ready', '▲ Cloning').catch(() => {})
    try {
      // **Which engine clones is the engine that is picked**, and the difference between the
      // two is the whole reason the card at the top says what it says: one of them keeps the
      // clip on this machine and the other sends it away to be learned from.
      const made =
        family === 'qwen' ?
          await qwen.clone(own, { python, name, clip, transcript: clipText, signal: ctx?.mcpReq?.signal })
        : await fish.clone(key, { name, wav: clip, transcript: clipText, signal: ctx?.mcpReq?.signal })
      const id = family === 'qwen' ? `${qwen.PREFIX}${made.id}` : `${fish.PREFIX}${made.id}`
      // Picked straight away. Somebody who has just cloned their own voice wanted to hear
      // it, and making them find it in a list first is a step with no decision in it.
      await alexia.storage.set(`voice_${family}`, id)
      // Said out loud because on one of the two engines it is the one thing about this that a
      // delete cannot undo: the voice is on somebody's account, not on this disk, so removing
      // the plugin does not remove it. **Remove** on this page is what does.
      return {
        content: [
          {
            type: 'text',
            text:
              family === 'qwen' ?
                `${made.name} is cloned and speaking now. It is a file in this plugin's own folder, and deleting the plugin takes it with it.`
              : `${made.name} is cloned and speaking now. It lives on your fish.audio account — deleting this plugin will not remove it, but Remove on this page will.`,
          },
        ],
      }
    } catch (error) {
      return refuse(`That did not work: ${error instanceof Error ? error.message : String(error)}. Engine: ${ENGINES[engine].label}.`)
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
  // The engine joined the list, and it is the one that changes the most: which family speaks
  // decides which files matter, whether there is a key to reach anything with, and every
  // sentence the status line is able to say.
  if (['engine', 'model_size', 'whisper_path', 'piper_path', 'qwen_path'].some((key) => key in changed)) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
