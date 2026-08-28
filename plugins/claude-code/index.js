// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

/**
 * Claude Code (M4-7, D53) — built, shipped **off**, and never auto-enabled.
 *
 * The reasoning, stated rather than buried, because it is the only plugin here with a
 * question hanging over it:
 *
 * Anthropic's Consumer Terms bar reaching the service "through automated or non-human
 * means" except via an API key or where otherwise permitted, and bar commercial use of a
 * consumer subscription. Cutting the other way, `claude setup-token` is an Anthropic-shipped
 * feature explicitly for non-interactive use, and a person driving their own installed CLI
 * with their own credentials is ordinary use of a tool they were given.
 *
 * So: it exists, it is disabled by default, **the user runs `claude setup-token`
 * themselves** — this plugin never touches a credential and never sees one — and enabling it
 * says all of that in plain words. Written confirmation from Anthropic is sought before this
 * is enabled in any public release.
 *
 * The other decision worth naming: it detects a missing `claude` binary **at enable time**
 * and says so on its own settings pane, rather than failing on first use. A plugin that
 * looks installed and fails the first time somebody relies on it is worse than one that
 * says it is not set up.
 */

const alexia = plugin()

const settings = () => alexia.settings()

const NOTICE = [
  'This runs the Claude Code program already installed on this machine, with your own login.',
  'Alexia never sees or stores a credential for it — you sign in with `claude setup-token` yourself.',
  'It is off by default and Alexia will not turn it on.',
].join(' ')

/** Where the program is: what the user pointed at, or `claude` on the PATH. */
async function program() {
  const { claude_path: pointed } = await settings()
  const said = String(pointed ?? '').trim()
  if (said !== '') return existsSync(said) ? said : undefined
  return 'claude'
}

/**
 * Is it actually there?
 *
 * `--version` rather than `which`: it is one call that answers *is it on the PATH*, *is it
 * executable* and *is it a working install* at once, and the three fail together often
 * enough that separating them buys nothing.
 */
function version(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' })
    let out = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? out.trim() : undefined))
  })
}

/** The folder it may work in, checked for being one. */
async function project() {
  const { project_dir: dir } = await settings()
  const said = String(dir ?? '').trim()
  if (said === '') return { why: 'No project folder is set, so there is nowhere for it to work.' }
  try {
    if (!statSync(said).isDirectory()) return { why: `${said} is not a folder.` }
  } catch {
    return { why: `${said} is not there.` }
  }
  return { dir: said }
}

async function report() {
  const command = await program()
  const found = command === undefined ? undefined : await version(command)
  const where = await project()
  const state =
    found === undefined ?
      '▲ The claude program is not on this machine. Install Claude Code, then sign in with: claude setup-token'
    : 'why' in where ? `▲ ${where.why}`
    : `● Ready — ${found}`
  await alexia.status('state', state).catch(() => {})
  // Only when both halves are true. A capability that is answerable half the time is a
  // capability whose caller has to handle the other half anyway.
  coded.update({ _meta: found !== undefined && !('why' in where) ? { 'alexia/provides': ['code.task'] } : {} })
  return { found, where }
}

const coded = alexia.tool(
  'task',
  {
    description:
      'Hand a coding job to Claude Code in the project folder the user configured: writing, ' +
      'changing, reviewing or explaining code across files. Use for work that spans more than ' +
      'one file or needs to run commands in a repository. It edits files on disk.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What to do, in full. This is passed straight through as the instruction.',
        },
      },
      required: ['task'],
    }),
    // It edits files and runs commands in a repository. There is no honest annotation for
    // that but this one, and the prompt it produces is correct rather than inconvenient.
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ task }, ctx) => {
    const { found, where } = await report()
    if (found === undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Claude Code is not installed on this machine, so there is nothing to hand this to. ' + NOTICE,
          },
        ],
      }
    }
    if ('why' in where) return { isError: true, content: [{ type: 'text', text: where.why }] }

    const { timeout_minutes: minutes } = await settings()
    const command = await program()
    const said = String(task ?? '').trim()
    if (said === '') return { isError: true, content: [{ type: 'text', text: 'There was no task.' }] }

    const started = Date.now()
    try {
      const out = await runIt(command, said, where.dir, (Number(minutes) || 10) * 60_000, ctx?.mcpReq?.signal)
      await alexia.storage
        .insert('runs', { task: said.slice(0, 500), dir: where.dir, ms: Date.now() - started, at: started })
        .catch(() => {})
      return { content: [{ type: 'text', text: out || 'It finished and said nothing.' }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }
    }
  },
)

/**
 * One run, non-interactive.
 *
 * `-p` is the print mode Claude Code ships for exactly this: one instruction in, the answer
 * out, no terminal UI. The task goes on **stdin** rather than in the argument list — an
 * instruction is prose, prose contains quotes and newlines, and a shell is the wrong place
 * to be quoting either.
 */
function runIt(command, task, cwd, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-p'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      ...(signal && { signal }),
    })
    let out = ''
    let err = ''
    const giveUp = setTimeout(() => {
      child.kill()
      reject(new Error(`Claude Code did not finish within ${Math.round(timeoutMs / 60_000)} minutes, so it was stopped.`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    child.on('error', (error) => {
      clearTimeout(giveUp)
      reject(new Error(`Could not run ${command}: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(giveUp)
      if (code === 0) resolve(out.trim())
      // Its own last line, which for a signed-out CLI is the one that says so.
      else reject(new Error(err.trim().split('\n').at(-1) || `Claude Code exited ${code}`))
    })
    child.stdin.end(task)
  })
}

alexia.tool(
  'available',
  {
    description: 'Say whether Claude Code is installed and set up on this machine. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const { found, where } = await report()
    const text =
      found === undefined ? `Not installed. ${NOTICE}`
      : 'why' in where ? `${found} is installed, but ${where.why.toLowerCase()}`
      : `${found}, working in ${where.dir}.`
    return { content: [{ type: 'text', text }] }
  },
)

await alexia.start()
await report()
alexia.onSettingsChanged((changed) => {
  if ('claude_path' in changed || 'project_dir' in changed) void report()
})
// Said once, in the log, at the moment somebody enabled it — which is the moment they are
// looking at this plugin's pane.
log.info(NOTICE)
