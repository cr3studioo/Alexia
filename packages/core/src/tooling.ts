// SPDX-License-Identifier: AGPL-3.0-only
import type { CallToolResult } from '@modelcontextprotocol/client'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Produced, Tooling, ToolOutcome } from './agent.js'
import type { Annotations } from './permissions.js'
import type { Plugins } from './plugins.js'
import type { ToolSpec } from './provider.js'
import type { Progress } from './settings.js'
import { SKILL_TOOL, type Skills } from './skills.js'

/**
 * Everything the model may call: every enabled plugin's `tools/list`, plus core's own one
 * for reading a skill (M2-2), as the single list the loop is handed.
 *
 * This is the join between the two halves of the project: the supervisor knows what is
 * running, the loop knows how to plan, and neither of them knows the other's vocabulary.
 * Nothing here branches on which plugin it is holding — it aggregates, prefixes, and routes
 * back by the prefix it wrote.
 *
 * **Why `__` and not `.`.** Commands namespace as `/plugin.command`, which is what a person
 * types. A model-facing tool name is not typed by a person: it goes into an OpenAI-shaped
 * `function.name`, and that field is specified as `^[a-zA-Z0-9_-]{1,64}$` — no dots. A dot
 * here is a provider rejecting the whole request, so the separator has to be something in
 * that set. A plugin id cannot contain an underscore (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`), so
 * splitting on the first `__` recovers the id exactly, whatever the tool called itself.
 */

/** The provider-side limit on a function name, and the reason a long one is dropped. */
const NAME_LIMIT = 64
const SEPARATOR = '__'

interface Known {
  pluginId: string
  /** What the plugin calls it. The prefix is core's, and never travels back over the wire. */
  tool: string
  spec: ToolSpec
  /** MCP's own hints, carried through untouched for the permission gate to read. */
  annotations?: Annotations
}

export class PluginTooling implements Tooling {
  #known?: Promise<Known[]>

  constructor(
    private readonly plugins: Plugins,
    /** Where a tool with no description gets mentioned. It is a bug, not a style note. */
    private readonly log?: (line: string) => void,
    /**
     * Know-how (M2-2), which is core's own and belongs to no plugin. It is aggregated here
     * rather than beside here so that there is exactly one list, one `about` and therefore
     * one permission gate — a second `Tooling` would mean a second place to remember.
     */
    private readonly skills?: Skills,
  ) {}

  /**
   * Something changed: a plugin started, stopped, was deleted, or sent
   * `notifications/tools/list_changed`. The next `list` re-asks everything.
   *
   * Dropping the whole cache rather than patching one plugin's entry is deliberate. The
   * event that matters most — a folder deleted mid-task — is also the one where the entry
   * to patch is the entry that is gone, and a re-ask costs one round trip to processes that
   * are already running.
   */
  invalidate(): void {
    this.#known = undefined
  }

  async list(): Promise<ToolSpec[]> {
    const skill = this.skills?.tool
    return [...(skill ? [skill] : []), ...(await this.#aggregate()).map((k) => k.spec)]
  }

  /**
   * What the author declared about a tool, for the permission gate (M15-3). Undefined means
   * core has never heard of it, which the gate reads the same way it reads a tool declaring
   * nothing: not safe until something says so.
   */
  async about(name: string): Promise<{ pluginId?: string; annotations?: Annotations } | undefined> {
    // Reading a skill is reading text core already has on disk. Saying so is what keeps the
    // default mode from asking permission every time the model opens its own instructions.
    // `tool` is undefined when nothing is installed, so it is also the answer to whether
    // `list` offered it — and a gate told about a tool nobody was offered is a gate
    // answering for something that cannot happen.
    if (name === SKILL_TOOL && this.skills?.tool) return { annotations: this.skills.annotations }
    const found = (await this.#aggregate()).find((k) => k.spec.name === name)
    return found && { pluginId: found.pluginId, ...(found.annotations && { annotations: found.annotations }) }
  }

  /**
   * Run one, and come back with something the model can read either way.
   *
   * Nothing here throws. A plugin that crashed, a folder deleted between the model choosing
   * a tool and core calling it, a tool that failed on its own terms — all of them are
   * observations, and the loop's next step is a re-plan around what this says. That is
   * invariant 4 with a real loop behind it, and it is the whole of M15-8's mechanism.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (update: Progress) => void,
  ): Promise<ToolOutcome> {
    // Reading a skill is reading a file. There is nothing to report and nothing to wait for.
    if (name === SKILL_TOOL && this.skills?.tool) return this.skills.read(args)

    let found = (await this.#aggregate()).find((k) => k.spec.name === name)
    if (!found) {
      // It may have appeared a moment ago — a plugin that just finished starting is the
      // ordinary case. Ask once more before telling the model it does not exist.
      this.invalidate()
      found = (await this.#aggregate()).find((k) => k.spec.name === name)
    }
    if (!found) {
      const available = (await this.list()).map((t) => t.name)
      return {
        ok: false,
        text:
          available.length > 0 ?
            `There is no tool called ${name}. What there is: ${available.join(', ')}.`
          : `There is no tool called ${name}, and nothing else is available either.`,
      }
    }

    const process = this.plugins.process(found.pluginId)
    if (!process) {
      this.invalidate()
      return { ok: false, text: `${name} is gone — the plugin providing it is no longer installed.` }
    }

    try {
      // `onprogress` is what puts a `progressToken` on the request, so a plugin that reports
      // has somewhere for it to go — and a plugin that does not simply never sends one.
      return outcomeOf(
        await process.callTool(found.tool, args, {
          ...(signal && { signal }),
          ...(onProgress && {
            onprogress: (update) =>
              onProgress({
                progress: update.progress,
                ...(update.total !== undefined && { total: update.total }),
                ...(update.message !== undefined && { message: update.message }),
              }),
          }),
        }),
      )
    } catch (error) {
      // Whatever went wrong, the model's next move is the same: read this and try
      // something else. A stack trace would be worse prompt text than a sentence.
      this.invalidate()
      return { ok: false, text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** One pass over everything running, memoised until something says otherwise. */
  async #aggregate(): Promise<Known[]> {
    this.#known ??= this.#read()
    return this.#known
  }

  async #read(): Promise<Known[]> {
    const found = await this.plugins.tools()
    const known: Known[] = []
    for (const { pluginId, tool } of found) {
      const name = `${pluginId}${SEPARATOR}${tool.name}`
      if (name.length > NAME_LIMIT) {
        // Not a crash and not silence: the tool is unreachable and its author is the only
        // person who can fix it, so the reason goes where they will see it.
        this.log?.(`${pluginId}: "${tool.name}" is unreachable — ${name.length} characters, and a model-facing tool name may be ${NAME_LIMIT}`)
        continue
      }
      // Tool descriptions are prompt text. A tool with none is a tool the model will reach
      // for at the wrong moment, and it is the author's bug — so it is said out loud rather
      // than papered over with a description core invented.
      if (!tool.description) this.log?.(`${pluginId}: "${tool.name}" has no description, so the model has only its name to go on`)
      known.push({
        pluginId,
        tool: tool.name,
        ...(tool.annotations && { annotations: tool.annotations as Annotations }),
        spec: {
          name,
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.inputSchema && { parameters: tool.inputSchema as Record<string, unknown> }),
        },
      })
    }
    return known
  }
}

/**
 * One `resource_link` block, as a file on this machine — or nothing, if it does not name one.
 *
 * **Only `file:` URIs, and only ones that are there.** A `resource_link` may point at
 * anything with a URI, and core's answer to *the tool handed back an https:// address* is
 * that it is a link and the text already says so. What this is for is the narrower case that
 * had no answer at all: a plugin made a file, on this disk, and wants the person to have it.
 *
 * The existence check is here rather than at registration because **this function writes the
 * sentence the model reads**, and the model's sentence and the row on screen have to agree
 * about whether there is a file. A tool that names a file it did not manage to write says so
 * in the text, and no row appears offering to open it.
 */
function produced(block: Record<string, unknown>): Produced | undefined {
  const uri = String(block.uri ?? '')
  if (!uri.startsWith('file:')) return undefined
  try {
    const path = fileURLToPath(uri)
    const found = statSync(path)
    if (!found.isFile()) return undefined
    return {
      name: String(block.name ?? '') || basename(path),
      path,
      bytes: found.size,
      mime: String(block.mimeType ?? '') || 'application/octet-stream',
    }
  } catch {
    // A malformed URI, or a file the tool named and did not write. Either way there is
    // nothing to hand anybody, and the caller says so instead of offering it.
    return undefined
  }
}

/**
 * An MCP result as the model reads it. Text blocks are the whole of what a model can use
 * here; anything else is named rather than dropped silently, because *the tool returned an
 * image* is something to plan around and an empty string is not.
 *
 * A `resource_link` is named **and** kept. The model gets `[file: report.pdf]`, which is all
 * it can act on — `Message.content` is a string and the bytes were never going to fit in it
 * — and the file itself goes up to the shell, which can do rather more with it than say its
 * name.
 */
export function outcomeOf(result: CallToolResult): ToolOutcome {
  const files: Produced[] = []
  const parts = (result.content ?? []).map((block) => {
    if (block.type === 'text') return block.text as string
    if (block.type === 'resource_link') {
      const one = produced(block)
      if (one !== undefined) {
        files.push(one)
        return `[file: ${one.name}]`
      }
      return `[file: ${String(block.name ?? block.uri ?? 'unnamed')} — not written]`
    }
    return `[${block.type}]`
  })
  const text = parts.join('\n').trim()
  return {
    ok: result.isError !== true,
    // A tool that succeeded and said nothing did happen, and the model needs to be told
    // that rather than handed a blank it will read as a failure.
    text: text || (result.isError === true ? 'The tool failed and said nothing.' : 'Done.'),
    ...(files.length > 0 && { files }),
  }
}
