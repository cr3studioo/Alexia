// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { build, install, listen, MODELS, programs, ready, spoken, transcribe } from './whisper.js'

/**
 * Voice — the plugin the contract was designed against (M2-3).
 *
 * It is here because it exercises every hard mechanism at once: a large download with
 * progress, a binary spawned as a child process, a permission a person has to actually
 * agree to, and a capability that cannot be answered until a file finishes arriving.
 *
 * **The microphone is opened in this process and only text goes back.** That is not a
 * policy written down somewhere — it is a property of where the code runs. Core spawns this
 * plugin and reads JSON from a pipe; there is no audio on that pipe, and no way for core to
 * ask for any. Process isolation was bought for exactly this, and this is the first place
 * it is visible.
 */

const alexia = plugin()

/** Set once at startup and re-read after every install, so nothing spawns to answer a screen. */
let own

/** What the user chose, with the manifest's defaults filled in. */
async function chosen() {
  const settings = await alexia.settings()
  return {
    size: MODELS[settings.model_size] ? settings.model_size : 'base',
    threads: Number(settings.threads) || 4,
    override: typeof settings.whisper_path === 'string' && settings.whisper_path !== '' ? settings.whisper_path : undefined,
  }
}

/**
 * The runtime half of `provides` (D59).
 *
 * `voice.transcribe` is declared in the manifest — that is the promise, and it is what the
 * library shows and what another plugin's `requires` resolves against. This is the
 * statement about *right now*: a plugin whose model is still downloading cannot turn speech
 * into text, and a caller is better served by `-32050` than by a tool that fails halfway.
 * So the binding goes on and off with the file.
 */
async function bind() {
  const { size, override } = await chosen()
  const can = own ? await ready(own, size, override) : false
  file.update({ _meta: can ? { 'alexia/provides': ['voice.transcribe'] } : {} })
  await alexia
    .status(
      'ready',
      can ? `● Ready — ${size}`
      : !build() && !override ? '▲ Point at a Whisper program'
      : `■ Not downloaded — ${MODELS[size].mb} MB`,
    )
    .catch(() => {})
  return can
}

/** Fetch whatever is missing, reporting it, then re-answer the question of what we can do. */
async function fetching(ctx) {
  const { size, override } = await chosen()
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  if (!build() && !override) {
    throw new Error(
      `There is no prebuilt Whisper for ${process.platform}/${process.arch}. Install one and set “Whisper program” to it.`,
    )
  }
  await alexia.status('ready', '▲ Downloading').catch(() => {})
  try {
    await install(own, size, override, (done, total, message) => alexia.progress(ctx, done, total, message))
  } finally {
    await bind()
  }
}

const file = alexia.tool(
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
  async ({ file: path }, ctx) => {
    const { size, threads, override } = await chosen()
    if (!(await ready(own, size, override))) await fetching(ctx)
    const found = await programs(own, size, override)
    const text = spoken(await transcribe({ ...found, file: path, threads, signal: ctx.mcpReq.signal }))
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
    const { size, threads, override } = await chosen()
    if (!(await ready(own, size, override))) await fetching(ctx)
    const found = await programs(own, size, override)
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
      const text = await listen({ ...found, seconds, threads, signal: ctx.mcpReq.signal })
      await keep(text, 'microphone')
      return { content: [{ type: 'text', text: text || 'I did not hear anything.' }] }
    } finally {
      await bind()
    }
  },
)

alexia.tool(
  'install',
  {
    description:
      'Download Whisper and the speech model, so that listening and transcribing work. Reports progress. Use only when the user explicitly asks to install or update the speech model. Takes no arguments.',
    annotations: { openWorldHint: true },
  },
  async (ctx) => {
    const { size } = await chosen()
    await fetching(ctx)
    return { content: [{ type: 'text', text: `Whisper and the ${size} model are ready.` }] }
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
// The model can change under us, and it is the thing that decides whether the capability is
// answerable at all — so the binding is re-checked rather than assumed to still hold.
alexia.onSettingsChanged((changed) => {
  if ('model_size' in changed || 'whisper_path' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
