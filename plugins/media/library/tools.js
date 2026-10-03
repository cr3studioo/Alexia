// SPDX-License-Identifier: AGPL-3.0-only
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fromJsonSchema } from '@alexia/sdk'
import { flatten, pickEntry, runnable } from '../catalog.js'
import { stats, templates } from '../comfy.js'
import { facts, note } from '../compute.js'
import { vram } from '../tier.js'
import { pair, saved as listSaved } from '../workflows.js'
import { catalogueOnDisk, installWorkflow, needs, needsLines, savedAs } from './setup.js'
import { fetchFound, loadSources, parseFound, searchAll } from './sources.js'
import { TASKS, curated, curatedOne, fits, task as taskNamed, tasksFor } from './tasks.js'

/**
 * The workflow library: grouped by task, installed with everything it needs, chosen by what
 * somebody asked for — on whichever computer renders.
 *
 * **Everything that is a fact about a ComfyUI is asked of the computer that has it.** Which
 * workflows are installed, which packs, what the card holds, whether ComfyUI is there at all and
 * whose it is: those answer differently on a paired PC than on the Mac somebody is sitting at,
 * and the library page on the Mac has to show the PC's. So they are one light operation,
 * `image.workflows`, run where the person chose exactly as a picture is — and here, in this
 * process, when nothing is paired.
 *
 * **And nothing installs on another computer from a conversation.** On this computer, pressing
 * Install on the library page is the press. For a paired computer the same press writes down
 * what is wanted and answers what it needs, with sizes; the install itself happens when somebody
 * presses Install beside it in that computer's setup list, which core turns into the `install`
 * hook — the only route by which anything is downloaded onto a computer nobody is sitting at.
 */

/** The operation's capability. One place, so the manifest and the code cannot drift. */
export const LIBRARY = 'image.workflows'

/** On the computer that renders: what each workflow installed brought in, by workflow id. */
export const RECORDS = 'library'
/** On the computer that renders: workflows somebody asked for, waiting for the setup list's Install. */
export const WANTED = 'wanted'
/** On the computer that renders: the last failed install of each workflow, said by pack. */
export const FAILED = 'library_failed'
/** On the planner: the last community search, for the library page to show. */
export const FOUND = 'found'

/** Requirement ids the setup list carries for a workflow. */
export const requirementOf = (id) => `workflow:${id}`

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const said = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured && { structuredContent: structured }) })

/** The fields of a catalogue entry worth sending between computers. Descriptions are cut short. */
const compact = (one) => ({
  name: one.name,
  title: one.title,
  description: one.description.slice(0, 280),
  category: one.category,
  tags: one.tags,
  models: one.models,
  ...(one.size && { size: one.size }),
  ...(one.vram && { vram: one.vram }),
  ...(one.paid && { paid: true }),
})

/** The workflows saved in an install's own user folder, read off the disk. */
async function savedOnDisk(dir) {
  if (!dir) return []
  const files = await readdir(join(dir, 'user', 'default', 'workflows'), { recursive: true }).catch(() => [])
  return pair(files.map((one) => ({ path: String(one).split(/[\\/]/).join('/') }))).map((row) => row.name)
}

/**
 * The library, wired to this plugin.
 *
 * `place({ here, signal, report })` is the one question this file cannot answer for itself:
 * which ComfyUI. It answers `{ dir, own, server(signal), running(signal), release(), card(signal) }`
 * — the install's folder, whether it is Alexia's own, how to have it running, whether it is
 * running now without starting it, how to let go of it so the next start loads what was just
 * installed, and the card when ComfyUI is not there to ask. `comfy()` answers the ComfyUI setup
 * requirement when there is none (`install.js`), and `classes` reads a ComfyUI's node classes.
 */
export function library({ alexia, compute, place, classes, comfy = async () => undefined, fromWeb, sources = loadSources, installer = installWorkflow, now = () => new Date().toISOString() }) {
  const storage = alexia.storage
  const read = async (key) => {
    const got = await storage.get(key).catch(() => undefined)
    return got !== null && typeof got === 'object' && !Array.isArray(got) ? got : {}
  }
  const keep = (key, value) => storage.set(key, value).catch(() => {})
  let community
  const reach = () => (community ??= sources())

  // ---------------------------------------------------------------- on the computer that renders

  /** What this computer's ComfyUI has, without starting it. */
  async function look({ here, signal }) {
    const at = await place({ here, signal })
    const server = await at.running(signal).catch(() => undefined)
    const requirement = at.dir || server ? undefined : await comfy()
    const index = server ? await templates(server, signal).catch(() => []) : await catalogueOnDisk(at.dir)
    const names =
      server ? (await listSaved(server, signal).catch(() => [])).map((row) => row.name)
      : await savedOnDisk(at.dir)
    const card = server ? vram(await stats(server, signal).catch(() => undefined)) : await at.card?.(signal).catch(() => undefined)
    return {
      comfy:
        requirement ? { state: 'missing', requirement }
        : at.own ? { state: 'own' }
        : at.dir ? { state: 'personal' }
        : { state: 'elsewhere' },
      card: card ?? null,
      saved: names,
      records: await read(RECORDS),
      wanted: Object.keys(await read(WANTED)),
      failed: await read(FAILED),
      catalogue: flatten(index).filter((one) => !one.paid).map(compact),
    }
  }

  /**
   * Install now, here, everything one workflow needs, and write down what it brought in.
   *
   * Called from a press on this computer's library page, and from the `install` hook on a
   * paired one. A failure is written down with the pack it named, so the setup list can say so.
   */
  async function installNow(want, { here, signal, report = () => {} }) {
    const at = await place({ here, signal, report })
    if (!at.dir && !(await at.running(signal).catch(() => undefined))) {
      const needed = await comfy()
      if (needed) throw new Error(`ComfyUI has to be installed first: ${needed.instructions ?? needed.detail ?? needed.title}`)
    }
    const failed = await read(FAILED)
    let got
    try {
      got = await installer(want, at, { signal, classes, onProgress: (done, total, message) => report(message, done, total) })
    } catch (error) {
      await keep(FAILED, { ...failed, [want.id]: { ...(error?.pack && { pack: error.pack }), said: String(error?.message ?? error), at: now() } })
      throw error
    }
    const records = await read(RECORDS)
    // A pack another workflow already brought in is that workflow's record, shown here too.
    const earlier = Object.values(records).flatMap((one) => one.packs ?? [])
    const packs = got.packs.map((one) => (one.at ? one : (earlier.find((old) => old.name === one.name) ?? { name: one.name, ...(one.url && { url: one.url }), already: true })))
    const record = {
      id: want.id,
      name: got.name,
      title: want.title ?? want.id,
      tasks: want.tasks ?? [],
      source: want.source ?? 'official',
      ...(want.url && { url: want.url }),
      ...(want.license && { license: want.license }),
      at: now(),
      saved: got.saved,
      export: got.export,
      ...(got.why && { why: got.why }),
      personal: got.personal,
      models: got.models.map(({ name, directory, bytes, have, manual }) => ({ name, directory, ...(bytes && { bytes }), have: Boolean(have), ...(manual && { manual }) })),
      packs: packs.map(({ name, url, version, commit, at: when, from, already, have }) => ({
        name,
        ...(url && { url }),
        ...(version && { version }),
        ...(commit && { commit }),
        ...(when && { at: when }),
        ...(from && { from }),
        ...(already && { already }),
        ...(got.personal && { have: Boolean(have) }),
      })),
      lines: got.lines,
    }
    await keep(RECORDS, { ...records, [want.id]: record })
    const wanted = await read(WANTED)
    delete wanted[want.id]
    await keep(WANTED, wanted)
    delete failed[want.id]
    await keep(FAILED, failed)
    return record
  }

  /**
   * Somebody on another computer asked for a workflow: write it down, and say what it needs.
   *
   * Nothing is installed and nothing is started — the sizes come from what the planner sent and
   * from the template on this disk, and where neither says, the list says *size not known*.
   */
  async function want(asked, { signal }) {
    const at = await place({ here: false, signal })
    const wanted = await read(WANTED)
    await keep(WANTED, { ...wanted, [asked.id]: { ...asked, asked: now() } })
    const found = at.dir ? await needs(asked, { ...at, server: async () => { throw new Error('not started for a list') } }, { signal }).catch(() => undefined) : undefined
    return {
      wanted: true,
      comfy: at.dir ? (at.own ? 'own' : 'personal') : 'missing',
      ...(!at.dir && { requirement: await comfy() }),
      lines: found?.lines ?? needsLines(asked),
      bytes: found?.bytes ?? asked.bytes,
    }
  }

  compute.operation(LIBRARY, async (plan, io) => {
    if (plan?.kind === 'look') return { text: note(await look(io)), files: [] }
    if (plan?.kind === 'install' && plan.want?.id) {
      // Another computer asked: this is a list, never an install. Here, it is the press.
      const done = io.here ? { installed: await installNow(plan.want, io) } : await want(plan.want, io)
      return { text: note(done), files: [] }
    }
    throw new Error('The library was asked for something it does not do.')
  })

  /** The setup list's lines for workflows somebody asked for and this computer does not have yet. */
  async function requirements() {
    const wanted = await read(WANTED)
    const done = await read(RECORDS)
    const failed = await read(FAILED)
    const waiting = Object.values(wanted).filter((one) => !done[one.id])
    if (waiting.length === 0) return []
    const at = await place({ here: false })
    return waiting.map((one) => {
      const lines = needsLines(one)
      const broke = failed[one.id]
      const detail = [
        at.dir && !at.own ?
          'Your own ComfyUI: Alexia saves the workflow file and adds nothing else to it.'
        : 'The workflow, its models and its node packs, installed into Alexia’s own ComfyUI.',
        lines.length > 0 ? `Needs ${lines.join('; ')}.` : undefined,
        broke ? `The last attempt failed${broke.pack ? ` on the node pack ${broke.pack}` : ''}: ${broke.said}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
      return {
        id: requirementOf(one.id),
        kind: 'dependency',
        title: `Workflow: ${one.title ?? one.id}`,
        detail,
        ...(Number.isSafeInteger(one.bytes) && one.bytes > 0 && { bytes: one.bytes }),
        ...(at.dir ?
          { action: 'install' }
        : { action: 'instructions', instructions: 'Install ComfyUI first — it is the line above. This workflow can be installed after it.' }),
        blocks: [],
      }
    })
  }

  /** The `install` hook's half for workflows. Answers false for a requirement that is not one. */
  async function install(requirementId, ctx) {
    const id = /^workflow:(.+)$/.exec(String(requirementId))?.[1]
    if (!id) return false
    const asked = (await read(WANTED))[id]
    if (!asked) throw new Error('Nobody asked for that workflow on this computer, or it is already installed.')
    await installNow(asked, {
      here: false,
      signal: ctx?.mcpReq?.signal,
      report: (message, done, total) => alexia.progress(ctx, done, total, message),
    })
    return true
  }

  // ---------------------------------------------------------------- on the planner

  /** The computer that renders, as the library sees it. */
  async function view(ctx) {
    const made = await compute.run(LIBRARY, { kind: 'look' }, { signal: ctx?.mcpReq?.signal })
    const got = facts(made.text)
    return {
      comfy: got.comfy ?? { state: 'missing' },
      card: got.card ?? null,
      saved: Array.isArray(got.saved) ? got.saved : [],
      records: got.records ?? {},
      wanted: Array.isArray(got.wanted) ? got.wanted : [],
      failed: got.failed ?? {},
      catalogue: Array.isArray(got.catalogue) ? got.catalogue : [],
    }
  }

  // Installed through the library (a record), saved as the library would save it, or already in ComfyUI under
  // exactly this name — a workflow the person saved by hand, whose name may hold `+` or brackets that
  // `savedAs` rewrites, so looking only for the rewritten name never finds it.
  const isInstalled = (seen, id) => Boolean(seen.records[id]) || seen.saved.includes(id) || seen.saved.includes(savedAs(id))

  /** The sentence about one workflow's fit, for the card that renders or, unread, an 8 GB one. */
  function fitLine(one, card) {
    const verdict = fits(one, card)
    if (verdict === true) return `fits this ${gb(card.total)} card`
    if (verdict === false) return `needs more than this ${gb(card.total)} card`
    if (one.fits8gb === true) return 'fits an 8 GB card'
    if (one.fits8gb === false) return 'too big for an 8 GB card'
    return 'fit not stated'
  }

  /** What a curated workflow needs, as the card's last line. */
  function metaOf(one, card) {
    const models = (one.models ?? []).length
    const packs = (one.packs ?? []).length
    const bytes = one.bytes ?? (one.models ?? []).reduce((sum, model) => sum + (model.bytes ?? 0), 0)
    return [
      bytes > 0 ? `${gb(bytes)} to download` : 'nothing to download',
      one.source === 'official' ? 'ComfyUI template' : `${packs} node pack${packs === 1 ? '' : 's'}`,
      ...(models > 0 && one.source !== 'official' ? [`${models} model${models === 1 ? '' : 's'}`] : []),
      one.vram > 0 ? `~${gb(one.vram)} VRAM` : undefined,
      fitLine(one, card),
    ]
      .filter(Boolean)
      .join(' · ')
  }

  /** The library page: by task, then what else ComfyUI ships, then what was found, then yours. */
  async function rows(seen) {
    const list = []
    if (seen.comfy.state === 'missing') {
      const needed = seen.comfy.requirement
      list.push({
        id: 'comfyui',
        name: 'ComfyUI',
        summary: needed?.action === 'install' ? `${needed.detail} Install it from the setup list first; every workflow here runs in it.` : (needed?.instructions ?? 'ComfyUI is not on the computer that renders.'),
        meta: needed?.bytes ? `${gb(needed.bytes)} to download` : 'needed first',
        state: 'needed',
        group: 'First: ComfyUI',
      })
    }
    const shown = new Set()
    for (const one of TASKS) {
      for (const workflow of one.workflows) {
        shown.add(workflow.id)
        list.push({
          id: workflow.id,
          name: workflow.title,
          summary: workflow.note,
          meta: metaOf(workflow, seen.card),
          state: isInstalled(seen, workflow.id) ? 'installed' : 'available',
          group: one.title,
        })
      }
    }
    const search = await read(FOUND)
    for (const one of search.entries ?? []) {
      list.push({
        id: one.id,
        name: one.title,
        summary: one.summary || `From ${one.sourceName}.`,
        meta: [one.sourceName, one.author && `by ${one.author}`, one.license].filter(Boolean).join(' · '),
        state: isInstalled(seen, one.id) ? 'installed' : 'available',
        group: `Found in community sources — “${search.query ?? ''}”`,
      })
    }
    const rest = runnable(seen.catalogue, { vram: seen.card?.total }).filter((one) => !shown.has(one.name))
    for (const one of rest) {
      list.push({
        id: one.name,
        name: one.title,
        summary: one.description || 'Its author left no description.',
        meta:
          [one.size ? `${gb(one.size)} to download` : undefined, one.vram ? `~${gb(one.vram)} VRAM` : 'VRAM not stated', one.models.join(', ') || undefined]
            .filter(Boolean)
            .join(' · '),
        state: isInstalled(seen, one.name) ? 'installed' : 'available',
        group: `More from ComfyUI — ${rest.length} more`,
      })
    }
    const known = new Set([...list.map((one) => savedAs(one.id)), ...seen.catalogue.map((one) => one.name)])
    for (const name of seen.saved.filter((one) => !known.has(one))) {
      list.push({ id: name, name, summary: 'Yours — added from a file or a link rather than the library.', meta: '', state: 'installed', group: 'Your own' })
    }
    return list
  }

  /** A community workflow's file: its pinned address when the list has one, else the sources. */
  async function communityFile(workflow, { signal }) {
    if (workflow.url) return { doc: await fromWeb(workflow.url, signal), url: workflow.url }
    const reached = await reach()
    const { found } = await searchAll(reached.sources, workflow.search ?? workflow.title, { signal, limit: 5 })
    if (found.length === 0) throw new Error(`No community source has a workflow for ${workflow.title} right now.`)
    const got = await fetchFound(reached, found[0].id, { signal })
    return { ...got, url: got.url || found[0].url, author: got.author || found[0].author }
  }

  /**
   * What somebody's words or a row's id name, as a request the computer that renders can act on.
   * Answers `{ want }`, `{ many }` or `{}`.
   */
  async function resolve(asked, seen, { signal }) {
    const said = String(asked ?? '').trim()
    const hit = curatedOne(said) ?? curated().find((one) => one.title.toLowerCase() === said.toLowerCase())
    if (hit && hit.source === 'official') {
      return { want: { id: hit.id, title: hit.title, source: 'official', tasks: hit.tasks, bytes: hit.bytes, vram: hit.vram, models: [], packs: [] } }
    }
    if (hit) {
      const got = await communityFile(hit, { signal })
      const models = [...(hit.models ?? []), ...(got.models ?? [])]
      return {
        want: {
          id: hit.id,
          title: hit.title,
          source: 'community',
          tasks: hit.tasks,
          vram: hit.vram,
          doc: got.doc,
          url: got.url,
          ...(got.license && { license: got.license }),
          models,
          packs: [...(hit.packs ?? []), ...(got.packs ?? [])],
          bytes: models.reduce((sum, one) => sum + (one.bytes ?? 0), 0),
        },
      }
    }
    if (parseFound(said)) {
      const entry = ((await read(FOUND)).entries ?? []).find((one) => one.id === said)
      const got = await fetchFound(await reach(), said, { signal })
      return {
        want: {
          id: said,
          name: (entry?.title ?? said).replace(/[^\w.\- ]+/g, '_').slice(0, 80),
          title: entry?.title ?? said,
          source: 'community',
          tasks: [],
          doc: got.doc,
          url: got.url || entry?.url,
          ...(got.license && { license: got.license }),
          models: got.models,
          packs: got.packs,
          bytes: got.models.reduce((sum, one) => sum + (one.bytes ?? 0), 0),
          ...(got.unresolved.length > 0 && { unresolved: got.unresolved }),
        },
      }
    }
    const { entry, many } = pickEntry(seen.catalogue.map((one) => ({ ...one, description: one.description ?? '' })), said)
    if (many) return { many }
    if (!entry) return {}
    return { want: { id: entry.name, title: entry.title, source: 'official', tasks: [], bytes: entry.size, vram: entry.vram, models: [], packs: [] } }
  }

  /** What a request needs, in a sentence somebody can agree to. */
  function costOf(asked) {
    const lines = needsLines({ models: asked.models ?? [], packs: asked.packs ?? [] })
    return [
      asked.bytes > 0 ? `${gb(asked.bytes)} to download` : asked.source === 'official' ? 'its models, as its template lists them' : 'nothing to download up front',
      lines.length > 0 ? `— ${lines.join('; ')}` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
  }

  const requirementSentence = (needed) =>
    needed?.action === 'install' ?
      `ComfyUI is not on the computer that renders yet. It comes first: ${needed.detail}${needed.bytes ? ` (${gb(needed.bytes)})` : ''} — press Install beside ComfyUI in that computer’s setup list.`
    : `ComfyUI is not on the computer that renders yet, and it comes first. ${needed?.instructions ?? ''}`.trim()

  // ---------------------------------------------------------------- tools

  alexia.tool(
    'library',
    {
      description:
        'List the workflows the computer that renders could install, grouped by task — background ' +
        'removal, upscaling, image edit, inpaint, face restore, style transfer, speech, voice cloning, ' +
        'image to video — with what each needs and whether it fits that graphics card. Takes no ' +
        'arguments. This is what the library page draws; pick_workflow is the better call in a conversation.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (ctx) => {
      let seen
      try {
        seen = await view(ctx)
      } catch (error) {
        return { content: [{ type: 'text', text: String(error?.message ?? error) }], structuredContent: { rows: [] } }
      }
      const list = await rows(seen)
      const installed = list.filter((one) => one.state === 'installed').length
      return said(
        `${installed} installed. ${seen.card ? `The computer that renders has ${gb(seen.card.total)} of video memory.` : 'Its graphics card has not been read yet.'}`,
        { rows: list },
      )
    },
  )

  alexia.tool(
    'about_workflow',
    {
      description:
        'Everything about one workflow in the library: what it does, what it needs, whether it fits, ' +
        'and — once installed — every node pack it brought in with its address, version and date. ' +
        'Takes its id, as the library lists it.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { id: { type: 'string', description: 'The workflow’s id, as the library lists it.' } },
        required: ['id'],
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }, ctx) => {
      const asked = String(id ?? '').trim()
      if (asked === 'comfyui') return said('ComfyUI is the program every workflow here runs in. It is installed from the setup list of the computer that renders.')
      let seen
      try {
        seen = await view(ctx)
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      const hit = curatedOne(asked)
      const entry = seen.catalogue.find((one) => one.name === asked)
      const found = ((await read(FOUND)).entries ?? []).find((one) => one.id === asked)
      const record = seen.records[asked]
      const broke = seen.failed[asked]
      if (!hit && !entry && !found && !record && !seen.saved.includes(asked)) return refuse(`Nothing in the library is called ${asked}.`)
      const lines = [
        hit ? `${hit.title}. For: ${hit.tasks.map((one) => taskNamed(one)?.title ?? one).join(', ')}.` : (entry?.title ?? found?.title ?? asked),
        hit?.note ?? entry?.description ?? found?.summary,
        hit ? `Needs: ${metaOf(hit, seen.card)}.` : entry ? `Needs: ${entry.size ? `${gb(entry.size)} to download` : 'what its template lists'}; models ${entry.models.join(', ') || 'none named'}.` : undefined,
        ...(hit && hit.source !== 'official' ? needsLines({ models: hit.models ?? [], packs: hit.packs ?? [] }).map((line) => `  • ${line}`) : []),
        found ? `From ${found.sourceName}${found.author ? `, by ${found.author}` : ''}${found.license ? `, ${found.license}` : ''}${found.url ? ` — ${found.url}` : ''}.` : undefined,
        record ? `Installed ${record.at.slice(0, 10)} as ${record.name}${record.export ? '' : ` — without an API export: ${record.why ?? 'it could not be converted'}`}.` : isInstalled(seen, asked) ? 'Installed.' : 'Not installed.',
        ...(record?.packs?.length > 0 ?
          [
            'Node packs:',
            ...record.packs.map(
              (one) =>
                `  • ${one.name}${one.version ? ` ${one.version}` : ''}${one.commit ? ` at commit ${one.commit}` : ''}${one.url ? ` — ${one.url}` : ''}${one.at ? `, installed ${one.at.slice(0, 10)}` : one.already ? ', already there' : ''}`,
            ),
          ]
        : []),
        ...(record?.lines?.length > 0 ? ['Still needed, to add yourself:', ...record.lines.map((line) => `  • ${line}`)] : []),
        broke ? `The last install failed${broke.pack ? ` on the node pack ${broke.pack}` : ''}: ${broke.said}` : undefined,
      ]
      return said(lines.filter(Boolean).join('\n'))
    },
  )

  alexia.tool(
    'install_workflow',
    {
      description:
        'Install a workflow from the library with everything it needs — its models, downloaded into ' +
        'ComfyUI’s model folders, and its custom node packs, installed into Alexia’s own ComfyUI — on the ' +
        'computer that renders. Use after pick_workflow, find_workflow or the library offered one and ' +
        'the user said yes to its size: pass confirmed: true only then. On a ComfyUI the user installed ' +
        'themselves nothing is added — the workflow is saved and what it still needs is listed. For a ' +
        'paired computer it is set up in that computer’s setup list, where the user presses Install.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Its id or title, as pick_workflow, find_workflow or the library showed it.' },
          id: { type: 'string', description: 'Its id, which the library page passes.' },
          confirmed: { type: 'boolean', description: 'The user agreed to the download size you told them. Without it, this only says what would be downloaded.' },
        },
      }),
      // It downloads gigabytes and installs other people's code into Alexia's own ComfyUI.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow, id, confirmed }, ctx) => {
      const signal = ctx?.mcpReq?.signal
      // A row on the library page is a press on a card that already showed the size.
      const pressed = workflow === undefined && id !== undefined
      const asked = String(workflow ?? id ?? '').trim()
      if (asked === '') return refuse('Which one? Use an id or title the library or pick_workflow showed.')
      let seen
      try {
        seen = await view(ctx)
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      if (seen.comfy.state === 'missing') return refuse(requirementSentence(seen.comfy.requirement))
      let found
      try {
        found = await resolve(asked, seen, { signal })
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      if (found.many) return refuse(`More than one workflow matches “${asked}”: ${found.many.join(', ')}. Which one?`)
      if (!found.want) return refuse(`Nothing in the library is called “${asked}”. library and find_workflow list what is there.`)
      const request = found.want
      if (!pressed && confirmed !== true) {
        return said(
          `${request.title} needs ${costOf(request)}. Nothing has been downloaded. Tell the user that, and call ` +
            'install_workflow again with confirmed: true once they agree.',
        )
      }
      let made
      try {
        made = await compute.run(
          LIBRARY,
          { kind: 'install', want: request },
          { signal, report: (message, done, total) => alexia.progress(ctx, done, total, message) },
        )
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      const got = facts(made.text)
      if (got.wanted) {
        return said(
          [
            got.comfy === 'missing' ? requirementSentence(got.requirement) : undefined,
            `${request.title} is ready to install on the computer you chose${got.bytes ? ` — ${gb(got.bytes)}` : ''}.`,
            got.lines?.length > 0 ? `It needs: ${got.lines.join('; ')}.` : undefined,
            got.comfy === 'personal' ? 'That computer’s ComfyUI is one the user installed, so only the workflow file is saved there and the rest is listed.' : undefined,
            `Press Install beside “Workflow: ${request.title}” in that computer’s setup list. Nothing is downloaded until then.`,
          ]
            .filter(Boolean)
            .join(' '),
        )
      }
      const record = got.installed ?? {}
      const packs = (record.packs ?? []).filter((one) => one.at)
      const models = (record.models ?? []).filter((one) => one.have)
      return said(
        [
          record.personal ?
            `Saved ${request.title} as ${record.name} in your ComfyUI. It is a ComfyUI you installed yourself, so Alexia added nothing to it.`
          : `Installed ${request.title} as ${record.name}.`,
          !record.personal && models.length > 0 ? `Models in place: ${models.map((one) => one.name).join(', ')}.` : undefined,
          packs.length > 0 ? `Node packs installed: ${packs.map((one) => `${one.name} ${one.version ?? (one.commit ?? '').slice(0, 12)}`.trim()).join(', ')} — each recorded with its address and version in the workflow’s details.` : undefined,
          record.lines?.length > 0 ? `Still needed: ${record.lines.join('; ')}.` : undefined,
          record.export ? 'run_workflow can use it now.' : `It has no API export yet (${record.why ?? 'it could not be converted'}) — open it in ComfyUI and use Workflow → Export (API), then add_workflow.`,
        ]
          .filter(Boolean)
          .join(' '),
      )
    },
  )

  alexia.tool(
    'pick_workflow',
    {
      description:
        'Choose the workflow for what the user asked — “remove the background of this photo”, “read this ' +
        'aloud in a calm voice”, “make this picture move”. Answers the installed workflow to run with ' +
        'run_workflow; when none is installed, which workflow would do it, what it needs and its size, so ' +
        'you can offer to install it. It installs nothing.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { asked: { type: 'string', description: 'What the user wants done, in their own words.' } },
        required: ['asked'],
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ asked }, ctx) => {
      const tasks = tasksFor(asked)
      if (tasks.length === 0) {
        return said(
          `None of the library’s tasks matches “${String(asked)}”. They are: ${TASKS.map((one) => one.title).join(', ')}. ` +
            'find_workflow searches everything ComfyUI ships, and search_community searches community sources.',
          { task: null },
        )
      }
      let seen
      try {
        seen = await view(ctx)
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      const chosen = tasks[0]
      const installed = [
        ...chosen.workflows.filter((one) => isInstalled(seen, one.id)).map((one) => ({ id: one.id, title: one.title, name: seen.records[one.id]?.name ?? savedAs(one.id), fits: fits(one, seen.card) })),
        // Something the person installed for this task that is not on the curated list.
        ...Object.values(seen.records)
          .filter((one) => one.tasks?.includes(chosen.id) && !chosen.workflows.some((known) => known.id === one.id))
          .map((one) => ({ id: one.id, title: one.title, name: one.name })),
      ]
      const ready = installed.filter((one) => seen.records[one.id]?.export !== undefined || seen.saved.includes(one.name))
      const best = ready.find((one) => one.fits !== false) ?? ready[0]
      if (best) {
        return said(
          `For “${String(asked)}” (${chosen.title}): ${best.title} is installed, saved as ${best.name}. Run it with run_workflow, ` +
            `workflow “${best.name}” — workflows lists the fields it takes${chosen.output === 'image' ? ', and a picture the user gave goes in images' : ''}.`,
          { task: chosen.id, workflow: best.name, installed: true },
        )
      }
      // Nothing installed: the best one for this card, and the rest as alternatives.
      const ordered = [...chosen.workflows].sort((a, b) => Number(fits(b, seen.card) ?? b.fits8gb) - Number(fits(a, seen.card) ?? a.fits8gb))
      const offer = ordered[0]
      const cost = offer.bytes ?? (offer.models ?? []).reduce((sum, one) => sum + (one.bytes ?? 0), 0)
      return said(
        [
          seen.comfy.state === 'missing' ? requirementSentence(seen.comfy.requirement) : undefined,
          `Nothing installed does ${chosen.title.toLowerCase()} yet. ${offer.title} would: ${cost > 0 ? `${gb(cost)} to download` : 'nothing to download'}` +
            `${offer.vram > 0 ? `, about ${gb(offer.vram)} of video memory` : ''}, ${fitLine(offer, seen.card)}.`,
          (offer.packs ?? []).length > 0 ? `It needs the node pack${offer.packs.length === 1 ? '' : 's'} ${offer.packs.map((one) => `${one.name} ${one.version ?? (one.commit ?? '').slice(0, 12)}`.trim()).join(', ')}, which Alexia installs with it.` : undefined,
          offer.note,
          ordered.length > 1 ? `Other ways: ${ordered.slice(1).map((one) => `${one.title} (${fitLine(one, seen.card)})`).join('; ')}.` : undefined,
          `Offer to install it; if the user agrees, call install_workflow with workflow “${offer.id}” and confirmed: true.`,
        ]
          .filter(Boolean)
          .join(' '),
        { task: chosen.id, installed: false, offer: offer.id, bytes: cost },
      )
    },
  )

  alexia.tool(
    'search_community',
    {
      description:
        'Search community workflow sources for something the library does not have. Takes the words to ' +
        'search for, or uses the search box on the library page. What is found appears on the library ' +
        'page, where each can be installed; nothing is installed by searching.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for. Omit to use the library page’s search box.' },
          task: { type: 'string', description: 'Optionally one of the library’s task ids, to narrow it.' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, task: narrowed } = {}, ctx) => {
      const asked = String(query ?? (await alexia.settings()).community_search ?? '').trim()
      if (asked === '') return refuse('Type what to look for in the search box first.')
      const reached = await reach()
      if (reached.sources.length === 0) return refuse('No community sources are available in this version of the plugin.')
      const { found, failed } = await searchAll(reached.sources, asked, { signal: ctx?.mcpReq?.signal, ...(narrowed && { task: String(narrowed) }) })
      await keep(FOUND, { query: asked, at: now(), entries: found })
      return said(
        [
          found.length === 0 ? `Nothing in the community sources matches “${asked}”.` : `${found.length} found for “${asked}”, on the library page now:`,
          ...found.slice(0, 8).map((one) => `  • ${one.title} — ${one.sourceName} (install_workflow with workflow “${one.id}”)`),
          failed.length > 0 ? `${failed.join(', ')} did not answer.` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        { found: found.map((one) => one.id) },
      )
    },
  )

  return { look, installNow, want, requirements, install, view, rows, resolve }
}
