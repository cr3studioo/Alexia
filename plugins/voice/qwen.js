// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run, there } from './fetching.js'

/**
 * The third engine: better speech than Piper, cloning without a cloud, and **nothing
 * downloaded on anybody's behalf**.
 *
 * The gap this fills is a real one and it is stated in `fish.js`'s own header: Piper is fast
 * and cannot clone; the cloud engine clones and sends the words away. Between those two there
 * was nothing for the person who wants their own voice *and* wants it to stay here.
 *
 * **The doctrine is `plugins/media/launch.js`'s, borrowed rather than reinvented**, because it
 * already answered this exact question for ComfyUI:
 *
 * > Nothing here embeds ComfyUI or ships a copy of it… a plugin that quietly pulls six
 * > gigabytes of PyTorch because somebody asked for a picture is a plugin that has decided
 * > something for you.
 *
 * So: this file spawns a Python **that already exists on this machine**, and if there is none
 * it says so and stops. It never installs anything, never fetches a model, and the engine card
 * on the page is dimmed with that sentence on it until somebody has pointed it at one. It is a
 * sibling implementation of that shape rather than an import, because plugins cannot import
 * each other — and if the two stay this close, the Python-finding half is worth lifting into
 * `@alexia/sdk`.
 *
 * **A clone here is a recording and the words in it, and that is not a shortcut.** Qwen-class
 * TTS is zero-shot: it is handed a reference clip at synthesis time and imitates it, so there
 * is no training step to run, nothing to wait for, and nothing on anybody's account. Cloning
 * is therefore *copying a file into this folder*, which is also why removing one is deleting
 * two files and why the whole of it goes when the plugin's folder does (invariant 5).
 */

/** How a Qwen voice is named in this plugin's list. Everything without a prefix is a Piper stem. */
export const PREFIX = 'qwen:'

export const idOf = (voice) => (voice.startsWith(PREFIX) ? voice.slice(PREFIX.length) || undefined : undefined)

/** Where everything this engine has lives, all of it under the one directory purge removes. */
export const where = (ownDir, voice) => {
  const stem = idOf(voice) ?? voice
  return {
    dir: join(ownDir, 'qwen'),
    clip: join(ownDir, 'qwen', `${stem}.wav`),
    about: join(ownDir, 'qwen', `${stem}.json`),
    out: join(ownDir, 'qwen', 'spoken.wav'),
  }
}

/** Our side of the bridge, beside this file, so it ships and purges with the plugin. */
const BRIDGE = new URL('qwen.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * A voice is ready when its clip is here and there is a Python to hand it to.
 *
 * Deliberately **not** a check that the model weights are downloaded. Asking that would mean
 * loading the model — thirty seconds — every time a settings screen was drawn, which is the
 * exact cost lazy spawn exists to avoid. The first thing said in this voice is where a missing
 * model turns up, as the sentence Python printed, which is a better place for it than a page.
 */
export async function ready(ownDir, voice, python) {
  if (!python || !ownDir) return false
  const { clip, about } = where(ownDir, voice)
  return (await there(clip)) && (await there(about))
}

/**
 * Every voice cloned here, read off the folder.
 *
 * The same rule `piper.catalogue` follows and for the same reason: a voice is files on disk,
 * so a folder listing is the truth and a list kept beside it is a second answer waiting to
 * disagree. There are no published Qwen voices to offer — every one of them is somebody's own
 * recording — so an empty list is the ordinary first state rather than a failure.
 */
export async function catalogue(ownDir) {
  if (!ownDir) return []
  let names
  try {
    names = await readdir(where(ownDir, '').dir)
  } catch {
    // No folder yet, which is where everybody starts.
    return []
  }
  const found = []
  for (const name of names.filter((one) => one.endsWith('.json')).sort()) {
    const stem = name.slice(0, -'.json'.length)
    const said = await readFile(join(where(ownDir, '').dir, name), 'utf8').catch(() => '{}')
    let about = {}
    try {
      about = JSON.parse(said)
    } catch {
      // A sidecar somebody edited by hand. The clip is still the voice; the name falls back.
    }
    found.push({
      id: `${PREFIX}${stem}`,
      name: String(about.name ?? stem),
      where: 'Cloned on this machine, from a recording that never left it.',
      here: await there(where(ownDir, stem).clip),
      mine: true,
    })
  }
  return found
}

/**
 * A voice cloned from one clip and its transcript — which here means *kept*.
 *
 * There is no training step and no upload here: the clip is copied into this plugin's folder
 * beside a line saying what was said in it, and synthesis hands both to the model running on
 * this machine. (What the rest of Alexia does with the words it then speaks is a separate
 * question with its own answer, and this file is not it.)
 *
 * The name doubles as the id after being made safe for a filename, so the folder is readable
 * and a person can see what they have without this file's help.
 */
export async function clone(ownDir, { name, clip, transcript }) {
  if (!ownDir) throw new Error('Alexia has not given this plugin a folder to work in.')
  const stem =
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'my-voice'
  const { dir, clip: to, about } = where(ownDir, stem)
  await mkdir(dir, { recursive: true })
  await copyFile(clip, to)
  await writeFile(about, JSON.stringify({ name: String(name), transcript: String(transcript) }, null, 2), 'utf8')
  return { id: stem, name: String(name) }
}

/** Gone: the clip and the line about it, and nothing else was ever written. */
export async function remove(ownDir, voice) {
  const { clip, about } = where(ownDir, voice)
  if (!(await there(about))) return false
  await rm(clip, { force: true })
  await rm(about, { force: true })
  return true
}

/**
 * Text in, a WAV file out.
 *
 * ponytail: the model is loaded per call — ten to thirty seconds before the first sound. That
 * is a real ceiling and it is the thing `fish.js` measured as making the predecessor's local
 * cloner unusable, so it is written down rather than discovered: **the upgrade is a resident
 * Python reading one request per line on stdin**, which keeps the model in memory across
 * calls. It is not that today because this plugin is lazily spawned — five quiet minutes and
 * core stops it — so a daemon would need a pid file and a port, which is `launch.js`'s whole
 * second half, and nobody has yet said this engine is the one they use all day.
 *
 * Arguments rather than stdin because the reference clip, its transcript and the text are
 * three values and the shell is not involved: `spawn` passes them as an array.
 */
export async function say(ownDir, { python, voice, text, signal }) {
  const { clip, about, out } = where(ownDir, voice)
  if (!(await there(clip))) throw new Error(`${voice} has no recording behind it any more.`)
  const said = JSON.parse(await readFile(about, 'utf8').catch(() => '{}'))
  await run(
    python,
    [BRIDGE, '--ref', clip, '--ref-text', String(said.transcript ?? ''), '--text', text, '--out', out],
    { signal },
  )
  return out
}
