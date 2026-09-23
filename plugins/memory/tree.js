// SPDX-License-Identifier: AGPL-3.0-only
import { valid, when } from './garden.js'

/**
 * Where a note lives: a tree, so a model looking for one thing climbs down to it instead of
 * reading everything.
 *
 * The owner's picture, drawn as data: a root, *You*; a handful of sections under it (people,
 * studies, projects…); topic bubbles under those (*Niki*, *Rust*, *the thesis*); and the notes
 * hanging off the bubbles. A new note — *Vacen likes his girlfriend Niki* — is put under the
 * *Niki* bubble that is already there by a free model that has been shown the tree, and never
 * the notes: branch names and one-sentence summaries are a few hundred words however many
 * notes there are, which is what keeps placing cheap as memory grows.
 *
 * **What the research says, and what this took from it.**
 * - MemTree (ICLR 2025) inserts by routing from the root, and keeps a short summary on every
 *   branch of what is below it. Taken whole — but in one call per *run* rather than three per
 *   note, because a plugin on its own clock only reaches free models and a batch of thirty is
 *   one prompt, not ninety.
 * - MemTree also found that walking down layer by layer retrieves *worse* than searching every
 *   node at once. So `recall` still ranks every note, and the tree is only how the hits are
 *   *shown*: grouped under their branch with its summary, so a reader sees where each one sits.
 *   Walking down is a separate, optional tool (`browse`) for a model that wants one area.
 * - A-MEM lets a note belong in more than one place. Here that is `also`: one primary branch,
 *   and a short list of others it is linked from (*Niki* under People, also under Hobbies/Anime).
 *
 * **Code overrules the model here too.** A placement names a path; the path must exist, or be
 * exactly one new bubble under a branch that does. Anything else falls back to something code
 * can decide on its own (`placement`, `fallback`), so a model that wanders off can only ever
 * file a note in a slightly worse place — never invent a tree nobody can read.
 *
 * Pure functions only — the storage around them is in index.js — like `garden.js`, `capture.js`
 * and `profile.js`, so every rule here can be argued with without a database in the room.
 */

/** The root's name. A person can rename it; nothing below depends on it being this word. */
export const ROOT = 'You'

/**
 * The sections a new memory starts with. The owner's list: enough that the first placements
 * have somewhere obvious to go, few enough that choosing between them is not itself a puzzle.
 */
export const SECTIONS = [
  'Identity & how to talk to me',
  'People',
  'Studies',
  'Projects & code',
  'Hobbies',
  'Preferences',
  'Goals & plans',
  'History',
]

/** How many unplaced notes one run places at most. The rest are the next run's. */
export const PLACE_MOST = 30

/**
 * How deep a branch may be, counted below the root. Sections are 1, bubbles 2, and two more
 * levels for the cases that need them (*Projects & code / Alexia / plugins / memory*). Deeper
 * than that and a path is a filing system, not something a model can hold in its head.
 */
export const DEPTH = 4

/** How many sections the root may have. More than a dozen and the top level stops sorting anything. */
export const WIDTH = 12

/** A branch name is a label, not a sentence: at most this many words, and this many characters. */
export const WORDS = 4
const LETTERS = 40

/** A summary is one sentence, at most this long. It is what the placer and `recall` read. */
export const SUMMARY = 160

/** How many notes of a branch the summariser sees, and how much of each. */
export const SUMMARY_NOTES = 8
const NOTE_CHARS = 160

/** How many branches one summary call covers at most. What is left stays marked for the next run. */
export const SUMMARY_MOST = 24

/** Compared without case, accents or extra spaces: "people", "People" and " PEOPLE " are one branch. */
const key = (name) =>
  String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The tree, from the `branches` rows.
 *
 * Forgiving of what storage hands back, because a wrong tree is still a tree somebody can fix
 * and a crash is not: the first parentless row is the root; any other row whose parent is
 * missing, is itself, or loops back is read as a child of the root.
 */
export function build(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.rowid) - Number(b.rowid))
  const nodes = new Map()
  for (const row of sorted) {
    nodes.set(Number(row.rowid), {
      id: Number(row.rowid),
      parent: when(row.parent),
      name: String(row.name ?? '').trim(),
      summary: String(row.summary ?? '').trim(),
      seed: row.seed === true || Number(row.seed) === 1,
    })
  }
  const root = [...nodes.values()].find((node) => node.parent === null)?.id ?? null
  for (const node of nodes.values()) {
    if (node.id === root) continue
    if (node.parent === null || !nodes.has(node.parent) || loops(nodes, node.id)) node.parent = root
  }
  return index({ root, nodes })
}

/** Does walking up from `id` come back to it before reaching the root? */
function loops(nodes, id) {
  const seen = new Set([id])
  let at = nodes.get(id)?.parent
  while (at !== null && at !== undefined) {
    if (seen.has(at)) return true
    seen.add(at)
    at = nodes.get(at)?.parent
  }
  return false
}

/** The children lists, rebuilt from the parents. Oldest first, which is the seed's order. */
function index(tree) {
  const children = new Map([...tree.nodes.keys()].map((id) => [id, []]))
  for (const node of tree.nodes.values()) if (node.parent !== null) children.get(node.parent)?.push(node.id)
  return { ...tree, children }
}

/** A copy the planner can grow without touching the one it was handed. */
const clone = (tree) => index({ root: tree.root, nodes: new Map([...tree.nodes].map(([id, node]) => [id, { ...node }])) })

/** Root first, then down. */
export function lineage(tree, id) {
  const up = []
  let at = id
  while (at !== null && at !== undefined && tree.nodes.has(at) && !up.includes(at)) {
    up.unshift(at)
    at = tree.nodes.get(at).parent
  }
  return up
}

/** `You/People/Niki`. */
export const pathOf = (tree, id) => lineage(tree, id).map((one) => tree.nodes.get(one).name).join('/')

/** The root is 0, a section 1. */
export const depthOf = (tree, id) => lineage(tree, id).length - 1

/** How many levels there are below `id`: 0 for a leaf. */
export function height(tree, id) {
  const below = tree.children.get(id) ?? []
  return below.length === 0 ? 0 : 1 + Math.max(...below.map((one) => height(tree, one)))
}

/** Every branch below `id`, not counting it. */
export function below(tree, id) {
  const out = []
  for (const one of tree.children.get(id) ?? []) out.push(one, ...below(tree, one))
  return out
}

/** Every branch, root first and each followed by what is under it. */
export const ordered = (tree) => (tree.root === null ? [] : [tree.root, ...below(tree, tree.root)])

/** The child of `parent` called `name`, if there is one. */
export const childNamed = (tree, parent, name) =>
  (tree.children.get(parent) ?? []).find((id) => key(tree.nodes.get(id).name) === key(name))

/**
 * A path as the names in it, the root's own name left off. `You/People/Niki`, `People/Niki`
 * and `people / niki` are one path: a small model will write any of them.
 */
export function segments(tree, path) {
  const parts = String(path ?? '')
    .split('/')
    .map((one) => one.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter((one) => one !== '')
  const root = tree.nodes.get(tree.root)
  if (parts.length > 0 && root && (key(parts[0]) === key(root.name) || key(parts[0]) === key(ROOT))) parts.shift()
  return parts
}

/** As far down `path` as the tree goes: the deepest branch reached, and the names left over. */
export function walk(tree, path) {
  const parts = segments(tree, path)
  let at = tree.root
  let i = 0
  for (; i < parts.length; i += 1) {
    const next = childNamed(tree, at, parts[i])
    if (next === undefined) break
    at = next
  }
  return { id: at, rest: parts.slice(i) }
}

/** The branch at exactly `path`, or `undefined`. */
export function find(tree, path) {
  if (tree.root === null) return undefined
  const { id, rest } = walk(tree, path)
  return rest.length === 0 ? id : undefined
}

/**
 * A name worth being a branch: a label of one to four words and forty characters, with a letter
 * in it and no slash — a slash would read as two levels the next time the path is parsed.
 */
export function nameOk(name) {
  const text = String(name ?? '').trim()
  if (text === '' || text.length > LETTERS || text.includes('/')) return false
  if (!/\p{L}/u.test(text)) return false
  return text.split(/\s+/).length <= WORDS
}

/**
 * Where a proposed path puts a note, or `null` when code has to decide instead (`fallback`).
 *
 * - A path that exists is that branch.
 * - A path that is **one** new name under an existing branch is that new bubble — if the name is
 *   a label (`nameOk`), the bubble would be no deeper than `DEPTH`, and, when it would be a new
 *   section, the root has fewer than `WIDTH` of them.
 * - Anything else — over a limit, two new levels at once, a name that is a sentence — goes to
 *   the nearest branch on that path that does exist. The model was right about the area and
 *   wrong about the detail, and the area is worth keeping.
 * - Unless that nearest branch is the root itself: *somewhere under You* says nothing, so that
 *   is `null`, and the note is filed by its kind instead.
 *
 * Returns `{ branch }` for an existing branch, or `{ branch, create }` for a new child of it.
 */
export function placement(tree, path) {
  if (tree.root === null) return null
  const { id, rest } = walk(tree, path)
  if (rest.length === 0) return id === tree.root ? null : { branch: id }
  if (rest.length === 1 && nameOk(rest[0]) && depthOf(tree, id) + 1 <= DEPTH) {
    const full = id === tree.root && (tree.children.get(id) ?? []).length >= WIDTH
    if (!full) return { branch: id, create: rest[0] }
  }
  return id === tree.root ? null : { branch: id }
}

/**
 * Where a *person* said to put something, or why not.
 *
 * The same rules as `placement`, without its forgiveness: a person who typed a path meant that
 * path, so a path that does not fit is refused with the reason rather than quietly filed one
 * level up. The root is allowed here — a person may well want a note under *You* itself.
 *
 * Returns `{ branch }`, `{ branch, create }`, or `{ error }`.
 */
export function destination(tree, path) {
  if (tree.root === null) return { error: 'There is no tree yet.' }
  const { id, rest } = walk(tree, path)
  if (rest.length === 0) return { branch: id }
  if (rest.length > 1) return { error: `There is no branch ${pathOf(tree, id)}/${rest[0]}; make one level at a time.` }
  if (!nameOk(rest[0])) return { error: `"${rest[0]}" is not a branch name: at most ${WORDS} words and ${LETTERS} characters, no slash.` }
  if (depthOf(tree, id) + 1 > DEPTH) return { error: `That would be deeper than ${DEPTH} levels below ${tree.nodes.get(tree.root).name}.` }
  if (id === tree.root && (tree.children.get(id) ?? []).length >= WIDTH) return { error: `There are already ${WIDTH} sections; put it inside one of them.` }
  return { branch: id, create: rest[0] }
}

/**
 * Where a note goes when the model could not say, by what kind of note it is.
 *
 * | kind       | section                        | why                                               |
 * |------------|--------------------------------|---------------------------------------------------|
 * | person     | People                         | it is about somebody                              |
 * | preference | Preferences                    | it is what they like                              |
 * | task       | Goals & plans                  | it is something to do                             |
 * | place      | Identity & how to talk to me   | where they live is part of who they are           |
 * | fact       | Identity & how to talk to me   | a bare fact about a person is mostly about them   |
 * | other      | You (the root)                 | honest: filed nowhere in particular, still found  |
 *
 * The root is also where anything goes when its section has been renamed or merged away, so a
 * person reshaping the tree never makes a note unplaceable.
 */
export const HOMES = {
  person: 'People',
  preference: 'Preferences',
  task: 'Goals & plans',
  place: 'Identity & how to talk to me',
  fact: 'Identity & how to talk to me',
}

export function fallback(tree, kind) {
  const name = HOMES[String(kind ?? '')]
  return (name === undefined ? undefined : childNamed(tree, tree.root, name)) ?? tree.root
}

/** A note's primary branch, if it still exists; otherwise the root, which is where unfiled notes show. */
export function homeOf(tree, note) {
  const branch = when(note?.branch)
  return branch !== null && tree.nodes.has(branch) ? branch : tree.root
}

/** A note's other branches, as numbers. Stored as a JSON array; anything unreadable is none. */
export function alsoOf(note) {
  try {
    const held = JSON.parse(String(note?.also ?? '[]'))
    return Array.isArray(held) ? [...new Set(held.map(Number).filter(Number.isInteger))] : []
  } catch {
    return []
  }
}

/** Every branch a note is filed in: its home first, then the others that still exist. */
export const homesOf = (tree, note) => {
  const home = homeOf(tree, note)
  return [home, ...alsoOf(note).filter((id) => id !== home && tree.nodes.has(id))]
}

/**
 * The tree as the placer sees it: one line per branch, its path and its summary. Never the notes
 * — that is the point of summaries, and what keeps this prompt the same size at five hundred
 * notes as at five.
 */
export function outline(tree) {
  return ordered(tree)
    .map((id) => {
      const summary = tree.nodes.get(id).summary
      return summary === '' ? pathOf(tree, id) : `${pathOf(tree, id)} — ${summary}`
    })
    .join('\n')
}

/**
 * The placer's prompt. Closed, like the sorting prompt: it says exactly what to answer, and
 * that the answer is checked — a small model given room to write prose writes prose.
 */
export function placePrompt(tree, notes) {
  return [
    'Below is how the notes about a person are filed, as a tree of branches, and some new notes',
    'that are not filed yet. Say where each new note belongs.',
    '',
    'Prefer a branch that already exists. If a note is about a specific person, project, subject',
    'or hobby that has no branch yet, you may add ONE new branch for it under an existing one,',
    `named in at most ${WORDS} words — for example You/People/Niki for a note about Niki.`,
    'A note may also be linked from up to three other branches where it clearly belongs too.',
    '',
    'Answer with JSON and nothing else: an array with one object per note, with these fields.',
    '  id    the note\'s id, exactly as given',
    '  path  the branch it belongs under, written from the root, e.g. "You/Hobbies/Anime"',
    '  also  other branches it belongs under too, as paths. [] if none.',
    '',
    'Branches:',
    outline(tree),
    '',
    'New notes:',
    ...notes.map((note) => `- id ${String(note.rowid)}: ${String(note.text ?? '').slice(0, 300)}`),
  ].join('\n')
}

/**
 * A JSON array somewhere in a model's answer, or `null` when there is none. Tolerant of the
 * wrapper — a sentence around it, a fenced block — and of nothing else.
 */
export function parseArray(said) {
  const text = String(said ?? '')
  const from = text.indexOf('[')
  const to = text.lastIndexOf(']')
  if (from === -1 || to <= from) return null
  try {
    const raw = JSON.parse(text.slice(from, to + 1))
    return Array.isArray(raw) ? raw.filter((one) => one !== null && typeof one === 'object') : null
  } catch {
    return null
  }
}

/** How many `also` links a note may have at most. A note filed everywhere is filed nowhere. */
export const ALSO_MOST = 3

/**
 * What to write for a batch of unplaced notes, given the model's answer (or `null` for none).
 *
 * Every item is checked: an id that is not one of these notes is ignored (the model can only
 * place what it was shown); a path goes through `placement`; a note the answer leaves out or
 * gets wrong is filed by its kind. New branches are planned on a copy of the tree with negative
 * ids, in order, so two notes about Niki in one batch share one new *Niki* rather than making
 * two — and `create` lists them parents first, which is the order they can be written in.
 *
 * `also` paths must name a branch that exists (or was just planned); a second new bubble is
 * not made for a link, and the root and the note's own branch are not links.
 *
 * Returns `{ create: [{ id, parent, name }], place: [{ id, branch, also, by }] }`, where `by`
 * is `'model'` or `'kind'` so the caller can say how many the model managed.
 */
export function plan(tree, notes, answer) {
  const work = clone(tree)
  const create = []
  let next = -1
  const make = (parent, name) => {
    const existing = childNamed(work, parent, name)
    if (existing !== undefined) return existing
    const id = next
    next -= 1
    work.nodes.set(id, { id, parent, name, summary: '', seed: false })
    work.children.set(id, [])
    work.children.get(parent).push(id)
    create.push({ id, parent, name })
    return id
  }
  const said = new Map()
  for (const item of answer ?? []) {
    const id = Number(item?.id)
    if (!Number.isInteger(id) || said.has(id)) continue
    said.set(id, item)
  }
  const place = []
  for (const note of notes.slice(0, PLACE_MOST)) {
    const id = Number(note.rowid)
    const item = said.get(id)
    const where = item && typeof item.path === 'string' ? placement(work, item.path) : null
    if (where === null) {
      place.push({ id, branch: fallback(work, note.kind), also: [], by: 'kind' })
      continue
    }
    const branch = where.create === undefined ? where.branch : make(where.branch, where.create)
    const also = []
    for (const path of Array.isArray(item.also) ? item.also : []) {
      if (typeof path !== 'string') continue
      const other = find(work, path)
      if (other === undefined || other === work.root || other === branch || also.includes(other)) continue
      also.push(other)
      if (also.length >= ALSO_MOST) break
    }
    place.push({ id, branch, also, by: 'model' })
  }
  return { create, place }
}

/**
 * How many notes are filed at or below each branch, each note counted once per branch however
 * many of its homes are under it. Only valid notes: a branch whose notes all stopped being true
 * reads 0, which is how the panel shows it as empty.
 */
export function counts(tree, notes) {
  const out = new Map([...tree.nodes.keys()].map((id) => [id, 0]))
  for (const note of notes) {
    if (!valid(note)) continue
    const reached = new Set(homesOf(tree, note).flatMap((id) => lineage(tree, id)))
    for (const id of reached) out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** The branches whose summaries a change to `ids` makes stale: those, and everything above them. */
export function touched(tree, ids) {
  const out = new Set()
  for (const id of ids) for (const one of lineage(tree, Number(id))) out.add(one)
  return out
}

/**
 * The summariser's prompt: for each branch, what is directly under it — its child branches by
 * name and current summary, and up to `SUMMARY_NOTES` of its own notes, newest first. Deepest
 * branches first, so a model reading top to bottom has seen the parts before the whole.
 *
 * One call for all of them. A parent is summarised from its children's summaries *as they were
 * before this run*; the next run catches that up, which is cheaper than a call per level.
 */
export function summaryPrompt(tree, ids, notes) {
  const deepest = [...ids].sort((a, b) => depthOf(tree, b) - depthOf(tree, a) || a - b)
  const blocks = deepest.map((id) => {
    const kids = (tree.children.get(id) ?? []).map((one) => {
      const node = tree.nodes.get(one)
      return `  branch ${node.name}${node.summary === '' ? '' : `: ${node.summary}`}`
    })
    const own = notes
      .filter((note) => valid(note) && homesOf(tree, note).includes(id))
      .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
      .slice(0, SUMMARY_NOTES)
      .map((note) => `  note: ${String(note.text ?? '').slice(0, NOTE_CHARS)}`)
    return [`${pathOf(tree, id)}`, ...kids, ...own].join('\n')
  })
  return [
    'Below are branches of a tree of notes about a person, each with what is directly under it.',
    `For each branch, write ONE sentence of at most ${SUMMARY} characters saying what is under it,`,
    'so somebody can tell from the sentence alone whether to look inside. Say only what the',
    'notes and branches say. Write in the language most of the notes are in.',
    '',
    'Answer with JSON and nothing else: an array of objects with these fields.',
    '  path     the branch, exactly as given',
    '  summary  the sentence',
    '',
    ...blocks.flatMap((block) => [block, '']),
  ].join('\n')
}

/**
 * A summary worth keeping, or `null` to keep the old one: one line, one sentence, not empty,
 * at most `SUMMARY` characters. A model that wrote a paragraph did not write a summary, and
 * cutting it would write half a sentence into every prompt that reads the tree.
 */
export function summaryOk(said) {
  const text = String(said ?? '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim()
  if (text === '' || text.length > SUMMARY || /\n/.test(text)) return null
  // A second sentence: a full stop, question or exclamation mark followed by a capital.
  if (/[.!?]\s+\p{Lu}/u.test(text)) return null
  return text
}

/** The model's summaries for `ids`, checked. A branch the answer missed or got wrong is left out. */
export function readSummaries(tree, ids, answer) {
  const wanted = new Set(ids)
  const out = new Map()
  for (const item of answer ?? []) {
    if (typeof item?.path !== 'string') continue
    const id = find(tree, item.path)
    if (id === undefined || !wanted.has(id) || out.has(id)) continue
    const text = summaryOk(item.summary)
    if (text !== null) out.set(id, text)
  }
  return out
}

/**
 * Recall's hits, grouped under the branch each is filed in, in the order the ranking first
 * reached each branch — so the best hit's branch still comes first, and the ranking itself is
 * untouched. A note is shown once, under its home.
 */
export function group(tree, rows) {
  const groups = new Map()
  for (const row of rows) {
    const id = homeOf(tree, row)
    if (!groups.has(id)) {
      const node = tree.nodes.get(id)
      groups.set(id, { id, path: id === null ? ROOT : pathOf(tree, id), summary: node?.summary ?? '', rows: [] })
    }
    groups.get(id).rows.push(row)
  }
  return [...groups.values()]
}

/** `You/People/Niki — summary`, or just the path when there is no summary yet. */
export const header = (path, summary) => (summary === '' ? path : `${path} — ${summary}`)

/**
 * What `browse` shows: the branch's own header, its child branches with their note counts and
 * summaries, then the notes filed right here, one line each. With no path, the root.
 *
 * `null` for a path that is not in the tree — the caller says so, and lists the sections.
 */
export function browse(tree, notes, path, line = (note) => `- ${String(note.text)}`) {
  if (tree.root === null) return null
  const id = path === undefined || String(path).trim() === '' ? tree.root : find(tree, path)
  if (id === undefined) return null
  const count = counts(tree, notes)
  const node = tree.nodes.get(id)
  const kids = (tree.children.get(id) ?? []).map((one) => {
    const kid = tree.nodes.get(one)
    const n = count.get(one) ?? 0
    return `- ${kid.name} (${n === 0 ? 'empty' : `${n} note${n === 1 ? '' : 's'}`})${kid.summary === '' ? '' : ` — ${kid.summary}`}`
  })
  const here = notes
    .filter((note) => valid(note) && homesOf(tree, note).includes(id))
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    .map((note) => `${line(note)}${homeOf(tree, note) === id ? '' : ' (also filed here)'}`)
  return [
    header(pathOf(tree, id), node.summary),
    ...(kids.length === 0 ? [] : ['', 'Branches:', ...kids]),
    ...(here.length === 0 ? [] : ['', 'Notes:', ...here]),
    ...(kids.length === 0 && here.length === 0 ? ['', 'Nothing is filed here.'] : []),
  ].join('\n')
}

/**
 * The branches a forget leaves with nothing in them, to be removed with it.
 *
 * *Forget Niki* that leaves a branch called *Niki* standing has not forgotten Niki. So a branch
 * that is not part of the seed, has no child branches, and has no note at all filed in it —
 * valid or closed — goes, and then its parent is asked the same question. Closing a note is not
 * forgetting it, so a branch whose notes are all *no longer true* stays (and reads as empty).
 */
export function bare(tree, notes) {
  const filed = new Set(notes.flatMap((note) => homesOf(tree, note)))
  const gone = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const node of tree.nodes.values()) {
      if (gone.has(node.id) || node.seed || node.id === tree.root || filed.has(node.id)) continue
      if ((tree.children.get(node.id) ?? []).some((one) => !gone.has(one))) continue
      gone.add(node.id)
      changed = true
    }
  }
  return [...gone]
}

/**
 * The whole tree as the panel's nodes (`memory_tree`): every branch, then every note under its
 * home. Ids are `b<rowid>` for branches and the plain rowid for notes, so the existing row
 * actions keep working on notes. `tags` is the caller's, so the words match the list's chips.
 */
export function nodes(tree, notes, tagsOf) {
  const count = counts(tree, notes)
  const bid = (id) => `b${id}`
  const out = ordered(tree).map((id) => {
    const node = tree.nodes.get(id)
    return {
      id: bid(id),
      parent: node.parent === null ? null : bid(node.parent),
      kind: 'branch',
      label: node.name,
      ...(node.summary === '' ? {} : { summary: node.summary }),
      count: count.get(id) ?? 0,
    }
  })
  for (const note of notes) {
    const home = homeOf(tree, note)
    if (home === null) continue
    const also = homesOf(tree, note).slice(1).map(bid)
    out.push({
      id: String(note.rowid),
      parent: bid(home),
      kind: 'note',
      label: String(note.text ?? ''),
      tags: tagsOf(note),
      ...(also.length === 0 ? {} : { also }),
    })
  }
  return out
}
