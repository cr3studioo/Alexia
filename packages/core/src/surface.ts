// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog } from './catalog.js'
import { pins, setPin } from './commands.js'
import { route, type World } from './router.js'
import { allow, forgetConsent } from './consent.js'
import { forget } from './learned.js'
import type { Row } from './plugins.js'
import { Plugins } from './plugins.js'
import type { Skills } from './skills.js'
import type { Searchable } from './palette.js'
import type { Store } from './store.js'
import type { PluginTooling } from './tooling.js'
import { asText, spentOn, type Trace } from './trace.js'

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
  /** Where the consent ladder is kept (M6-9). */
  store: Store
  tooling: PluginTooling
  plugins: Plugins
  /** Where the user's own skills live. A learned skill is a folder in it. */
  skillsDir: string
  /** The last five runs (M6-5). In memory, so this is the only place they exist. */
  trace: Trace
  /** Alexia's own data directory. An exported run is written into it. */
  dataDir: string
  /** What models exist, cached from each provider's own list (M6-4, Models tab). */
  catalog: Catalog
  /**
   * The providers holding a key, as a set rather than a question per provider.
   *
   * One call, because the answer lives in the OS keychain and the alternative is one
   * unlock per row on a table with several hundred of them.
   */
  connected(): Promise<ReadonlySet<string>>
  /**
   * What the router can see right now — the same gathering the chat uses.
   *
   * Here so *recommended* can be the router's own answer rather than a second opinion about
   * models kept beside it. A screen that recommended something the thing would not itself
   * choose would be two routers, and the one nobody can see would win every time.
   */
  world(): Promise<World>
  /**
   * Ask every provider for its list again, if what is cached has aged out.
   *
   * Called when the Models table is opened, which is what makes the figures on it live
   * rather than as old as the last restart. It is safe to call on every draw because
   * `Catalog.refresh` declines anything younger than a day per provider — so this is a
   * cheap no-op almost always, and a fetch exactly when somebody is looking at stale
   * numbers. Nothing waits for it: the rows being returned are the cached ones, and the
   * fetch lands in time for the next open.
   */
  refresh(): void
}

/** `▲` is the one mark that is coloured, because on this screen a colour means look at this. */
const OK = '● ready'

/** `2026-08-29 14:03`, which is what a person reads. Never a raw timestamp. */
const when = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

/** `128k`, which is what a person reads. Never 131072, and never a bare 0 for *not said*. */
const window = (tokens: number): string => (tokens > 0 ? `${String(Math.round(tokens / 1000))}k` : '—')

/** The same, for a running total: `1.2M` once thousands stop meaning anything. */
const count = (n: number): string =>
  n === 0 ? '—'
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
  : String(n)

/**
 * Dollars per million input tokens, or the word for what free means here.
 *
 * Zero is printed as *free* rather than `$0.00` because those are different claims: one is a
 * price and the other is the free tier this whole project is built on. A provider that does
 * not publish prices at all lands here as zero too — which is true of every free tier in the
 * table, and the column would rather say so than invent a number.
 */
const price = (usd: number): string => (usd === 0 ? 'free' : `$${usd.toFixed(2)}`)

export function sources(options: SurfaceOptions): Record<string, Source> {
  const { skills, tooling, plugins, trace, catalog, store } = options

  /**
   * A skill's own text, which is the only thing there is to show about one.
   *
   * The screen's reader rather than the model's: the same file, the same frontmatter
   * stripped, the same folder boundary — but it can open one that is still **waiting for a
   * person**, because reading it is how somebody decides whether to say yes (M6-9).
   */
  const skillText = (name: string): Promise<string> => Promise.resolve(skills.text(name))

  return {
    /**
     * Every model any provider will admit to, and which one is being used (the Models tab).
     *
     * The catalog is the only source. Nothing here asks a provider anything: the lists are
     * fetched on the daily poll and cached, so this screen opens at the speed of a file read
     * whether or not the machine is online — the same rule the other four tables follow.
     *
     * **Only what you can actually reach.** A provider with no key contributes nothing here.
     *
     * This screen used to list everything and mark the unreachable rows *needs a key*, on
     * the argument that *what would connecting Groq get me* is a question worth answering.
     * It is — but not at this price: one key gets you four hundred models and six providers
     * you have never signed up to, so the answer arrived as eighty rows of noise wrapped
     * around the twenty that can answer a question today. A chooser whose contents you
     * cannot use is a catalogue, and nobody opens this tab to browse a catalogue.
     *
     * The question keeps its answer in the place that was always better for it: the settings
     * screen, where the keys are, listing every provider and what connecting one costs.
     */
    models: {
      rows: async () => {
        // Opening the list is the signal that somebody wants it current. Deliberately not
        // awaited — a screen that blocked on seven providers would be a screen that opens
        // slowly on a bad connection to show numbers it already had.
        options.refresh()
        const standing = pins(store)
        const keyed = await options.connected()
        /**
         * What Automatic would pick if nothing were pinned — which is what *recommended*
         * means here, and the only definition of it that cannot drift.
         *
         * Not a list of good models kept in this file. Core does not name a vendor's model
         * any more than it names a plugin, and a list like that is wrong within a season:
         * the good free model of March is retired by June and the file remembers it
         * forever. This asks the router, so the recommendation is the same rule the machine
         * actually follows — cheapest that clears every pin — and it changes when the
         * catalog, the keys or the rate limits change, without anybody editing anything.
         *
         * Asked as a request carrying tools, because that is the shape Alexia's own loop
         * sends. Recommending something that cannot take a tool call would be recommending
         * a model that fails on the second step of most real tasks.
         */
        const would = route(
          { messages: [], tools: [{ name: 'a_tool' }] },
          { ...standing, model: undefined },
          await options.world(),
        )
        const best = would.ok ? would.choices[0]?.model.id : undefined
        return (
          catalog.models
            .filter((model) => keyed.has(model.provider))
            .sort(
              (a, b) =>
                // What it would pick, then what you have actually been using, then the order
                // the router itself walks them in. The top of each group is the useful end.
                Number(b.id === best) - Number(a.id === best) ||
                // Then what the world is actually using, which is the closest thing to a
                // review a model has. Providers that publish nothing fall through to price,
                // so their models are ordered as they always were rather than sunk.
                (b.weekly ?? 0) - (a.weekly ?? 0) ||
                a.priceIn - b.priceIn ||
                a.name.localeCompare(b.name),
            )
            .map((model) => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              tier: model.tier,
              price: price(model.priceIn),
              context: window(model.context),
              week: model.weekly === undefined ? '—' : count(model.weekly),
              /**
               * `◆` is the chosen mark, and the shell colours it. The other two are the
               * marks every core table already speaks in — `■` for something that is not
               * switched on, nothing at all for the ordinary case.
               *
               * *Everything goes here* rather than *in use*, because *in use* answers a
               * question nobody asked. The one somebody has is **what did pressing that
               * do**, and the answer is that this model now answers everything.
               */
              state:
                model.id === standing.model ? '◆ everything goes here'
                : model.id === best ? '★ recommended'
                : model.supportsTools ? `${OK} · tools`
                : `${OK} · text only`,
            }))
        )
      },
      detail: async (id) => {
        const model = catalog.models.find((one) => one.id === id)
        if (!model) return 'That model is not in the catalog any more.'
        const keyed = await options.connected()
        return (
          [
            model.id,
            '',
            `${model.tier} · ${price(model.priceIn)} in, ${price(model.priceOut)} out, per million tokens`,
            `Context: ${window(model.context)} · takes ${model.modality.join(', ')}`,
            `Tools: ${model.supportsTools ? 'yes' : 'not according to its provider'}`,
            model.weekly === undefined ?
              `${model.provider} does not publish how much its models are used.`
            : `${count(model.weekly)} tokens through this model last week, across everyone using ${model.provider}.`,
            // The two flags nobody may guess at. Both say `unknown` until a person has read
            // the provider's terms, and the screen repeats that rather than rounding it off.
            `Trains on what you send it: ${model.trainsOnYourData}`,
            `Uncensored: ${model.nsfwOk}`,
            ...(keyed.has(model.provider) ? [] : ['', `Add a key for ${model.provider} in settings to use this.`]),
          ].join('\n')
        )
      },
    },

    activity: {
      rows: () =>
        Promise.resolve(
          trace.runs.map((run) => ({
            id: run.id,
            // Their own words, cut rather than summarised — a paraphrase of what somebody
            // asked for is the one thing that makes a run hard to find again.
            task: run.task.length > 90 ? `${run.task.slice(0, 90)}…` : run.task,
            steps: run.steps.length,
            // Four places, because a free run is $0.0000 and a cheap one is $0.0003, and
            // rounding the second to the first is how a ledger stops being believed.
            cost: run.ended === undefined ? '—' : `$${spentOn(run).toFixed(4)}`,
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
              where:
                skill.pluginId !== undefined ? `with ${skill.pluginId}`
                  // Where it came from, never guessed. A folder that appeared with nothing
                  // written about it is *unknown*, which is a fact and not a shrug (M6-9).
                : skill.provenance === 'installed' ? 'from the marketplace'
                : skill.provenance === 'unknown' ? 'unknown'
                : 'installed here',
              state: skill.live === false ? '▲ waiting for you' : OK,
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
              // A model wrote it, after a task, about what it thinks it just learned. Until
              // somebody says yes it is not in the index and cannot be read (M6-9, D84).
              state: skill.live === false ? '▲ waiting for you' : OK,
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
 * Everything the palette can find, over the same reads the panels use (M6-10).
 *
 * **No second index.** These are the rows the tables themselves show, asked for the same way,
 * so a skill that has just been forgotten is gone from the palette by the act that removed
 * it and nothing has to be told twice.
 *
 * A plugin's panel contributes its **name** and not its contents. Reaching inside one means a
 * tool call, and a palette that spawned every installed plugin on every keystroke would be a
 * search box with a startup cost — which is the opposite of what Ctrl+K is for.
 */
export async function searchable(
  options: SurfaceOptions,
  tabs: readonly { id: string; label: string; from: string }[],
): Promise<Searchable[]> {
  const ours = sources(options)
  const found: Searchable[] = tabs.map((tab) => ({
    tab: tab.id,
    kind: tab.from === 'core' ? 'panel' : 'plugin',
    label: tab.label,
  }))

  /** Which table each row comes from, and what to call one of its rows on screen. */
  const lists: [string, string, string, (row: Row) => string][] = [
    ['activity', 'activity', 'run', (row) => String(row.task)],
    ['skills', 'skills', 'skill', (row) => String(row.name)],
    ['skills', 'learned', 'learned skill', (row) => String(row.name)],
    ['tools', 'tools', 'tool', (row) => String(row.name)],
    ['library', 'library', 'plugin', (row) => String(row.name)],
  ]
  for (const [tab, key, kind, label] of lists) {
    const source = ours[key]
    if (!source) continue
    for (const row of await source.rows()) {
      const detail = [row.from, row.plugin, row.where, row.state].filter((one) => typeof one === 'string').join(' · ')
      found.push({ tab, kind, label: label(row), ...(detail !== '' && { detail }) })
    }
  }
  return found
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
  /**
   * *Yes* to a skill that is waiting (M6-9).
   *
   * The other end of the ladder, and the only place a person grants one: a skill nobody has
   * said yes to is not in the model's index and cannot be read by it.
   */
  const allowSkill = (name: string): Promise<{ ok: boolean; said: string }> => {
    const skill = options.skills.all.find((one) => one.name === name)
    if (!skill) return Promise.resolve({ ok: false, said: `There is no skill called ${name}.` })
    if (skill.live !== false) return Promise.resolve({ ok: true, said: `${name} was already allowed.` })
    allow(options.store, name)
    options.skills.invalidate()
    return Promise.resolve({ ok: true, said: `${name} is live. Alexia can use it now.` })
  }

  const forgetSkill = (name: string): Promise<{ ok: boolean; said: string }> => {
    const skill = options.skills.all.find((one) => one.name === name)
    if (skill?.pluginId !== undefined) {
      return Promise.resolve({
        ok: false,
        said: `${name} came with ${skill.pluginId}. It goes when that does — delete the plugin, or disable it.`,
      })
    }
    const gone = forget(options.skillsDir, name)
    // What was said about it goes with it, so a folder that turns up under that name
    // tomorrow is a folder nobody has said yes to (M6-9).
    if (gone) forgetConsent(options.store, name)
    options.skills.invalidate()
    return Promise.resolve(
      gone ?
        { ok: true, said: `Forgotten. ${name} is gone.` }
      : { ok: false, said: `There is no skill called ${name}.` },
    )
  }

  /**
   * *Use this one, and stop choosing for me* — the Models tab's whole purpose.
   *
   * It writes `pins.model`, which the router already treats as final: a named model wins
   * outright, past the tier ladder and past a content flag nobody has verified. That branch
   * was written for a slash command that does not exist yet and had no way to be reached.
   * This is the way to reach it, and it adds no second notion of *chosen*.
   *
   * A model whose provider has no key is refused **here**, with the sentence naming what to
   * do. The router would refuse it too, but three screens later and as *is not available
   * right now*, which is true and useless.
   */
  const useModel = async (id: string): Promise<{ ok: boolean; said: string }> => {
    const model = options.catalog.models.find((one) => one.id === id)
    if (!model) return { ok: false, said: 'That model is not in the catalog any more.' }
    if (!(await options.connected()).has(model.provider)) {
      return {
        ok: false,
        said: `${model.name} comes from ${model.provider}, which has no key yet. Add one in settings and try again.`,
      }
    }
    setPin(options.store, { model: id })
    return {
      ok: true,
      said: `Every request now goes to ${model.name}. Press Automatic on any row to hand the choice back.`,
    }
  }

  return {
    use_model: useModel,
    /**
     * Back to the router choosing. On every row rather than only the pinned one, because a
     * button that appears and disappears as the selection moves is a button people hunt for
     * — and *stop pinning* means the same thing pressed anywhere.
     */
    automatic: () => {
      const had = pins(options.store).model
      setPin(options.store, { model: undefined })
      return Promise.resolve({
        ok: true,
        said:
          had === undefined ?
            'Already automatic — no model is pinned, so each request goes to the cheapest one that fits it.'
          : 'Back to automatic. Each request goes to the cheapest model that fits it, and no model is pinned.',
      })
    },

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

    allow_skill: allowSkill,
    forget_skill: forgetSkill,
    // The learned list is a second table on the same screen, and a row action is looked up
    // by key — so two keys reaching the same two operations, rather than one key with two
    // possible meanings.
    allow_here: allowSkill,
    forget_here: forgetSkill,
  }
}
