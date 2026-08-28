// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Getting a program onto this machine, and running it once it is here.
 *
 * Two things need this — Whisper for hearing and Piper for speaking — and they need exactly
 * the same four moves: fetch a large file while saying how far along it is, unpack it, find
 * what came out, and spawn it. So it is written once, here, rather than twice with one copy
 * quietly diverging.
 *
 * Everything in this file happens **inside the plugin process**. That is the whole point:
 * the binaries are spawned here, the microphone is opened here, and what crosses the wire
 * to core is text.
 */

/** Whether a file is there and is not an empty stub left by something that went wrong. */
export const there = async (path) => {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/**
 * One file, streamed to disk, with the length checked at the end.
 *
 * A truncated model is the failure that actually happens on a domestic connection, and it
 * does not announce itself — the runtime loads half a file and says something about tensors
 * instead of something about the network. Checking the length turns that into one sentence.
 *
 * ponytail: length only, no checksum. Checksums and signatures are M3-7, and that is where
 * the published digests and the verification path belong; this catches the dropped
 * connection, not a hostile mirror.
 */
export async function fetchTo(url, to, onProgress) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let done = 0
  const partial = `${to}.part`

  await pipeline(
    async function* () {
      for await (const chunk of Readable.fromWeb(response.body)) {
        done += chunk.byteLength
        onProgress?.(done, total)
        yield chunk
      }
    },
    createWriteStream(partial),
  )
  if (total > 0 && done !== total) {
    await rm(partial, { force: true })
    throw new Error(`${url} stopped after ${mb(done)} of ${mb(total)} MB`)
  }
  // Renamed only once it is whole, so a download killed halfway is not mistaken for a file.
  await rename(partial, to)
}

/**
 * The archiver, and on Windows the *right* one.
 *
 * Windows 10 and later ship bsdtar as `System32\tar.exe`, and it reads zip — so there is no
 * zip parser here and no dependency for one, which matters more than the line count because
 * a zip parser is a parser and this one would be reading a file off the internet.
 *
 * What is on `PATH` may not be that tar. Git for Windows puts GNU tar there, which cannot
 * read zip **and** reads a drive-lettered path as `host:path` — so it fails trying to resolve
 * a hostname one letter long, which is a confusing way to learn any of this. Asking the OS
 * for its own copy is one line and removes both problems.
 */
const archiver = () => {
  const root = process.env.SystemRoot
  return process.platform === 'win32' && root ? join(root, 'System32', 'tar.exe') : 'tar'
}

export function extract(archive, to) {
  return new Promise((resolve, reject) => {
    const tar = spawn(archiver(), ['-xf', archive, '-C', to], { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    tar.stderr?.on('data', (chunk) => (said += String(chunk)))
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`could not unpack ${archive}: ${said.trim() || `tar exited ${code}`}`)),
    )
  })
}

/**
 * Look for these names in a folder and two levels under it.
 *
 * The archives nest, and how they nest is the release's business — it has changed before.
 * One shallow walk over a folder holding thirty files costs nothing and survives the day
 * somebody renames `Release/`.
 */
export async function find(dir, names) {
  const found = {}
  const look = async (at, depth) => {
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth > 0) await look(join(at, entry.name), depth - 1)
      else if (names.includes(entry.name)) found[entry.name] ??= join(at, entry.name)
    }
  }
  await look(dir, 2)
  return found
}

/**
 * Spawn, collect stdout, and turn a non-zero exit into the sentence stderr ended on.
 *
 * The last line rather than the whole of stderr, because these programs narrate their model
 * loading at length and then say the useful thing once, at the end.
 */
export function run(program, args, { input, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      signal,
      ...(env && { env: { ...process.env, ...env } }),
    })
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(lastLine(said) || `${program} exited ${code}`)),
    )
    if (input !== undefined) child.stdin.end(input)
  })
}

/** What a program that failed said last, which is almost always the useful part. */
export const lastLine = (text) => text.trim().split('\n').at(-1)?.trim() ?? ''

export const mb = (bytes) => Math.round(bytes / 1e5) / 10
