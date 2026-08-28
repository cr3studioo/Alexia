// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkpoints, graph, image, queue, wait } from './comfy.js'

/**
 * Local image generation (M4-6).
 *
 * **Without this, Combined mode is Cloud mode with extra words.** The whole claim is *the
 * cloud thinks, your machine makes the media* — and until something on this machine
 * actually makes media, the second half of that sentence is a plan rather than a fact.
 *
 * It drives ComfyUI rather than embedding a diffusion runtime, which is the same trade
 * voice makes with Whisper: the hard part is somebody else's, kept up to date by somebody
 * else, and what is here is a graph and an honest sentence about whether it is reachable.
 */

const alexia = plugin()

let own
/** What ComfyUI said it has, refreshed when it is reachable. Empty means not reached yet. */
let available = []

const settings = () => alexia.settings()

const where = async () => String((await settings()).server ?? '').replace(/\/+$/, '') || 'http://127.0.0.1:8188'

/**
 * Is ComfyUI there?
 *
 * Asked rather than assumed, and the answer is a sentence a person can act on. *Not
 * running* is by far the commonest state of this plugin and it is not an error — ComfyUI is
 * a separate program somebody starts.
 */
async function look(signal) {
  try {
    available = await checkpoints(await where(), signal)
    return available.length > 0 ?
        { ok: true, said: `● Ready — ${available.length} model${available.length === 1 ? '' : 's'}` }
      : { ok: false, said: '▲ ComfyUI is running but has no checkpoint installed' }
  } catch {
    available = []
    return { ok: false, said: `■ ComfyUI is not answering at ${await where()}` }
  }
}

async function bind(signal) {
  const state = await look(signal)
  await alexia.status('state', state.said).catch(() => {})
  // The capability goes on only when there is something to generate *with*. A promise this
  // plugin cannot keep is worse for a caller than an honest -32050.
  made.update({ _meta: state.ok ? { 'alexia/provides': ['image.generate'] } : {} })
  return state
}

/** Which checkpoint to use: the one chosen, or whatever is there. */
async function chosen() {
  const { checkpoint, steps, vae_fp32: fp32 } = await settings()
  const picked = available.includes(checkpoint) ? checkpoint : available[0]
  return { checkpoint: picked, steps: Number(steps) || 25, fp32: fp32 !== false }
}

const made = alexia.tool(
  'generate',
  {
    description:
      'Make an image on this machine from a description, and save it. Returns the file path. ' +
      'Use when the user asks for a picture, an illustration, a logo or a mock-up. Takes ' +
      'twenty seconds to a few minutes depending on the machine, and reports progress.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the picture shows. Concrete and visual — subject, setting, style, lighting.',
        },
        negative: { type: 'string', description: 'What to keep out of it. Optional.' },
        width: { type: 'number', description: 'Pixels wide. Defaults to 1024; SDXL wants multiples of 64.' },
        height: { type: 'number', description: 'Pixels tall. Defaults to 1024.' },
        seed: { type: 'number', description: 'Same seed and same prompt gives the same picture. Omit for a new one.' },
      },
      required: ['prompt'],
    }),
    // It writes a file into this plugin's own folder and nothing else. Not read-only —
    // something new exists afterwards — and not destructive: nothing is overwritten.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ prompt, negative, width, height, seed }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    const state = await bind(signal)
    if (!state.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${state.said}. Start ComfyUI and try again — it is a separate program, and Alexia does not start it for you.`,
          },
        ],
      }
    }
    if (!own) return { isError: true, content: [{ type: 'text', text: 'Alexia has not given this plugin a folder to work in.' }] }

    const server = await where()
    const { checkpoint, steps, fp32 } = await chosen()
    const built = graph({
      prompt: String(prompt),
      negative: String(negative ?? 'blurry, low quality, watermark, text'),
      checkpoint,
      steps,
      // Rounded to 64 because SDXL's latent space is in units of 8 and its training is in
      // units of 64. A model handed 1000x1000 makes something subtly wrong rather than
      // refusing, which is the worst of both.
      width: round64(width ?? 1024),
      height: round64(height ?? 1024),
      seed: Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 2 ** 31),
      fp32,
    })

    const id = await queue(server, built, 'alexia', signal)
    const found = await wait(server, id, {
      signal,
      onProgress: (message, tick) => alexia.progress(ctx, tick, 0, message),
    })

    const saved = []
    for (const one of found) {
      const bytes = await image(server, one, signal)
      const to = join(own, `${Date.now()}-${one.filename}`)
      writeFileSync(to, Buffer.from(bytes))
      saved.push(to)
      await alexia.storage
        .insert('images', { path: to, prompt: String(prompt), checkpoint, at: Date.now() })
        .catch(() => {})
    }
    await bind(signal)
    return {
      content: [{ type: 'text', text: `${saved.join('\n')}\nMade here, with ${checkpoint}.` }],
    }
  },
)

const round64 = (n) => Math.max(256, Math.min(2048, Math.round(Number(n) / 64) * 64))

alexia.tool(
  'models',
  {
    description: 'List the image models ComfyUI has installed on this machine. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    const state = await bind(ctx?.mcpReq?.signal)
    return {
      content: [{ type: 'text', text: available.length > 0 ? available.join('\n') : state.said }],
    }
  },
)

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
alexia.onSettingsChanged((changed) => {
  if ('server' in changed || 'checkpoint' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
