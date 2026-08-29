// SPDX-License-Identifier: Apache-2.0
import {
  Manifest,
  MCP_REVISIONS,
  PROVIDES_META,
  versionVerdict,
  type Manifest as ManifestType,
} from '@alexia/protocol'
import { Client, type Tool } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fakeHost } from './host.js'

/**
 * `@alexia/conformance` — the mechanical half of review, done by a machine.
 *
 * **This lands before the registry opens, and that ordering is the point.** Review is one
 * person's evenings; without this, review is the bottleneck that stops everything else. So
 * everything a machine can decide, a machine decides — does the manifest validate, does it
 * boot, does it handshake, does it keep stdout clean, does everything it writes go through
 * the contract, does it survive a missing dependency — and a human's time goes only on the
 * half that needs judgement: is this plugin's *purpose* honest, and are the sentences in
 * `requires[]` true.
 *
 * It is also the thing Alexia.md asks for by name: something that says a plugin is correct
 * without a person auditing every line.
 *
 * Three outcomes, and the middle one matters. A `fail` is a plugin that does not work or
 * does not honour the contract. A `warn` is a plugin that works and will disappoint
 * somebody — a tool with no description is prompt text nobody wrote, and it is the author's
 * bug even though nothing crashes.
 */

export type Level = 'pass' | 'warn' | 'fail'

export interface Check {
  name: string
  level: Level
  /** One sentence, written to be read by the plugin's author. Never a stack trace. */
  detail: string
}

export interface Report {
  id: string
  dir: string
  /** True when nothing failed. Warnings do not stop a plugin from being publishable. */
  ok: boolean
  checks: Check[]
}

export interface ConformOptions {
  /** How long the plugin may take to hand back a handshake. Generous: a cold start is slow. */
  startMs?: number
  callMs?: number
  /**
   * Call the plugin's read-only tools as part of the run.
   *
   * On by default, and read-only only: a conformance suite that pressed every button would
   * be a conformance suite that sent somebody's email. A tool that has not declared itself
   * read-only is not called, and the report says so rather than pretending it was checked.
   */
  exercise?: boolean
}

/** The provider-side limit on a function name, and core's separator. Both in `tooling.ts`. */
const NAME_LIMIT = 64
const SEPARATOR = '__'

export async function conform(given: string, options: ConformOptions = {}): Promise<Report> {
  // Absolute from here on. The child's working directory is its own data folder, not this
  // one, so a relative path handed to `entry.args` resolves against the wrong place and the
  // plugin dies with MODULE_NOT_FOUND — which is what the stderr capture above found.
  const dir = resolve(given)
  const checks: Check[] = []
  const add = (name: string, level: Level, detail: string): void => void checks.push({ name, level, detail })
  const folder = basename(dir)

  // ---- 1. the manifest, before anything is spawned -------------------------------------

  let manifest: ManifestType
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    const parsed = Manifest.safeParse(raw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return done(folder, dir, [
        { name: 'manifest', level: 'fail', detail: `plugin.json is not valid: ${first?.path.join('.')} ${first?.message}` },
      ])
    }
    manifest = parsed.data
  } catch (error) {
    return done(folder, dir, [
      { name: 'manifest', level: 'fail', detail: `no readable plugin.json: ${String(error)}` },
    ])
  }

  if (manifest.id !== folder) {
    return done(manifest.id, dir, [
      { name: 'manifest', level: 'fail', detail: `the folder is called "${folder}" and plugin.json says "${manifest.id}"` },
    ])
  }
  const versions = versionVerdict(manifest)
  if (!versions.ok) {
    return done(manifest.id, dir, [{ name: 'manifest', level: 'fail', detail: versions.reason.split('\n')[0] ?? versions.reason }])
  }
  add('manifest', 'pass', `valid, alexia_protocol ${manifest.alexia_protocol}, MCP ${manifest.mcp_protocol}`)

  // Every sentence in `requires[]` is shown to a person deciding whether to enable this. A
  // vague one is not a crash and is the single most common reason a walkthrough is useless.
  const vague = (manifest.requires ?? []).filter((r) => r.why.trim().split(/\s+/).length < 4)
  add(
    'requires-are-sentences',
    vague.length === 0 ? 'pass' : 'warn',
    vague.length === 0 ?
      `${String((manifest.requires ?? []).length)} asked for, each with a reason a person can read`
    : `these read as labels rather than reasons: ${vague.map((r) => r.cap).join(', ')}`,
  )

  // ---- 2. boot, handshake, and everything that needs a live process --------------------

  const sandbox = mkdtempSync(join(tmpdir(), 'alexia-conformance-'))
  const ownDir = join(sandbox, 'own')
  const host = fakeHost({ manifest, ownDir })
  const said: string[] = []

  const command = manifest.entry.run === 'node' ? process.execPath : join(dir, manifest.entry.run)
  const transport = new StdioClientTransport({
    command,
    args: manifest.entry.args?.map((arg) => (existsSync(join(dir, arg)) ? join(dir, arg) : arg)),
    // The same rule core uses, and for the same reason: a running process's working
    // directory cannot be deleted on Windows, and being deletable is the whole point.
    cwd: ownDir,
    env: {
      ...getDefaultEnvironment(),
      ALEXIA_PLUGIN_DIR: dir,
      // Its scratch space, so anything it leaves in a temp directory is visible below.
      TMPDIR: join(sandbox, 'tmp'),
      TEMP: join(sandbox, 'tmp'),
      TMP: join(sandbox, 'tmp'),
    },
    stderr: 'pipe',
  })
  mkdirSync(join(sandbox, 'tmp'), { recursive: true })

  const client = new Client(
    { name: 'alexia-conformance', version: '0.1.0' },
    {
      capabilities: { roots: {}, sampling: {} },
      supportedProtocolVersions: [...MCP_REVISIONS],
      versionNegotiation: { mode: 'auto' },
    },
  )
  client.setRequestHandler('roots/list', () => ({ roots: [] }))
  client.setRequestHandler('sampling/createMessage', () => {
    throw new Error('the conformance host answers no model calls')
  })
  for (const [method, schemas, handler] of host.handlers) client.setRequestHandler(method, schemas, handler)

  try {
    let refused: unknown
    try {
      await client.connect(transport, { timeout: options.startMs ?? 20_000 })
    } catch (error) {
      refused = error
    }
    // Attached whether or not the connection came up. **A plugin that died on startup is
    // the one case where its own last words matter most**, and reporting only "Connection
    // closed" sends an author looking in the wrong place — the pipe still holds whatever it
    // managed to say, so it is read out either way.
    if (transport.stderr) {
      createInterface({ input: transport.stderr as Readable }).on('line', (line) => said.push(line))
    }
    if (refused !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const why = refused instanceof Error ? refused.message : String(refused)
      add('boots', 'fail', `it did not start: ${why}${said.length > 0 ? `\n        it said: ${said.join('\n        ')}` : ''}`)
      return done(manifest.id, dir, checks)
    }
    const spoke = client.getNegotiatedProtocolVersion() ?? '(none)'
    add('boots', 'pass', `handshake in MCP ${spoke}`)

    // ---- 3. the tools, which are the whole of what the model is shown ------------------

    let tools: Tool[]
    try {
      tools = (await client.listTools()).tools
    } catch (error) {
      add('tools', 'fail', `tools/list failed: ${error instanceof Error ? error.message : String(error)}`)
      return done(manifest.id, dir, checks)
    }

    if (tools.length === 0) {
      add('tools', 'warn', 'it lists no tools, so the model has nothing to call')
    } else {
      const undescribed = tools.filter((t) => !t.description || t.description.trim() === '')
      const tooLong = tools.filter((t) => `${manifest.id}${SEPARATOR}${t.name}`.length > NAME_LIMIT)
      if (tooLong.length > 0) {
        // Not a style note: the name goes into an OpenAI-shaped `function.name` and a long
        // one is a tool the model is never offered.
        add('tools', 'fail', `unreachable — over ${String(NAME_LIMIT)} characters once namespaced: ${tooLong.map((t) => t.name).join(', ')}`)
      } else if (undescribed.length > 0) {
        // A tool description is prompt text. Without one the model has only a name to go on
        // and will reach for it at the wrong moment.
        add('tools', 'warn', `no description, so the model has only the name: ${undescribed.map((t) => t.name).join(', ')}`)
      } else {
        add('tools', 'pass', `${String(tools.length)} tools, all described and all reachable`)
      }

      // MCP's own hints are what the permission gate reads. A tool that declares nothing is
      // treated as risky in every mode, which is safe and is usually not what was meant.
      const silent = tools.filter((t) => !t.annotations || Object.keys(t.annotations).length === 0)
      add(
        'annotations',
        silent.length === 0 ? 'pass' : 'warn',
        silent.length === 0 ?
          'every tool says whether it reads or changes things'
        : `these declare no annotations, so Alexia asks before every call: ${silent.map((t) => t.name).join(', ')}`,
      )
    }

    // What the manifest promised, against what the running process actually binds. A gap is
    // legitimate — a plugin whose model has not downloaded cannot answer yet — so this
    // reports rather than fails.
    //
    // Asked twice, with a settle in between. A plugin that binds after its first `await` is
    // the ordinary shape, not a bug, and reporting the snapshot taken a millisecond after
    // the handshake would flag every well-written plugin in the repo.
    if ((manifest.provides ?? []).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 750))
      tools = await client.listTools().then((r) => r.tools, () => tools)
    }
    const bound = new Set(
      tools.flatMap((tool) => {
        const declared = (tool._meta as Record<string, unknown> | undefined)?.[PROVIDES_META]
        return Array.isArray(declared) ? declared.filter((c): c is string => typeof c === 'string') : []
      }),
    )
    const promised = manifest.provides ?? []
    const unbound = promised.filter((cap) => !bound.has(cap))
    if (promised.length > 0) {
      add(
        'provides',
        unbound.length === 0 ? 'pass' : 'warn',
        unbound.length === 0 ?
          `every declared capability is bound to a tool: ${promised.join(', ')}`
        : `declared but not bound to any tool right now: ${unbound.join(', ')}. Legitimate if it needs a download first, or if it waits on a switch nobody has turned on; a bug otherwise`,
      )
    }

    // ---- 4. stdout is the wire ---------------------------------------------------------

    // The handshake and a tools/list both round-tripped, so nothing that is not JSON-RPC
    // went to stdout. One `console.log` and neither of them would have completed.
    add('stdout-is-the-wire', 'pass', said.length > 0 ? `${String(said.length)} lines to stderr, none to stdout` : 'nothing written to stdout')

    // ---- 5. does it survive a dependency that is not there ------------------------------

    if (options.exercise !== false) {
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true)
      if (readOnly.length === 0) {
        add('degrades', 'warn', 'no read-only tool to call safely, so surviving a missing dependency was not exercised')
      } else {
        // Every capability call is refused while these run — that is what `fakeHost` does
        // with no `capability` supplied. A plugin that exits here is a plugin that takes
        // Alexia's tool list with it the first time somebody deletes its neighbour.
        for (const tool of readOnly) {
          await client
            .callTool({ name: tool.name, arguments: {} }, { timeout: options.callMs ?? 30_000 })
            .catch(() => undefined)
        }
        try {
          await client.ping({ timeout: 5_000 })
          add(
            'degrades',
            'pass',
            `still running after ${String(readOnly.length)} read-only calls with every capability refused`,
          )
        } catch {
          add('degrades', 'fail', 'it stopped answering after a call whose dependency was missing')
        }
      }
    }

    // ---- 6. everything it wrote went through the contract -------------------------------

    // The namespace half is proved by construction: `fakeHost` refuses an undeclared table
    // with the same error core does, so a plugin that got this far never wrote outside its
    // own namespace. What is left is the filesystem.
    //
    // ponytail: the sweep covers the sandbox — its own directory, and the temp directory it
    // was pointed at. A plugin that writes to a path it built itself, somewhere else on the
    // disk, is not caught here and is caught by the never-touch list and the permission
    // gate at run time instead. Widen this the day a plugin needs a second directory.
    const strays = readdirSync(sandbox, { withFileTypes: true })
      .filter((entry) => entry.name !== 'own' && entry.name !== 'tmp')
      .map((entry) => entry.name)
    const leftInTemp = readdirSync(join(sandbox, 'tmp')).length
    if (strays.length > 0) {
      add('purges-clean', 'fail', `wrote outside its own directory: ${strays.join(', ')}`)
    } else if (leftInTemp > 0) {
      // Not a failure — a temp file is a temp file — but it is residue and somebody should
      // know it exists before a user's disk fills up quietly.
      add('purges-clean', 'warn', `left ${String(leftInTemp)} file(s) in the temp directory`)
    } else {
      add('purges-clean', 'pass', 'everything it wrote is inside its namespace and its own directory')
    }

    const undeclaredDir = manifest.storage?.dir !== true && readdirSync(ownDir).length > 0
    if (undeclaredDir) {
      // It used a directory it did not declare. Purge removes it anyway — core owns the
      // path — but the library will not have told anybody it keeps files.
      add('storage-declared', 'warn', 'it wrote files without declaring `storage.dir`, so the library does not say it keeps any')
    }
  } finally {
    await transport.close().catch(() => undefined)
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  return done(manifest.id, dir, checks)
}

const done = (id: string, dir: string, checks: Check[]): Report => ({
  id,
  dir,
  ok: !checks.some((c) => c.level === 'fail'),
  checks,
})

/** The report as a person reads it. One line per check, and the verdict last. */
export function format(report: Report): string {
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' }
  const lines = report.checks.map((c) => `  ${mark[c.level]}  ${c.name.padEnd(20)} ${c.detail}`)
  const failed = report.checks.filter((c) => c.level === 'fail').length
  const warned = report.checks.filter((c) => c.level === 'warn').length
  return [
    `${report.id} — ${report.dir}`,
    ...lines,
    '',
    report.ok ?
      warned === 0 ? 'Conformant.'
      : `Conformant, with ${String(warned)} thing${warned === 1 ? '' : 's'} worth fixing.`
    : `Not conformant: ${String(failed)} failure${failed === 1 ? '' : 's'}.`,
  ].join('\n')
}
