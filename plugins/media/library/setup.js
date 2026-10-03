// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { template as fromServer } from '../comfy.js'
import { convert } from '../convert.js'
import { fetchModel } from '../models.js'
import { API_SUFFIX, FOLDER, isApi, write } from '../workflows.js'
import { installPacks, mergePacks, packsOf, present } from './packs.js'

/**
 * Installing one workflow, with everything it needs, on the computer that renders.
 *
 * **One function, two callers, and the difference between them is who pressed what.** On the
 * computer somebody is sitting at, *Install* on the library page is the press, and this runs
 * straight away. On a paired computer it runs from the `install` hook — which core calls only
 * after somebody pressed *Install* beside that workflow in the computer's setup list, with its
 * size on the button — so nothing here ever starts because a conversation decided it should.
 *
 * In order, because the order is what makes a failure cheap:
 *
 * 1. **The workflow file** — ComfyUI's own template, read off the install's disk where it is
 *    there and from ComfyUI otherwise, or a community file the planner already fetched.
 * 2. **What it needs, worked out from the file itself.** ComfyUI's templates carry each model's
 *    name, folder and download address, and every node says which pack it came from.
 * 3. **On a ComfyUI somebody installed themselves, stop here and list it** — the file is saved,
 *    because that is a JSON file in their workflows folder and always has been, and nothing is
 *    downloaded or installed into their program.
 * 4. **Node packs first, because they are quick and they can fail.** All or nothing (`packs.js`):
 *    a pack that will not install costs a few seconds and leaves ComfyUI as it was, rather than
 *    failing after twenty gigabytes of models arrived for a workflow that cannot run.
 * 5. **Models**, each into the folder ComfyUI loads it from, resumable, with progress.
 * 6. **ComfyUI restarted** — the next start is the one that loads the new packs — and the
 *    workflow saved with its API export, converted against the nodes that ComfyUI now has.
 */

/** Every model an editor-format workflow names, with where it goes and where it comes from. */
export function modelsOf(doc) {
  const nodes = [
    ...(Array.isArray(doc?.nodes) ? doc.nodes : []),
    ...(Array.isArray(doc?.definitions?.subgraphs) ? doc.definitions.subgraphs.flatMap((one) => one?.nodes ?? []) : []),
  ]
  const listed = [...(Array.isArray(doc?.models) ? doc.models : []), ...nodes.flatMap((node) => (Array.isArray(node?.properties?.models) ? node.properties.models : []))]
  const found = new Map()
  for (const one of listed) {
    const name = String(one?.name ?? '').trim()
    const directory = String(one?.directory ?? '').trim()
    const url = String(one?.url ?? '').trim()
    if (!name || !directory || !/^https:\/\//i.test(url)) continue
    if (!found.has(name)) found.set(name, { name, directory, url })
  }
  return [...found.values()]
}

/** Two lists of the same models, merged by file name; the curated one, which carries a size, first. */
const mergeModels = (...lists) => {
  const found = new Map()
  for (const list of lists) for (const one of list ?? []) if (!found.has(one.name)) found.set(one.name, { ...one })
  return [...found.values()]
}

/**
 * Where a model goes in this ComfyUI, or nothing when the name or folder would leave `models`.
 *
 * A template is a file off the internet as far as this code is concerned, and `../../x` in a
 * folder name is a write anywhere on the disk.
 */
export function placeOf(dir, model) {
  const root = resolve(dir, 'models')
  const to = resolve(root, ...String(model.directory).split(/[\\/]+/), String(model.name))
  return to.startsWith(root + sep) ? to : undefined
}

/**
 * How big a download is, asked of the server rather than guessed.
 *
 * Hugging Face answers a `HEAD` on a `resolve` address with a redirect carrying the real size as
 * `x-linked-size`; everything else answers with `content-length` once the redirect is followed.
 * No answer is `undefined`, and a list showing *size unknown* is truer than one inventing it.
 */
export async function sizeOf(url, { fetch = globalThis.fetch, signal } = {}) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal })
    const said = Number(response.headers.get('x-linked-size') ?? response.headers.get('content-length'))
    return response.ok && Number.isFinite(said) && said > 0 ? said : undefined
  } catch {
    return undefined
  }
}

/**
 * The folder ComfyUI's own template package keeps its files in, inside this install's Python.
 *
 * Read off the disk so a library can be drawn and a template installed **without starting
 * ComfyUI** — on a computer in another room, starting a program to answer a list would be the
 * list deciding something. ComfyUI has shipped its templates as `comfyui_workflow_templates*`
 * packages since 0.3.40; an install older than that, or one laid out some other way, is simply
 * asked over HTTP instead.
 */
export async function templatesOnDisk(dir) {
  if (!dir) return undefined
  const roots = [join(dirname(dir), 'python_embeded', 'Lib', 'site-packages')]
  for (const venv of ['.venv', 'venv']) {
    roots.push(join(dir, venv, 'Lib', 'site-packages'))
    for (const one of await readdir(join(dir, venv, 'lib')).catch(() => [])) roots.push(join(dir, venv, 'lib', one, 'site-packages'))
  }
  for (const root of roots) {
    const packages = (await readdir(root).catch(() => [])).filter((one) => /^comfyui_workflow_templates/i.test(one) && !/\.dist-info$/i.test(one)).sort()
    for (const one of packages) {
      const at = join(root, one, 'templates')
      if (await readFile(join(at, 'index.json')).then(() => true, () => false)) return at
    }
  }
  return undefined
}

/** One template off the disk, or nothing — then it is asked of ComfyUI. */
export async function templateOnDisk(dir, name) {
  const at = await templatesOnDisk(dir)
  if (!at || !/^[\w.\- ]+$/.test(name)) return undefined
  return JSON.parse(await readFile(join(at, `${name}.json`), 'utf8').catch(() => 'null')) ?? undefined
}

/** The catalogue off the disk, in the shape `GET /templates/index.json` answers. */
export async function catalogueOnDisk(dir) {
  const at = await templatesOnDisk(dir)
  return at ? JSON.parse(await readFile(join(at, 'index.json'), 'utf8').catch(() => '[]')) : []
}

/** The name a workflow is saved under in ComfyUI's workflows folder. */
export const savedAs = (id) => String(id).replace(/^(community|found):/, '').replace(/[^\w.\- ]+/g, '_')

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

/** One line per thing a workflow needs, for a person reading a list. */
export function needsLines({ models = [], packs = [] }) {
  return [
    ...models
      .filter((one) => !one.have)
      .map((one) =>
        one.manual ?
          `model ${one.name}${one.directory ? ` → models/${one.directory}` : ''} — its source gives no download address, so it has to be added by hand`
        : `model ${one.name} → models/${one.directory}${one.bytes ? ` (${gb(one.bytes)})` : ''} from ${one.url}`,
      ),
    ...packs
      .filter((one) => !one.have)
      .map((one) => `node pack ${one.name}${one.version ? ` ${one.version}` : one.commit ? ` at ${one.commit.slice(0, 12)}` : ''}${one.url ? ` from ${one.url}` : ''}`),
  ]
}

/**
 * What one workflow needs on this ComfyUI and does not have, with sizes, and nothing installed.
 *
 * `want` is the request: `{ id, title, doc?, models?, packs? }`. `place` is the ComfyUI —
 * `{ dir, own, server(signal) }`.
 */
export async function needs(want, place, { fetch = globalThis.fetch, signal } = {}) {
  const doc = want.doc ?? (await workflowFile(want, place, { signal }))
  const models = await Promise.all(
    mergeModels(want.models, modelsOf(doc)).map(async (one) => {
      // A model a source named without saying where it goes or where it comes from: listed, so
      // somebody can add it by hand, and never downloaded.
      if (!one.directory || !one.url) return { ...one, have: false, manual: true }
      const to = place.dir ? placeOf(place.dir, one) : undefined
      const have = to ? await readFile(to).then(() => true, () => false) : false
      return { ...one, have, ...(!have && !one.bytes && { bytes: await sizeOf(one.url, { fetch, signal }) }) }
    }),
  )
  const packs = await present(mergePacks(want.packs, packsOf(doc)), { dir: place.dir })
  const bytes = models.filter((one) => !one.have).reduce((sum, one) => sum + (one.bytes ?? 0), 0)
  return { doc, models, packs, bytes, lines: needsLines({ models, packs }) }
}

/** The editor-format file for this workflow: given, on the disk, or asked of ComfyUI. */
async function workflowFile(want, place, { signal }) {
  if (want.doc) return want.doc
  if (String(want.id).startsWith('community:')) throw new Error(`${want.title ?? want.id} has no workflow file to install from.`)
  const off = await templateOnDisk(place.dir, want.id)
  if (off) return off
  return await fromServer(await place.server(signal), want.id, signal)
}

/**
 * Install one workflow and everything it needs. See the top of this file for the order.
 *
 * Answers `{ name, models, packs, saved, export, personal, lines }`: what it is saved as, the
 * models and packs it now has (each pack with its record), and, for a ComfyUI somebody installed
 * themselves, the lines saying what they still have to add. Throws with `pack` set when a node
 * pack failed, after `packs.js` put everything back.
 */
export async function installWorkflow(want, place, deps = {}) {
  const { signal, onProgress = () => {}, fetch = globalThis.fetch, download = fetchModel, run, now, platform, classes } = deps
  if (!place.dir && place.own) throw new Error('Alexia’s own ComfyUI is not installed on this computer yet.')
  const found = await needs(want, place, { fetch, signal })
  const name = savedAs(want.name ?? want.id)

  if (!place.own) {
    // Somebody's own ComfyUI: their file goes where their workflows go, and the rest is a list.
    const saved = await save(found.doc, name, place, { signal, classes })
    return { name, ...saved, models: found.models, packs: found.packs, personal: true, lines: found.lines }
  }

  const packs = found.packs.filter((one) => !one.have)
  let records = []
  if (packs.length > 0) {
    // ComfyUI holds a pack's compiled libraries open while it runs, and on Windows a file that
    // is open cannot be replaced — so it is let go of before anything is written into it.
    await place.release?.()
    records = await installPacks(packs, {
      dir: place.dir,
      run,
      fetch,
      signal,
      now,
      platform,
      onProgress: (done, total, said) => onProgress(done, total, said),
    })
  }

  const missing = found.models.filter((one) => !one.have && !one.manual)
  for (const [index, one] of missing.entries()) {
    const to = placeOf(place.dir, one)
    if (!to) throw new Error(`${one.name} would be saved outside ComfyUI’s models folder, so it was not downloaded.`)
    await mkdir(dirname(to), { recursive: true })
    const label = `${one.name} (${index + 1} of ${missing.length})`
    await download(one.url, to, {
      ...(one.bytes && { expect: one.bytes }),
      signal,
      onProgress: (done, total) =>
        onProgress(done, total, `Downloading ${label} — ${gb(done)}${total > 0 ? ` of ${gb(total)}` : ''}`),
    })
  }

  // The start that loads the packs that just arrived, and sees the models in their folders.
  if (records.length > 0 || missing.length > 0) await place.release?.()
  const saved = await save(found.doc, name, place, { signal, classes })
  return {
    name,
    ...saved,
    models: found.models.map((one) => ({ ...one, have: !one.manual })),
    packs: [...found.packs.filter((one) => one.have), ...records.map((one) => ({ ...one, have: true }))],
    records,
    personal: false,
    lines: needsLines({ models: found.models.filter((one) => one.manual) }),
  }
}

/**
 * Both halves of the workflow into ComfyUI's workflows folder: the file the editor opens, and the
 * API export `/prompt` runs, converted against the nodes this ComfyUI has now.
 *
 * A file the converter cannot prove is saved as the editor's file alone and said so — the person
 * can open it in ComfyUI and export it themselves — rather than guessed at.
 */
async function save(doc, name, place, { signal, classes }) {
  const server = await place.server(signal)
  const known = classes ? await classes(server, signal).catch(() => ({})) : {}
  // A community file can already be an API export, and then it is the one half there is.
  if (isApi(doc)) {
    await write(server, `${FOLDER}/${name}${API_SUFFIX}`, JSON.stringify(doc), signal)
    return { saved: undefined, export: `${FOLDER}/${name}${API_SUFFIX}` }
  }
  await write(server, `${FOLDER}/${name}.json`, JSON.stringify(doc), signal)
  const got = convert(doc, known)
  if (!got.ok) return { saved: `${FOLDER}/${name}.json`, export: undefined, why: got.why?.[0] }
  await write(server, `${FOLDER}/${name}${API_SUFFIX}`, JSON.stringify(got.graph), signal)
  return { saved: `${FOLDER}/${name}.json`, export: `${FOLDER}/${name}${API_SUFFIX}` }
}
