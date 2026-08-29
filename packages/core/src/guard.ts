// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each route core serves is allowed to do, written down once, and the refusal that
 * holds it.
 *
 * `serve.ts` grew twelve `POST` handlers with no rule at all about which of them can destroy
 * something — *install* sits four lines above *purge* and nothing distinguishes them. This
 * file is the rule. Every path core answers is **read-only**, **reversible**, or **needs a
 * confirm**, and `guard.test.ts` walks the real routes to prove there is no fourth kind and
 * no route missing from the list.
 *
 * **A reason per entry, not just a path.** An endpoint nobody can justify in one sentence is
 * an endpoint that should have been guarded, and demanding the sentence is what makes that
 * argument happen while the route is being written rather than after something is gone.
 *
 * **The confirm is a contract on the wire, not a button.** `confirm: true` in the body says
 * the caller knows what it is asking for. The shell backs some of these with a second press
 * and some with a button whose label is already the confirmation — that is a question about
 * a screen. What this file guarantees is that nothing reaches a purge without saying so,
 * including everything that will call these routes later without having read this file.
 *
 * **The hole the predecessor left, and why it cannot open here.** The first Alexia's
 * dashboard keyed its safe list by `(path, method)` across every mounted router, so the
 * skills router's `/{name}/approve` — which only un-archives — declared the MCP router's
 * `/{name}/approve` safe as well, and that one writes the live gateway config. Found,
 * written down, never fixed. It cannot reproduce in this shape: core's router is a single
 * flat match on `url.pathname`, so a path is already globally unique and a key here means
 * exactly one handler. If it is ever split into mounted routers, this paragraph is the
 * warning — that is the day the key stops being unique.
 *
 * **Deliberately not an eleventh invariant** (D82). The ten are about the plugin contract and
 * what survives a folder being deleted. This is a safety property of core's own HTTP surface,
 * so it joins `pnpm check` as a test on its own merits and the ten stay ten.
 */

export type Body = Record<string, unknown>

/**
 * What a route is. Three kinds, and the test's whole job is proving there is no fourth —
 * because the fourth kind is *nobody looked*, and that is what `serve.ts` had.
 */
export type Verdict =
  /** It changes nothing. Answered on a GET, and refused anything that means to change it. */
  | { readonly kind: 'read'; readonly why: string }
  /** It changes something the same screen can change back. Runs unasked. */
  | { readonly kind: 'safe'; readonly why: string }
  /** It can take something away. Refused unless the body carries `confirm: true`. */
  | { readonly kind: 'confirm'; readonly what: string }

const read = (why: string): Verdict => ({ kind: 'read', why })
const safe = (why: string): Verdict => ({ kind: 'safe', why })
const confirm = (what: string): Verdict => ({ kind: 'confirm', what })

export interface Route {
  /**
   * Which act this body is asking for, when one endpoint carries several. `action` by
   * default, because that is the field most of them dispatch on.
   */
  readonly act?: (body: Body) => string | undefined
  /** The acts that differ from `otherwise`. Only the exceptions are listed. */
  readonly acts?: Readonly<Record<string, Verdict>>
  /**
   * What this endpoint is when nothing narrows it — and where an act nobody declared lands,
   * which is why the endpoints that can delete keep the deletion here rather than in `acts`.
   */
  readonly otherwise: Verdict
}

const byAction = (body: Body): string | undefined => (typeof body.action === 'string' ? body.action : undefined)

/**
 * Core's own row actions that take nothing away.
 *
 * Deliberately a short allow-list rather than a list of the destructive ones: a core action
 * added tomorrow and forgotten here is guarded, which is the wrong way round to be annoying
 * and the right way round to be safe.
 */
const REVERSIBLE_CORE = new Set([
  'export_run',
  // Choosing which model answers, and giving the choice back. Nothing is deleted and each
  // one undoes the other, so a confirmation here would be a dialog in front of a preference
  // — which is how people learn to click through the dialogs that matter.
  'use_model',
  'automatic',
  // Starting a conversation and moving between them (M8-2). Nothing is written over and
  // nothing is lost: the one you were in is still in the list, one press away. `forget_chat`
  // is deliberately **not** here — it deletes a conversation and everything said in it.
  'new_chat',
  'open_chat',
])

/**
 * Every path core answers, in the order `serve.ts` matches them.
 *
 * The keys are checked against the real file rather than trusted, so a route added tomorrow
 * turns this list red without anybody having to remember it exists.
 */
export const ROUTES: Readonly<Record<string, Route>> = {
  '/api/state': {
    otherwise: read(
      'Everything the shell draws itself from — the conversation, the pins, the spend, and the current value of every control that changes them. It reads the store and writes nothing.',
    ),
  },

  '/api/setup': {
    otherwise: safe(
      'Three first-run values, each written by the screen that shows it and each writable again. The only thing it can replace is a provider key, and only with one somebody has just typed into the box beside it.',
    ),
  },

  '/api/command': {
    otherwise: safe(
      "Two kinds of command, both typed by name. Core's own set a mode or a pin — one word to change back, with the current value shown beside the control. A plugin's is a call to that plugin's tool, and it goes through the same permission ruling the loop and the action buttons use, which is where a destructive one is stopped.",
    ),
  },

  '/api/permissions': {
    // The one field on this endpoint that removes something rather than setting it.
    act: (body) => (body.lift === true ? 'lift' : undefined),
    acts: {
      lift: confirm(
        'Lifting drops every boundary you have spoken aloud, all of them at once, and nothing keeps a copy. The sentences that made them are in the conversation, not in a store this can put them back from.',
      ),
    },
    otherwise: safe(
      'A mode, a list of folders and a switch. All three are shown on the screen that writes them and all three can be set back — and widening one is what the picker is for, not something core does on its own.',
    ),
  },

  '/api/ceilings': {
    otherwise: safe(
      'Three numbers, each with a control beside its current value and each changeable back. Raising one spends nothing by itself; the preview and the cap are what stand between a number and money (M15-7).',
    ),
  },

  '/api/stop': {
    otherwise: safe(
      'It aborts a running task and settles an open permission question as a no. Nothing is deleted — the half-finished answer stays in the history — and starting again costs a sentence.',
    ),
  },

  '/api/approve': {
    otherwise: safe(
      'This is a confirmation arriving, not an act that needs one. It carries an answer to a question the loop is already blocked on, and a gate in front of the consent primitive would be a question about a question.',
    ),
  },

  '/api/plugins': {
    otherwise: read(
      'Every installed plugin, its settings pane, the folders that are not plugins, and the skills. It spawns nothing: with lazy spawn *not running* is the ordinary state, and a screen that woke three processes to draw itself would wake them every time anybody looked.',
    ),
  },

  '/api/panels': {
    otherwise: read(
      'The control surface’s tab list: core’s own tabs, and one for every enabled plugin that declared a panel. Assembled from manifests and the store on every read, and it spawns nothing.',
    ),
  },

  '/api/search': {
    otherwise: read(
      'The command palette, over the same reads the panels use — no second index, and a plugin’s panel contributes its name rather than its contents, because reaching inside one would mean spawning it on every keystroke. It finds; it never runs anything.',
    ),
  },

  '/api/plugin': {
    acts: {
      enable: safe(
        'The plugin starts. It is the moment of consent and the screen has just shown, in the author’s own words, what it asked for — and disable is one press away.',
      ),
      disable: safe(
        'The process stops and everything it owns stays: its folder, its settings, its stored data, its keychain entries. It is the cheap opposite of enable, which is why the screen offers it first.',
      ),
    },
    // `delete`, and anything nobody declared, lands here. Purge is the whole reason this
    // endpoint is in the confirming half at all.
    otherwise: confirm(
      'Deleting takes the plugin’s folder, its settings, everything it stored and its keychain entries with it — that is what invariant 5 checks — and only a fresh download brings any of it back.',
    ),
  },

  '/api/install': {
    otherwise: safe(
      'It copies a folder in and enables nothing, because a folder appearing is not consent (D73). An id that is already installed is refused rather than overwritten, so nothing here replaces anything.',
    ),
  },

  '/api/library': {
    otherwise: read(
      'What the registry lists, what is already here, and what has been withdrawn. It reaches the network and writes nothing; when the registry is unreachable it says so rather than answering an empty list.',
    ),
  },

  '/api/library/install': {
    act: (body) => (body.update === true ? 'update' : undefined),
    acts: {
      update: confirm(
        'An update stops the running plugin and replaces its folder with a different version. The version being replaced is not kept, and the thing being overwritten is a plugin that was working a minute ago.',
      ),
    },
    otherwise: safe(
      'A download, a checksum, and a folder that arrives installed and not enabled. Nothing already here is touched, and deleting it again is one press away.',
    ),
  },

  '/api/server': {
    acts: {
      trust: confirm(
        'Trusting an MCP server stops core treating its tools as things that change something — every tool it has now and every tool it grows later, in every mode. It is a decision with a person behind it, which is the only shape that answer should ever take.',
      ),
    },
    otherwise: safe(
      'Adding probes the server before writing anything, so a mistyped command fails with the operating system’s own words. It arrives unreviewed, which means every tool it offers is asked about until somebody says otherwise.',
    ),
  },

  '/api/learn': {
    acts: {
      forget: confirm(
        'It deletes the skill’s folder from disk. A learned skill was distilled from a task that has long since scrolled away, so nothing regenerates it.',
      ),
      edit: safe(
        'Only a skill Alexia wrote is editable here — one somebody installed belongs to whoever wrote it — and the text being replaced is the text sitting in the box that submits it, which can be typed back.',
      ),
    },
    otherwise: safe(
      'Distilling the last task into a skill writes a new folder and removes nothing. It costs a model call under the same ceilings as everything else, and forget is the way back.',
    ),
  },

  '/api/settings': {
    otherwise: safe(
      'One declared setting, validated against the schema its plugin published, written where the same pane can write it again. A secret goes to the keychain rather than the database, and replacing one is what typing in the box means.',
    ),
  },

  '/api/rows': {
    otherwise: safe(
      'A table asking for its contents. It calls the tool the author named, under the same permission ruling every tool call gets — a lister that has not declared itself read-only is asked about, in every mode but Full trust. Nothing core owns changes.',
    ),
  },

  '/api/detail': {
    otherwise: safe(
      'What expands under one row of a table: the same call as the list above, about one thing rather than all of them, through the same ruling.',
    ),
  },

  '/api/action': {
    // Whose button it is, and — when it is core's own — which one.
    //
    // A press with a plugin behind it is guarded by the permission ruling. A press with none
    // is core acting on core's own data, and there is nothing for that ruling to rule on, so
    // this is the gate instead. Named exceptions are listed; **anything of core's not on the
    // list needs a confirm**, which is what keeps the next one from arriving unguarded.
    act: (body) => {
      const plugin = typeof body.plugin === 'string' ? body.plugin : ''
      if (plugin !== '') return undefined
      return REVERSIBLE_CORE.has(typeof body.key === 'string' ? body.key : '') ? 'core-safe' : 'core'
    },
    acts: {
      core: confirm(
        'A row action on one of core’s own lists — forgetting a skill, which deletes a folder. There is no plugin and so no tool call, which means the permission ruling that guards the other kind has nothing to rule on.',
      ),
      'core-safe': safe(
        'One of core’s own row actions that takes nothing away — exporting a run to a file, which adds one and changes nothing that was already there. The list is short on purpose, and anything not on it is guarded.',
      ),
    },
    otherwise: safe(
      'A press on a plugin’s button or a row action on its table. Both go through the same permission ruling a tool call gets: a destructive tool is asked about in every mode but Full trust, and the never-touch list is not negotiable in any of them (M15-3). A confirm here would be the same question twice.',
    ),
  },

  '/api/chat': {
    otherwise: safe(
      'Sending a sentence is the product. Everything it can then do goes through the permission gate, the never-touch list and the ceilings, and the preview asks before an expensive task starts — a confirm on the message box would be a confirm on typing.',
    ),
  },
}

/** What a route is, for a given body. `undefined` means core does not serve this path. */
export function verdictOf(path: string, body: Body = {}): Verdict | undefined {
  const route = ROUTES[path]
  if (route === undefined) return undefined
  const act = (route.act ?? byAction)(body)
  return (act === undefined ? undefined : route.acts?.[act]) ?? route.otherwise
}

export interface Refusal {
  /** 404 core does not serve this; 405 it only reads; 409 it needs a confirm it did not get. */
  status: 404 | 405 | 409
  /** The sentence to show. It says what would have happened, in the words a person reads. */
  said: string
  /** Whether sending the same request again with `confirm: true` would run it. */
  confirmable: boolean
}

/**
 * The guard itself, run before any handler sees the request.
 *
 * A read falls straight through, because a GET is not the thing this is here to catch.
 * Everything else has to be on the list — which is what makes an unclassified route a
 * refusal rather than a silence, and what keeps `confirm` from being something a handler
 * has to remember to ask for.
 */
export function refuse(path: string, method: string, body: Body): Refusal | undefined {
  if (method === 'GET' || method === 'HEAD') return undefined

  const verdict = verdictOf(path, body)
  if (verdict === undefined) {
    return { status: 404, said: `There is nothing at ${path}.`, confirmable: false }
  }
  if (verdict.kind === 'read') {
    return {
      status: 405,
      said: `${path} only reads. Nothing about it changes anything, so it does not answer a request that means to.`,
      confirmable: false,
    }
  }
  if (verdict.kind === 'confirm' && body.confirm !== true) {
    return { status: 409, said: `${verdict.what} Nothing has happened yet.`, confirmable: true }
  }
  return undefined
}
