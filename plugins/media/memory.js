// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What this plugin remembers between pictures, so a person does not have to.
 *
 * Three things, each in the plugin's own storage and each for a different sentence:
 *
 *  - **Which workflow and which model were used last** (`remembered`). *Make me a picture of a
 *    fox* after an afternoon of anime portraits means another anime portrait, not the plain
 *    pipeline with whatever checkpoint sorts first.
 *  - **What the person set on each workflow** (`kept`). *Make it wider* and *more steps* are
 *    said once; the next picture from that workflow is wider and slower too, until somebody
 *    says otherwise or asks for its defaults back. A seed is never kept this way — a kept seed
 *    is every picture the same, which nobody asks for by saying *more steps*.
 *  - **What each workflow last ran with, seed included** (`runs`). That is what *again* and
 *    *same settings* read, and it is everything, because *the same one but at night* means the
 *    same seed.
 *
 * Nothing in here knows which computer rendered. A model remembered from a paired computer may
 * not be on this one, which is why a remembered name is only ever a preference (`render.js`).
 */

export const REMEMBERED = 'remembered'
export const KEPT = 'kept'
export const RUNS = 'runs'

/** A value worth keeping: something was said, and it is not a picture somebody attached. */
const worth = (value) => value !== undefined && value !== null && value !== ''

export function memory(storage) {
  const read = async (key) => {
    const said = await storage.get(key).catch(() => undefined)
    return said !== null && typeof said === 'object' && !Array.isArray(said) ? said : {}
  }
  const write = (key, value) => storage.set(key, value).catch(() => {})

  return {
    /** `{ workflow?, checkpoint? }` — what the last picture was made with, whatever made it. */
    remembered: () => read(REMEMBERED),

    /** Write down what a picture was just made with. Only what is known is changed. */
    async used({ workflow, checkpoint } = {}) {
      const now = await read(REMEMBERED)
      await write(REMEMBERED, {
        ...now,
        ...(worth(workflow) && { workflow: String(workflow) }),
        ...(worth(checkpoint) && { checkpoint: String(checkpoint) }),
        at: Date.now(),
      })
    },

    /** Forget the remembered model — the settings screen named one, and that is newer. */
    async forgetModel() {
      const { checkpoint, ...rest } = await read(REMEMBERED)
      if (checkpoint !== undefined) await write(REMEMBERED, rest)
    },

    /** What the person has set on one workflow, by field. */
    kept: async (workflow) => ({ ...((await read(KEPT))[String(workflow)] ?? {}) }),

    /** Add what was just set to what is kept. A value given replaces the one before it. */
    async keep(workflow, values = {}) {
      const all = await read(KEPT)
      const now = { ...(all[String(workflow)] ?? {}) }
      let changed = false
      for (const [field, value] of Object.entries(values)) {
        if (!worth(value)) continue
        now[field] = value
        changed = true
      }
      if (changed) await write(KEPT, { ...all, [String(workflow)]: now })
      return now
    },

    /**
     * Back to the workflow's own defaults: every kept value, or just the fields named. Answers
     * the fields that were cleared, so the answer can name them.
     */
    async reset(workflow, fields) {
      const all = await read(KEPT)
      const now = { ...(all[String(workflow)] ?? {}) }
      const named = Array.isArray(fields) && fields.length > 0 ? fields.map(String) : Object.keys(now)
      const cleared = named.filter((field) => Object.hasOwn(now, field))
      for (const field of cleared) delete now[field]
      const others = { ...all }
      delete others[String(workflow)]
      await write(KEPT, Object.keys(now).length > 0 ? { ...others, [String(workflow)]: now } : others)
      return cleared
    },

    /** `{ values, seed }` of the last run of one workflow, or nothing. */
    last: async (workflow) => (await read(RUNS))[String(workflow)],

    /** Write down a run, so *again* can find it. */
    async ran(workflow, { values = {}, seed } = {}) {
      const all = await read(RUNS)
      await write(RUNS, { ...all, [String(workflow)]: { values, seed, at: Date.now() } })
    },
  }
}

/**
 * The values one run uses, and where each came from.
 *
 * **Said beats again beats kept beats the workflow's own.** A value named in this call is the
 * person deciding now; *again* is the last run as it was, which already carried whatever was
 * kept at the time; kept is what they said earlier; and anything nobody said stays as the
 * workflow has it. A remembered field the workflow no longer has is dropped quietly — it was
 * renamed or removed by its author, and refusing over it would be refusing over history.
 */
export function merge({ fields, said = {}, again, kept = {} }) {
  const known = new Set(fields)
  const values = {}
  const from = {}
  for (const [source, given] of [
    ['kept', kept],
    ['again', again ?? {}],
    ['said', said],
  ]) {
    for (const [field, value] of Object.entries(given)) {
      if (!known.has(field) || !worth(value)) continue
      values[field] = value
      from[field] = source
    }
  }
  return { values, from }
}

/**
 * Which workflow a plain request uses: the one asked for, else the one used last.
 *
 * Answers `{ row }` for a saved workflow, or `{ starter: true }` for the plain pipeline — with
 * `said` when what was remembered is gone, so the answer can say the person is not getting what
 * they had a minute ago. `rows` is ComfyUI's own list; `pick` is the loose name match.
 */
export function recall({ asked, remembered, rows = [], starter, pick }) {
  const names = rows.map((one) => one.name)
  const isStarter = (name) => String(name ?? '').trim().toLowerCase() === String(starter).toLowerCase()
  if (asked !== undefined && String(asked).trim() !== '') {
    if (isStarter(asked) || /^(starter|plain|default|alexia)$/i.test(String(asked).trim())) return { starter: true }
    const found = pick(names, String(asked))
    if (found) return { row: rows.find((one) => one.name === found) }
    return {
      refused:
        rows.length === 0 ?
          `There is no workflow called ${String(asked)} — none are saved here.`
        : `There is no workflow called ${String(asked)}. What there is: ${names.join(', ')}`,
    }
  }
  const last = remembered?.workflow
  if (!last || isStarter(last)) return { starter: true }
  const row = rows.find((one) => one.name === last)
  if (row?.export && !row.stale) return { row }
  return {
    starter: true,
    said:
      !row ? `The workflow used last time, ${last}, is not saved here any more, so this used Alexia’s own instead.`
      : !row.export ? `The workflow used last time, ${last}, has no API export any more, so this used Alexia’s own instead.`
      : `The workflow used last time, ${last}, was edited after it was exported, so this used Alexia’s own instead of running the older export.`,
  }
}
