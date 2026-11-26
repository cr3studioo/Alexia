// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { createInstaller, SOURCES } from './install.js'
import { installerEnv, SHELLS, startProcess } from './proc.js'
import { createShell, MOST_TIMEOUT_S, Refused } from './shell.js'
import { createWatches, POLL_MS } from './watch.js'

/**
 * Shell — runs commands and scripts (PowerShell on Windows, zsh on a Mac), installs programs from
 * the platform's package manager, and says when a long job finishes.
 *
 * **Only `shell_read` runs without asking**, and only a command its classifier (`classify.js`)
 * passes. Everything else is `destructiveHint` and `openWorldHint`, so the owner is asked first in
 * every mode. **Command output is never logged**, only exit codes.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do) never
 * attaches to stdio.
 */

const alexia = plugin()

const roots = async () => (await alexia.server.server.listRoots()).roots ?? []
const watches = createWatches()
const shell = createShell({ roots, watches })
const installer = createInstaller({
  exec: (file, args, opts) => startProcess({ file, args, env: installerEnv(), ...opts }).done,
})

let poller
/** Poll while something is watched, and not otherwise. */
function keepPolling() {
  if (poller || watches.size === 0) return
  poller = setInterval(() => {
    void watches.poll().finally(() => {
      if (watches.size === 0 && poller) {
        clearInterval(poller)
        poller = undefined
      }
    })
  }, POLL_MS)
  poller.unref?.()
}

const said = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Run `work`; a refusal becomes its sentence, anything else a plain one that quotes nothing. */
async function guarded(work) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message)
    log.warn(`a call failed (${error?.code ?? error?.name ?? 'error'})`)
    return refuse('That did not work.')
  }
}

/** Output as progress, at most four times a second. The text is never logged. */
function progressTo(ctx) {
  let bytes = 0
  let last = 0
  return (_stream, text) => {
    bytes += Buffer.byteLength(text)
    const t = Date.now()
    if (t - last < 250) return
    last = t
    const line = text.trim().split(/\r?\n/).at(-1) ?? ''
    try {
      alexia.progress(ctx, bytes, undefined, line.slice(0, 200))
    } catch {
      // Progress is a courtesy; the command carries on without it.
    }
  }
}

/** The answer to a finished command, for the model and as data. */
function answer(result) {
  if ('watch' in result) {
    keepPolling()
    return said(`Running in the background; I’ll say when it finishes. Watch ${result.watch}.`, { watch: result.watch })
  }
  log.info(result.timedOut ? 'a command timed out and was stopped' : `a command finished (exit ${result.exit})`)
  const head = result.timedOut ? 'It ran past its time limit and was stopped, with everything it started.' : `Exit ${result.exit}.`
  const parts = [head]
  if (result.stdout) parts.push(`Output:\n${result.stdout}`)
  if (result.stderr) parts.push(`Errors:\n${result.stderr}`)
  return {
    content: [{ type: 'text', text: parts.join('\n\n') }],
    structuredContent: { exit: result.exit, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated },
    ...(result.timedOut && { isError: true }),
  }
}

const RUN_PROPERTIES = {
  command: { type: 'string', description: 'The command or script.' },
  shell: { type: 'string', enum: SHELLS, description: 'Defaults to PowerShell on Windows and zsh on a Mac.' },
  cwd: { type: 'string', description: 'The folder to run in, a full path inside the folders the owner opened. Defaults to the first folder opened.' },
  timeout_s: { type: 'integer', minimum: 1, maximum: MOST_TIMEOUT_S, description: 'Seconds before it is stopped. Defaults to 120.' },
  watch: { type: 'boolean', description: 'Run it in the background and say when it finishes, instead of waiting.' },
  says: { type: 'string', description: 'With watch: what to call it when it finishes.' },
}

alexia.tool(
  'shell_read',
  {
    description:
      'Run a read-only command without asking: its first word must be one of Get-ChildItem, Get-Content, Get-Process, ' +
      'Get-Service, Test-Path, ls, cat, pwd, whoami, git status, git log, git diff, df, du, ps, uname, which, where, and it ' +
      'may not chain, pipe, redirect or compute anything. Anything else is refused: use shell_run.',
    inputSchema: fromJsonSchema({ type: 'object', properties: RUN_PROPERTIES, required: ['command'] }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  (args, ctx) => guarded(async () => answer(await shell.run(args, { readonly: true, signal: ctx?.mcpReq?.signal, onOutput: progressTo(ctx) }))),
)

alexia.tool(
  'shell_run',
  {
    description:
      'Run any command or script on this computer (PowerShell on Windows, zsh on a Mac) and return its exit code and ' +
      'output (each at most 64 KiB). The owner is always asked first. With watch: true it runs in the background and the ' +
      'finish arrives as a notice.',
    inputSchema: fromJsonSchema({ type: 'object', properties: RUN_PROPERTIES, required: ['command'] }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { 'alexia/provides': ['shell.run'] },
  },
  (args, ctx) => guarded(async () => answer(await shell.run(args, { signal: ctx?.mcpReq?.signal, onOutput: progressTo(ctx) }))),
)

const SOFTWARE_PROPERTIES = {
  name: { type: 'string', description: 'The program, by its exact name or package id.' },
  source: { type: 'string', enum: SOURCES, description: 'winget on Windows, brew on a Mac (the default).' },
}

alexia.tool(
  'software_install',
  {
    description:
      'Install a program from winget (Windows) or Homebrew (Mac). Only a package whose id or name is exactly name is ' +
      'installed; otherwise nothing is, and the near matches are listed with their publishers. publisher must be the ' +
      'package’s publisher, so the owner sees who made it when asked: without it, nothing is installed and the answer ' +
      'says who the publisher is. Always asks first. Not supported on other systems.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...SOFTWARE_PROPERTIES,
        publisher: { type: 'string', description: 'Who publishes the package, as an earlier software_install answer said.' },
      },
      required: ['name'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { 'alexia/provides': ['software.install'] },
  },
  (args, ctx) =>
    guarded(async () => {
      const done = await installer.install(args, { signal: ctx?.mcpReq?.signal, onOutput: progressTo(ctx) })
      log.info('a program was installed')
      return said(`Installed ${done.installed} ${done.version}, published by ${done.publisher}.`, done)
    }),
)

alexia.tool(
  'software_search',
  {
    description: 'Look a program up in winget (Windows) or Homebrew (Mac): names, ids and versions. Installs nothing.',
    inputSchema: fromJsonSchema({ type: 'object', properties: SOFTWARE_PROPERTIES, required: ['name'] }),
    // It asks the package catalogue online, so it is open-world although it changes nothing.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  (args, ctx) =>
    guarded(async () => {
      const { results } = await installer.search(args, { signal: ctx?.mcpReq?.signal })
      const text = results.length ? results.map((r) => `- ${r.name} (${r.id}) ${r.version}`.trim()).join('\n') : 'Nothing found.'
      return said(text, { results })
    }),
)

alexia.tool(
  'job_watch',
  {
    description:
      'Keep an eye on a running process (pid) or a log file (file) and say when it finishes. A file is finished when it ' +
      'has not grown for 60 seconds, or when a new line matches done_when. This never starts anything: to run a command ' +
      'and be told when it finishes, use shell_run with watch: true.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        pid: { type: 'integer', minimum: 1, description: 'A running process.' },
        file: { type: 'string', description: 'A file inside the folders the owner opened, as a full path.' },
        says: { type: 'string', description: 'What to call it when it finishes.' },
        done_when: { type: 'string', description: 'With file: a regular expression; a line matching it means finished.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { 'alexia/provides': ['job.watch'] },
  },
  (args) =>
    guarded(async () => {
      const says = typeof args?.says === 'string' && args.says.trim() ? args.says.trim() : undefined
      const hasPid = args?.pid !== undefined && args?.pid !== null
      const hasFile = typeof args?.file === 'string' && args.file !== ''
      if (hasPid === hasFile) return refuse('Give exactly one of pid or file.')
      let watch
      try {
        watch = hasPid ? watches.pid(args.pid, { says }) : await watches.file(await shell.file(args.file), { says, doneWhen: args.done_when })
      } catch (error) {
        if (error instanceof Refused) throw error
        throw new Refused(error.message)
      }
      keepPolling()
      return said(`Watching. I’ll say when it finishes (watch ${watch}).`, { watch })
    }),
)

alexia.tool(
  'job_unwatch',
  {
    description: 'Stop a watch. A command started with watch: true is stopped too, with everything it started.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { watch: { type: 'string', description: 'The watch, as job_watch or shell_run gave it.' } },
      required: ['watch'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  (args) =>
    guarded(async () => {
      const gone = await watches.unwatch(String(args?.watch ?? ''))
      return said(gone ? 'Stopped watching.' : 'There is no such watch.', { stopped: gone })
    }),
)

alexia.tool(
  'notice_items',
  {
    description: 'Jobs being watched that have finished in the last day.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'Not used.' },
        tz_offset_min: { type: 'number', description: 'Not used.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  () => {
    const items = watches.noticeItems()
    return said(items.map((i) => `- ${i.text}`).join('\n'), { items })
  },
)

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point (argv[1] resolved through links, as Node resolves import.meta.url). */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
