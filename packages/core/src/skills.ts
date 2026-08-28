// SPDX-License-Identifier: AGPL-3.0-only
import matter from 'gray-matter'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolOutcome } from './agent.js'
import type { Annotations } from './permissions.js'
import type { Problem } from './plugins.js'
import type { ToolSpec } from './provider.js'

/**
 * Know-how, as opposed to capability (M2-2, `docs/spec/skills.md`).
 *
 * A plugin gives Alexia a new thing it can *do*; a skill teaches it to do something it
 * could already do, well. A skill is a folder with a Markdown file in it — no process, no
 * code, nothing that can fail at install time — and the format is
 * [agentskills.io](https://agentskills.io)'s, unchanged, so the marketplace starts
 * non-empty and a skill written here works elsewhere.
 *
 * **Progressive disclosure is the whole reason this format was worth adopting**, and it is
 * the one thing this file is really implementing:
 *
 * | Level | Where it lives | Costs |
 * |---|---|---|
 * | `name` + `description` | the `skill` tool's own description, always in context | ~100 tokens each |
 * | the body of `SKILL.md` | returned when the model calls `skill` | a few hundred up |
 * | anything else in the folder | returned when it calls `skill` with a `file` | nothing until asked |
 *
 * So a hundred installed skills cost a hundred sentences, not a hundred skills. That is
 * what makes an unbounded library practical rather than a context problem.
 *
 * **A broken skill is shown, never skipped.** A skill that is not firing and is not visibly
 * broken is the hardest thing in this system to debug, so every folder that fails to load
 * comes back as a `Problem` with the reason, exactly as a plugin folder does.
 */

/** Lowercase, hyphen-separated, and it must match the folder name — a plugin `id`'s rule. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NAME_MAX = 64
/** Long enough for *what* and *when*; short enough that a hundred of them still fit. */
const DESCRIPTION_MAX = 1024

/** What the model calls to open one. Collision-free: every plugin tool carries a `__` in it. */
export const SKILL_TOOL = 'skill'

export interface Skill {
  name: string
  /** The whole of a skill's discoverability: it has to say **what** and **when**. */
  description: string
  license?: string
  /** The folder. Everything the skill is, is inside it. */
  dir: string
  /** The plugin it came with. Bundled skills are deleted with it and never installed alone. */
  pluginId?: string
  /**
   * Alexia wrote this one, from a task somebody watched happen (M4-5).
   *
   * It matters downstream because a learned skill **can be wrong**: it is attributed the
   * moment it fires, with *edit* and *forget* beside it, and neither of those is offered
   * for a skill a person deliberately installed.
   */
  learned?: boolean
}

export interface SkillsOptions {
  /** The user's own skills directory. Every folder in it is a skill; no folder is not an error. */
  dir: string
  /** Skill folders declared by installed plugins, already resolved against the plugin folder. */
  bundled?(): { dir: string; pluginId: string }[]
}

export class Skills {
  #scanned?: { skills: Skill[]; problems: Problem[] }

  constructor(private readonly options: SkillsOptions) {}

  /**
   * A plugin arrived or went away, so the bundled half of the list is stale.
   *
   * Re-read rather than patched, and never cached across a restart: `name` and
   * `description` are the whole index, there is no registry row and no database entry
   * holding a copy, so there is nothing that can fall out of step with the folders.
   *
   * ponytail: the user's own skills directory is not watched, so a folder dropped into it
   * by hand is seen at the next restart or the next time a plugin changes. The marketplace
   * (M3-5) installs through code that can call this, which is when it starts to matter.
   */
  invalidate(): void {
    this.#scanned = undefined
  }

  get all(): readonly Skill[] {
    return this.#read().skills
  }

  /** Folders holding something that is not a loadable skill, and the sentence saying why. */
  get problems(): readonly Problem[] {
    return this.#read().problems
  }

  /**
   * The index, as the model sees it — and it is a *tool description* rather than a system
   * line, because that is where a model looks when it is deciding what to reach for.
   *
   * Nothing installed means no tool at all. A tool that lists nothing is a tool the model
   * calls once to find out it was pointless.
   */
  get tool(): ToolSpec | undefined {
    const skills = this.all
    if (skills.length === 0) return undefined
    return {
      name: SKILL_TOOL,
      description: [
        'Instructions for doing one particular thing well. If one of these fits what you are' +
          ' about to do, read it first and follow what it says. Pass `file` to open a file the' +
          ' skill’s own text tells you to read.',
        '',
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Which skill to read.' },
          file: {
            type: 'string',
            description: 'A file inside that skill’s folder, named as its text named it. Omit for the skill itself.',
          },
        },
        required: ['name'],
      },
    }
  }

  /** Whether Alexia wrote this one itself. What the attribution line is drawn from. */
  isLearned(name: string): boolean {
    return this.all.find((skill) => skill.name === name)?.learned === true
  }

  /** Text on disk, and reading it changes nothing. The permission gate has to be told so. */
  get annotations(): Annotations {
    return { readOnlyHint: true, destructiveHint: false }
  }

  /**
   * Level 2 and level 3: the body, or one file the body pointed at.
   *
   * Nothing here throws. A skill deleted between the model reading the index and calling
   * this is an observation like any other tool failure — the loop's next move is to plan
   * around the sentence that comes back.
   */
  read(args: Record<string, unknown>): ToolOutcome {
    const skills = this.all
    const wanted = typeof args.name === 'string' ? args.name : ''
    const skill = skills.find((s) => s.name === wanted)
    if (!skill) {
      const names = skills.map((s) => s.name)
      return {
        ok: false,
        text:
          names.length > 0 ?
            `There is no skill called ${wanted || '(nothing)'}. What there is: ${names.join(', ')}.`
          : `There is no skill called ${wanted || '(nothing)'}, and none are installed.`,
      }
    }

    const file = typeof args.file === 'string' && args.file !== '' ? args.file : undefined
    const path = file === undefined ? join(skill.dir, 'SKILL.md') : resolve(skill.dir, file)
    // A skill is text somebody downloaded from a marketplace and `file` is a string a model
    // chose. Neither is a reason to read outside the folder.
    const inside = relative(skill.dir, path)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return { ok: false, text: `${file ?? ''} is outside ${skill.name}, so it was not read.` }
    }

    try {
      const raw = readFileSync(path, 'utf8')
      // The frontmatter is core's index; the model has already read it in this tool's own
      // description and does not need it a second time at its own expense.
      return { ok: true, text: file === undefined ? matter(raw).content.trim() : raw }
    } catch (error) {
      return { ok: false, text: `${skill.name} has no readable ${file ?? 'SKILL.md'}: ${String(error)}` }
    }
  }

  /** One pass over every source, memoised until something changes under it. */
  #read(): { skills: Skill[]; problems: Problem[] } {
    this.#scanned ??= this.#load()
    return this.#scanned
  }

  #load(): { skills: Skill[]; problems: Problem[] } {
    const skills: Skill[] = []
    const problems: Problem[] = []
    // Bundled first: a skill that arrived with a capability is the one that capability needs,
    // so a standalone folder of the same name is the one asked to rename itself.
    const sources: { dir: string; pluginId?: string }[] = [
      ...(this.options.bundled?.() ?? []),
      ...standalone(this.options.dir),
    ]

    for (const source of sources) {
      const found = parse(source.dir)
      if ('reason' in found) {
        problems.push(found)
        continue
      }
      const clash = skills.find((s) => s.name === found.name)
      if (clash) {
        // Two skills answering to one name means the model cannot ask for either by name,
        // and the one it silently gets is whichever was scanned first. Say so instead.
        problems.push({
          dir: source.dir,
          reason: `another skill, in ${clash.dir}, is already called “${found.name}”`,
        })
        continue
      }
      skills.push({ ...found, ...(source.pluginId !== undefined && { pluginId: source.pluginId }) })
    }
    return { skills, problems }
  }
}

/** Every folder in the user's own skills directory. Not having one is the ordinary start. */
function standalone(dir: string): { dir: string }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ dir: join(dir, entry.name) }))
  } catch {
    return []
  }
}

/**
 * One folder, held to the same rules `skills-ref validate` applies upstream — so a skill
 * that passes there passes here, and one that fails says the same thing about why.
 */
function parse(dir: string): Omit<Skill, 'pluginId'> | Problem {
  const folder = basename(dir)
  let raw: string
  try {
    raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return { dir, reason: `${folder} has no readable SKILL.md` }
  }

  // Byte 0, and the spec means it: a blank line or a byte-order mark before the delimiter is
  // a file most parsers read as having no frontmatter at all, which would make the skill
  // silently descriptionless rather than visibly broken.
  if (!raw.startsWith('---')) {
    return { dir, reason: `${folder}'s frontmatter has to start at the very first byte of SKILL.md` }
  }

  let data: Record<string, unknown>
  try {
    data = matter(raw).data
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { dir, reason: `${folder}'s frontmatter did not parse: ${why}` }
  }

  const name = data.name
  if (typeof name !== 'string' || name === '') return { dir, reason: `${folder} declares no name` }
  if (name.length > NAME_MAX || !NAME.test(name)) {
    return {
      dir,
      reason: `${folder} calls itself “${name}”, which is not lowercase, hyphen-separated and under ${NAME_MAX} characters`,
    }
  }
  // The same rule as a plugin's `id`, in the same words. One rule, learned once.
  if (name !== folder) return { dir, reason: `${folder}'s SKILL.md calls it “${name}”` }

  const description = data.description
  if (typeof description !== 'string' || description.trim() === '') {
    // Without one the model never opens it, and a skill that never fires looks exactly like
    // a skill that was never installed.
    return { dir, reason: `${folder} declares no description, so nothing would ever read it` }
  }
  if (description.length > DESCRIPTION_MAX) {
    return {
      dir,
      reason: `${folder}'s description is ${description.length} characters, and the limit is ${DESCRIPTION_MAX}`,
    }
  }

  // Everything else — `compatibility`, `metadata`, `allowed-tools`, whatever another runtime
  // left there — is ignored on purpose. That is the spec's own rule and it is what keeps a
  // skill portable. `allowed-tools` in particular: what a step may touch is decided by the
  // permission mode, the folder scope and the never-touch list, and a field in a text file
  // somebody downloaded is not joining that list.
  // `metadata` is one of the fields the spec says to ignore, and mostly this does. The one
  // key read out of it is Alexia's own mark on a skill it wrote — it rides in `metadata`
  // rather than at the top level precisely so that a skill carrying it stays portable and
  // means nothing anywhere else.
  const metadata = data.metadata
  const learned =
    typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>).learned === true

  return {
    dir,
    name,
    // Folded YAML arrives with the line breaks still in it, and this sentence is going into
    // a tool description one line per skill.
    description: description.trim().replace(/\s+/g, ' '),
    ...(typeof data.license === 'string' && { license: data.license }),
    ...(learned && { learned: true }),
  }
}
