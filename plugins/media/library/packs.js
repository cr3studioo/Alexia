// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Custom node packs: which ones a workflow needs, and putting them into Alexia's own ComfyUI.
 *
 * **This is the sharpest edge in the plugin, and it is cut on purpose.** A node pack is somebody
 * else's Python, run with no sandbox inside ComfyUI. §8.6 of the engine plan answered that with
 * a question per pack; the owner decided otherwise on 2026-10-03 — a workflow that needs a pack
 * gets it, without asking — and what is here is what makes that decision safe to live with:
 *
 * - **Only into Alexia's own ComfyUI.** The one `install.js` put in this plugin's folder. A
 *   ComfyUI somebody installed themselves is theirs, and for it this file only lists.
 * - **Only the pinned version.** A registry version or a commit, never *whatever is newest*; and
 *   what was installed is written down — name, address, version, date — and shown with the
 *   workflow that brought it in.
 * - **Only ComfyUI's own Python.** The portable build's `python_embeded`, and nothing else: the
 *   system's Python is somebody's, and a `pip install` into it changes programs that are not
 *   ComfyUI. No embedded Python means no pack, said by name.
 * - **All or nothing.** Every pack is unpacked beside the install and moved in only once its
 *   requirements went in; the Python packages are written down before and put back after a
 *   failure; a pack this run already moved in is taken out again. A failure names the pack and
 *   leaves ComfyUI as it was.
 *
 * Everything that runs a program or reaches the network is handed in (`run`, `fetch`), so a test
 * holds the whole of it with a fake git, a fake pip and a fake registry.
 */

/** ComfyUI's own nodes. Not a pack, never installed. */
const CORE = new Set(['comfy-core', 'comfyui', ''])

/** The Comfy registry, which serves a pack's published versions as archives. */
export const REGISTRY = 'https://api.comfy.org'

/** A folder name for a pack: what it is called, and nothing that could climb out of `custom_nodes`. */
export const folderOf = (name) => String(name ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'pack'

const github = (url) => {
  const found = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(String(url ?? ''))
  return found ? { owner: found[1], repo: found[2] } : undefined
}

/** Is this a commit hash rather than a version number? */
const isCommit = (said) => /^[0-9a-f]{7,40}$/i.test(String(said ?? ''))

/**
 * The packs an editor-format workflow names, from what ComfyUI itself writes into it.
 *
 * The editor stamps every node with where it came from: `cnr_id` for a pack in the Comfy registry
 * with `ver` its version, and `aux_id` — `owner/repo` on GitHub — with `ver` its commit, for one
 * that is not. Subgraphs are read too, because that is where catalogue templates keep their
 * nodes. A node with neither is one nobody can trace, and `missing` catches it later by class.
 */
export function packsOf(doc) {
  const nodes = [
    ...(Array.isArray(doc?.nodes) ? doc.nodes : []),
    ...(Array.isArray(doc?.definitions?.subgraphs) ? doc.definitions.subgraphs.flatMap((one) => one?.nodes ?? []) : []),
  ]
  const found = new Map()
  for (const node of nodes) {
    const props = node?.properties ?? {}
    const registry = String(props.cnr_id ?? '').trim()
    const aux = String(props.aux_id ?? '').trim()
    const ver = String(props.ver ?? '').trim()
    if (registry && !CORE.has(registry.toLowerCase())) {
      const known = found.get(registry) ?? { name: registry, registry, nodes: [] }
      if (ver && !known.version && !known.commit) Object.assign(known, isCommit(ver) ? { commit: ver } : { version: ver })
      if (node?.type) known.nodes.push(String(node.type))
      found.set(registry, known)
    } else if (aux && /^[^/\s]+\/[^/\s]+$/.test(aux)) {
      const name = aux.split('/')[1]
      const known = found.get(name) ?? { name, url: `https://github.com/${aux}`, nodes: [] }
      if (isCommit(ver) && !known.commit) known.commit = ver
      if (node?.type) known.nodes.push(String(node.type))
      found.set(name, known)
    }
  }
  return [...found.values()].map((one) => ({ ...one, nodes: [...new Set(one.nodes)] }))
}

/**
 * Two lists of the same packs, merged: what a curated entry pinned wins over what a file said,
 * because the curated pin is the one somebody checked.
 */
export function mergePacks(...lists) {
  const found = new Map()
  for (const list of lists) {
    for (const one of list ?? []) {
      const key = String(one.registry ?? one.name).toLowerCase()
      const known = found.get(key)
      found.set(key, known ? { ...one, ...known, nodes: [...new Set([...(known.nodes ?? []), ...(one.nodes ?? [])])] } : { ...one })
    }
  }
  return [...found.values()]
}

/**
 * Which of these packs this ComfyUI already has.
 *
 * A pack is here when its folder is in `custom_nodes`, or when every node it is known for is
 * one this ComfyUI answers for — the second is how a pack somebody installed under another
 * folder name is recognised, rather than being installed twice.
 */
export async function present(packs, { dir, classes } = {}) {
  const there = new Set(
    dir ? (await readdir(join(dir, 'custom_nodes'), { withFileTypes: true }).catch(() => [])).filter((one) => one.isDirectory()).map((one) => one.name.toLowerCase()) : [],
  )
  return packs.map((one) => ({
    ...one,
    have:
      there.has(folderOf(one.name).toLowerCase()) ||
      (classes && (one.nodes ?? []).length > 0 && one.nodes.every((node) => Object.hasOwn(classes, node))),
  }))
}

/**
 * ComfyUI's own Python, or nothing.
 *
 * The portable build keeps it one folder above ComfyUI, spelled `python_embeded` in the release,
 * missing letter and all. **There is deliberately no fallback** — see the top of this file.
 */
export async function embedded(dir, { platform = process.platform } = {}) {
  const base = dirname(dir)
  const candidates =
    platform === 'win32' ?
      [join(base, 'python_embeded', 'python.exe'), join(base, 'python_embedded', 'python.exe')]
    : [join(base, 'python_embeded', 'bin', 'python3'), join(base, 'python_embeded', 'bin', 'python')]
  for (const one of candidates) {
    if (await stat(one).then((it) => it.isFile(), () => false)) return one
  }
  return undefined
}

/**
 * Run one program and collect what it said. Never through a shell: every argument is an
 * argument, so a pack name with a space or a quote in it is a name and not a command.
 */
export function runner({ timeoutMs = 20 * 60_000 } = {}) {
  return (command, args, { cwd, signal, env } = {}) =>
    new Promise((done) => {
      let out = ''
      let err = ''
      let child
      try {
        child = spawn(command, args, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env },
          ...(signal && { signal }),
          timeout: timeoutMs,
        })
      } catch (error) {
        done({ code: -1, stdout: '', stderr: String(error?.message ?? error), missing: true })
        return
      }
      child.stdout.on('data', (chunk) => (out = (out + String(chunk)).slice(-200_000)))
      child.stderr.on('data', (chunk) => (err = (err + String(chunk)).slice(-20_000)))
      child.on('error', (error) => done({ code: -1, stdout: out, stderr: String(error?.message ?? error), missing: error?.code === 'ENOENT' }))
      child.on('close', (code) => done({ code: code ?? -1, stdout: out, stderr: err }))
    })
}

/** The last line a failing program said, which is nearly always the reason. */
const last = (said) =>
  String(said?.stderr || said?.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0] ?? `it exited with ${said?.code}`

/** `pip freeze` as a map of lowercase name → the line that pins it. */
async function freeze(python, run, signal) {
  const said = await run(python, ['-s', '-m', 'pip', 'freeze', '--all'], { signal })
  if (said.code !== 0) throw new Error(`ComfyUI’s Python could not list its packages: ${last(said)}`)
  const found = new Map()
  for (const line of String(said.stdout).split(/\r?\n/)) {
    const name = /^([A-Za-z0-9._-]+)\s*(==|@)/.exec(line.trim())?.[1]
    if (name) found.set(name.toLowerCase().replace(/_/g, '-'), line.trim())
  }
  return found
}

/**
 * Put ComfyUI's Python back the way `before` found it.
 *
 * Whatever is new is uninstalled and whatever moved is installed again at its old pin. Best
 * effort, and said as such if it fails: a rollback that throws over a rollback would hide the
 * failure somebody needs to read, which is the pack's.
 */
async function restore(python, before, run) {
  try {
    const after = await freeze(python, run)
    const added = [...after.keys()].filter((name) => !before.has(name))
    const moved = [...before.entries()].filter(([name, line]) => after.has(name) && after.get(name) !== line).map(([, line]) => line)
    if (added.length > 0) await run(python, ['-s', '-m', 'pip', 'uninstall', '-y', ...added], {})
    if (moved.length > 0) await run(python, ['-s', '-m', 'pip', 'install', '--no-deps', ...moved], {})
    return true
  } catch {
    return false
  }
}

/** A file fetched to disk, whole or not at all. */
async function save(url, to, { fetch, signal }) {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${new URL(url).host} answered ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${to}.part`), { signal })
  await rename(`${to}.part`, to)
  return to
}

/** If an archive unpacked into one folder, that folder; otherwise the place it was unpacked. */
async function inner(at) {
  const entries = (await readdir(at, { withFileTypes: true })).filter((one) => !one.name.startsWith('.'))
  return entries.length === 1 && entries[0].isDirectory() ? join(at, entries[0].name) : at
}

/**
 * Fetch one pack's pinned source into `into`, and say what was pinned.
 *
 * A registry version comes as the archive the registry publishes. A commit comes from git when
 * git is on this machine, and otherwise as GitHub's own archive of that commit — Windows PCs
 * mostly have no git, and *install git first* is not a sentence anybody should get for this.
 * A pack with neither a version nor a commit is pinned here, at install, to what its default
 * branch points at, and that commit is what is recorded.
 */
async function source(pack, into, { run, fetch, signal, scratch }) {
  if (pack.registry && (pack.version || !pack.url)) {
    // A resolver may already have read the archive's address off the registry; otherwise it is asked.
    let said = pack.archive ? { downloadUrl: pack.archive, version: pack.version } : {}
    if (!said.downloadUrl) {
      const asked = `${REGISTRY}/nodes/${encodeURIComponent(pack.registry)}/install${pack.version ? `?version=${encodeURIComponent(pack.version)}` : ''}`
      const response = await fetch(asked, { signal })
      said = response.ok ? await response.json().catch(() => ({})) : {}
    }
    if (said?.downloadUrl) {
      const zip = await save(said.downloadUrl, join(scratch, `${folderOf(pack.name)}.zip`), { fetch, signal })
      const open = `${into}-open`
      await mkdir(open, { recursive: true })
      // `tar` reads zip on Windows 10 and later and on every Mac — libarchive — so nothing new
      // is needed to open what the registry publishes. The registry's archives hold the pack's
      // files at the top; one that holds a single folder instead is moved up a level.
      const opened = await run('tar', ['-xf', zip, '-C', open], { signal })
      if (opened.code !== 0) throw new Error(`its archive could not be opened: ${last(opened)}`)
      await rename(await inner(open), into)
      return { version: String(said.version ?? pack.version ?? ''), url: pack.url ?? said.repository ?? `${REGISTRY}/nodes/${pack.registry}`, from: 'registry' }
    }
    if (!pack.url) throw new Error(pack.version ? `the Comfy registry has no version ${pack.version} of it` : 'the Comfy registry has no version of it')
  }
  if (!pack.url) throw new Error('nothing says where it comes from')
  const git = await run('git', ['clone', '--recurse-submodules', pack.url, into], { signal })
  if (git.code === 0) {
    if (pack.commit) {
      const moved = await run('git', ['-C', into, 'checkout', pack.commit], { signal })
      if (moved.code !== 0) throw new Error(`commit ${pack.commit} could not be checked out: ${last(moved)}`)
      await run('git', ['-C', into, 'submodule', 'update', '--init', '--recursive'], { signal })
    }
    const head = await run('git', ['-C', into, 'rev-parse', 'HEAD'], { signal })
    return { commit: String(head.stdout).trim() || pack.commit, url: pack.url, from: 'git' }
  }
  const where = github(pack.url)
  if (!git.missing || !where) throw new Error(`it could not be cloned: ${last(git)}`)
  await rm(into, { recursive: true, force: true })
  let commit = pack.commit
  if (!commit) {
    const head = await fetch(`https://api.github.com/repos/${where.owner}/${where.repo}/commits/HEAD`, { signal, headers: { accept: 'application/vnd.github+json' } })
    commit = head.ok ? String((await head.json().catch(() => ({})))?.sha ?? '') : ''
    if (!commit) throw new Error(`GitHub did not say which commit it is at (${head.status})`)
  }
  const zip = await save(`https://codeload.github.com/${where.owner}/${where.repo}/zip/${commit}`, join(scratch, `${folderOf(pack.name)}.zip`), { fetch, signal })
  const opened = join(scratch, `${folderOf(pack.name)}-open`)
  await mkdir(opened, { recursive: true })
  const unpacked = await run('tar', ['-xf', zip, '-C', opened], { signal })
  if (unpacked.code !== 0) throw new Error(`its archive could not be opened: ${last(unpacked)}`)
  await rename(await inner(opened), into)
  return { commit, url: pack.url, from: 'github' }
}

/**
 * Install every pack in `packs` into the ComfyUI at `dir`, or none of them.
 *
 * Answers the records — `{ name, url, version?, commit?, at, from }` — of the packs that went
 * in. Throws an `Error` whose `pack` is the name of the one that failed, after putting back
 * everything this call changed.
 */
export async function installPacks(packs, { dir, run = runner(), fetch = globalThis.fetch, signal, onProgress, now = () => new Date().toISOString(), platform } = {}) {
  if (packs.length === 0) return []
  const custom = join(dir, 'custom_nodes')
  const scratch = join(dirname(dir), '.alexia-packs', randomUUID())
  await mkdir(custom, { recursive: true })
  await mkdir(scratch, { recursive: true })
  const python = await embedded(dir, { platform })
  const moved = []
  const records = []
  let before
  try {
    for (const [index, pack] of packs.entries()) {
      try {
        const name = folderOf(pack.name)
        const target = resolve(custom, name)
        if (!target.startsWith(resolve(custom) + sep)) throw new Error('its name is not a folder name')
        onProgress?.(index, packs.length, `Installing the node pack ${pack.name}`)
        const staged = join(scratch, name)
        const pinned = await source(pack, staged, { run, fetch, signal, scratch })
        const wants = (await readdir(staged).catch(() => [])).map((one) => one.toLowerCase())
        if (wants.includes('requirements.txt') || wants.includes('install.py')) {
          if (!python) throw new Error('this ComfyUI has no Python of its own to install its requirements with, and Alexia never uses the system’s')
          before ??= await freeze(python, run, signal)
        }
        if (wants.includes('requirements.txt')) {
          const pip = await run(python, ['-s', '-m', 'pip', 'install', '-r', join(staged, 'requirements.txt')], { cwd: staged, signal })
          if (pip.code !== 0) throw new Error(`its requirements could not be installed: ${last(pip)}`)
        }
        // ComfyUI-Manager's own convention, which several packs depend on to fetch what their
        // requirements cannot express. It is the pack's code either way — ComfyUI runs its
        // `__init__` on the next start — so running this one earlier changes nothing about trust.
        if (wants.includes('install.py')) {
          const setup = await run(python, ['-s', 'install.py'], { cwd: staged, signal })
          if (setup.code !== 0) throw new Error(`its install.py failed: ${last(setup)}`)
        }
        await rm(target, { recursive: true, force: true })
        await rename(staged, target)
        moved.push(target)
        records.push({
          name: pack.name,
          url: pinned.url,
          ...(pinned.version && { version: pinned.version }),
          ...(pinned.commit && { commit: pinned.commit }),
          from: pinned.from,
          at: now(),
        })
      } catch (error) {
        const failed = new Error(`The node pack ${pack.name} could not be installed: ${String(error?.message ?? error)}.`, { cause: error })
        failed.pack = pack.name
        throw failed
      }
    }
    onProgress?.(packs.length, packs.length, 'Node packs installed')
    return records
  } catch (error) {
    // Everything this call did, undone in the order it was done.
    for (const one of moved) await rm(one, { recursive: true, force: true }).catch(() => {})
    const put = before && python ? await restore(python, before, run) : true
    if (!put) error.message += ' Its Python packages could not all be put back; the log of ComfyUI’s next start will say which.'
    else error.message += ' ComfyUI was left as it was.'
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    // The folder that holds scratch spaces goes too once nothing else is using it.
    await rmdir(dirname(scratch)).catch(() => {})
  }
}
