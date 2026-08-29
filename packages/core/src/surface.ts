// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forget } from './learned.js'
import type { Row } from './plugins.js'
import { Plugins } from './plugins.js'
import type { Skills } from './skills.js'
import type { PluginTooling } from './tooling.js'
import { asText, type Trace } from './trace.js'

/**
 * What core's own tables are made of (M6-4).
 *
 * Three panels, one widget. If any of them had needed a line of bespoke rendering in the
 * shell, `table` would have been the wrong widget and this is where that would have shown
 * up — which is why they were one task and not three. They did not, so this file is what a
 * core tab is: four functions returning rows, and one that acts on one.
 *
 * **Read-only unless this screen is the only owner.** Two of these say so out loud. The
 * plugins screen owns installing and removing a plugin, and `tooling.ts` reads the plugins
 * rather than the other way round — a second write path from here would be a parallel
 * mechanism, which is the rule the old dashboard got right on the first try and kept.
 *
 * Nothing in this file names a plugin. It reads whatever is installed and groups by whatever
 * that turns out to be called.
 */

export interface Source {
  rows(): Promise<Row[]>
  /** What expands under one row. Text, and it is read rather than computed. */
  detail?(id: string): Promise<string>
}

export interface SurfaceOptions {
  skills: Skills
  tooling: PluginTooling
  plugins: Plugins
  /** Where the user's own skills live. A learned skill is a folder in it. */
  skillsDir: string
  /** The last five runs (M6-5). In memory, so this is the only place they exist. */
  trace: Trace
  /** Alexia's own data directory. An exported run is written into it. */
  dataDir: string
}

/** `▲` is the one mark that is coloured, because on this screen a colour means look at this. */
const OK = '● ready'

/** `2026-08-29 14:03`, which is what a person reads. Never a raw timestamp. */
const when = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

export function sources(options: SurfaceOptions): Record<string, Source> {
  const { skills, tooling, plugins, trace } = options

  /**
   * A skill's own text, which is the only thing there is to show about one.
   *
   * Read through `Skills.read`, the same path the model takes, so what a person sees on this
   * screen is what the model was given — frontmatter stripped, folder boundary enforced. A
   * second reader here would be a second answer to *what does this skill say*.
   */
  const skillText = (name: string): Promise<string> => {
    const read = skills.read({ name })
    return Promise.resolve(read.text)
  }

  return {
    activity: {
      rows: () =>
        Promise.resolve(
          trace.runs.map((run) => ({
            id: run.id,
            // Their own words, cut rather than summarised — a paraphrase of what somebody
            // asked for is the one thing that makes a run hard to find again.
            task: run.task.length > 90 ? `${run.task.slice(0, 90)}…` : run.task,
            steps: run.steps.length,
            ended: run.ended ?? 'still going',
            when: when(run.at),
          })),
        ),
      // The whole run, untrimmed, and the same text `export` writes. One renderer, so what
      // somebody reads on screen is exactly what they send on.
      detail: (id) => {
        const run = trace.one(id)
        return Promise.resolve(run === undefined ? 'That run has gone. They are kept in memory only.' : asText(run))
      },
    },

    skills: {
      rows: () =>
        Promise.resolve([
          // The broken ones first and marked, because *this folder is here and is doing
          // nothing* is the sentence somebody opened this screen to find.
          ...skills.problems.map((problem) => ({
            id: problem.dir,
            name: problem.dir.split(/[\\/]/).pop() ?? problem.dir,
            where: 'a folder',
            state: `▲ ${problem.reason}`,
          })),
          ...skills.all
            .filter((skill) => skill.learned !== true)
            .map((skill) => ({
              id: skill.name,
              name: skill.name,
              // A bundled skill says whose it is, which is also why it has no separate
              // delete: it arrived with something and it goes when that does.
              where: skill.pluginId === undefined ? 'installed here' : `with ${skill.pluginId}`,
              state: OK,
            })),
        ]),
      detail: skillText,
    },

    learned: {
      rows: () =>
        Promise.resolve(
          skills.all
            .filter((skill) => skill.learned === true)
            .map((skill) => ({
              id: skill.name,
              name: skill.name,
              // Absent is shown as absent. A skill written before this was recorded cannot
              // have it recovered, and guessing at it would be worse than the blank.
              from: skill.learnedFrom ?? 'not recorded',
              when: skill.learnedAt ?? '—',
            })),
        ),
      detail: skillText,
    },

    tools: {
      rows: async () =>
        Promise.all(
          (await tooling.list()).map(async (tool) => {
            // `plugin__tool`, which is how a tool reaches the model. Split back apart here so
            // the grouping is by whoever offers it — core never wrote any of these names down.
            const [owner, ...rest] = tool.name.split('__')
            const bare = rest.join('__')
            const declared = (await tooling.about(tool.name))?.annotations
            return {
              id: tool.name,
              name: bare === '' ? tool.name : bare,
              plugin: bare === '' ? 'Alexia' : owner!,
              // **What the permission gate will do with it**, which is the only thing on this
              // screen worth a column. Read from the same annotations `rule()` reads, and
              // silence is reported as silence — a tool that declared nothing has not said it
              // is safe, and the gate treats it accordingly.
              kind:
                declared?.destructiveHint === true ? 'changes things'
                : declared?.readOnlyHint === true ? 'reads only'
                : 'not declared',
            }
          }),
        ),
      detail: async (id) => {
        const found = (await tooling.list()).find((tool) => tool.name === id)
        // The description is prompt text: it is what the model reads when it decides to
        // reach for this, so it is shown verbatim rather than summarised.
        return found?.description ?? 'That tool is not offered any more.'
      },
    },

    library: {
      rows: () =>
        Promise.resolve([
          ...plugins.problems.map((problem) => ({
            id: problem.dir,
            name: problem.dir.split(/[\\/]/).pop() ?? problem.dir,
            version: '—',
            state: `▲ ${problem.reason}`,
          })),
          ...plugins.ids.flatMap((id) => {
            const manifest = plugins.manifest(id)
            if (!manifest) return []
            return [
              {
                id,
                name: manifest.name,
                version: manifest.version,
                state:
                  !plugins.enabled(id) ? '■ not enabled'
                  : plugins.running(id) ? OK
                  : '● enabled',
              },
            ]
          }),
        ]),
      detail: (id) => {
        const manifest = plugins.manifest(id)
        if (!manifest) return Promise.resolve('That plugin is not installed any more.')
        // The author's own sentences, verbatim. This is what a person reads when deciding
        // whether to keep something, so core never rewrites it and never summarises it.
        const asked = (manifest.requires ?? []).map((one) => `- ${one.cap} — ${one.why}`)
        return Promise.resolve(
          [manifest.summary, '', `${manifest.version} · ${manifest.license}`, ...(asked.length > 0 ? ['', 'It asked for:', ...asked] : [])].join(
            '\n',
          ),
        )
      },
    },
  }
}

/**
 * A row action on one of core's own tables.
 *
 * There is exactly one, and that is the finding rather than an omission — see D87. Forgetting
 * a skill is the reason a person opens this screen: *it learned something wrong a week ago*.
 * Editing one stayed where M4-5 put it, beside the attribution line at the moment it fires,
 * because an editor is bespoke rendering and bespoke rendering is what M6-4 was watching for.
 */
export function actions(
  options: SurfaceOptions,
): Record<string, (id: string) => Promise<{ ok: boolean; said: string }>> {
  return {
    /**
     * One run, written where a person can attach it to something (M6-5).
     *
     * A file rather than the clipboard, because the sentence this exists for is *send it to
     * somebody* — and because a page cannot hand a viewer a file without the shell's help,
     * while core writing one is three lines. The path is the answer.
     */
    export_run: (id) => {
      const run = options.trace.one(id)
      if (!run) return Promise.resolve({ ok: false, said: 'That run has gone. They are kept in memory only.' })
      const dir = join(options.dataDir, 'exports')
      const path = join(dir, `run-${new Date(run.at).toISOString().replace(/[:.]/g, '-')}.md`)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, asText(run))
        return Promise.resolve({ ok: true, said: `Written to ${path}` })
      } catch (error) {
        return Promise.resolve({ ok: false, said: `Could not write it: ${error instanceof Error ? error.message : String(error)}` })
      }
    },

    forget_skill: (name) => {
      const skill = options.skills.all.find((one) => one.name === name)
      if (skill?.pluginId !== undefined) {
        return Promise.resolve({
          ok: false,
          said: `${name} came with ${skill.pluginId}. It goes when that does — delete the plugin, or disable it.`,
        })
      }
      const gone = forget(options.skillsDir, name)
      options.skills.invalidate()
      return Promise.resolve(
        gone ?
          { ok: true, said: `Forgotten. ${name} is gone.` }
        : { ok: false, said: `There is no skill called ${name}.` },
      )
    },
  }
}
