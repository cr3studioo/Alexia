// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { extname, dirname } from 'node:path'
import type { Produced } from './agent.js'

/**
 * **Files a tool made, on their way to the person who asked for them.**
 *
 * `attach.ts` is the other direction and this is the mirror of it: there, bytes arrive from
 * the composer, are read, and are thrown away; here, a plugin has written something and the
 * shell needs to be able to open, save, find or copy it. The two never meet — an upload is
 * gone by the time an answer starts — but the shape of the argument is the same one, which is
 * that **the file is core's to hand over and the making of it is a plugin's**.
 *
 * The whole security design is one sentence: **no route here ever accepts a path.** The shell
 * is handed an opaque id and can ask for exactly the files some tool offered it during this
 * run of core, and nothing else. That is structural rather than validated — there is no path
 * to traverse out of, no prefix to check, and no `..` to normalise, because the string a
 * caller sends is a key into a map and is never joined to anything. It is the same shape as
 * `read_region(target)` never being `ocr_screen()`: a call that cannot express the dangerous
 * request does not need to refuse it.
 */

/** One file, as the shell learns about it. The path is shown; it is never accepted back. */
export interface Offer extends Produced {
  id: string
}

/**
 * How many are reachable at once, oldest dropped first.
 *
 * A long session generating pictures would otherwise hold a row per file forever. Dropping
 * the oldest means a link far enough up the conversation eventually stops working, which is
 * the honest trade: the file is still on disk where the answer said it is, and *copy path*
 * is what still works when this does not.
 */
const MOST = 500

/**
 * Everything a tool has handed back, for as long as core is up.
 *
 * Deliberately **not** persisted. A row that survives a restart would be a promise about a
 * file core has not looked at since — deleted, moved, or on a drive that is no longer
 * plugged in — and a dead download button is worse than none. The conversation keeps what
 * was said, including the path; this keeps only what is still live.
 */
export class Offers {
  readonly #byId = new Map<string, Offer>()

  /** Register what one step produced, and give back what the shell should draw. */
  keep(files: readonly Produced[]): Offer[] {
    const kept = files.map((file) => {
      // Sixteen random bytes. Unguessable matters less than it looks — the server is on
      // loopback behind a token — but an id derived from the path would leak the path to
      // anything that saw a URL, and there is no reason to.
      const id = randomBytes(16).toString('hex')
      const offer: Offer = { ...file, id }
      this.#byId.set(id, offer)
      return offer
    })
    for (const id of [...this.#byId.keys()].slice(0, Math.max(0, this.#byId.size - MOST))) {
      this.#byId.delete(id)
    }
    return kept
  }

  /** The file behind an id, or nothing. The only way any of these is ever named again. */
  get(id: unknown): Offer | undefined {
    return typeof id === 'string' ? this.#byId.get(id) : undefined
  }
}

/**
 * What a browser should call it, from the name alone.
 *
 * Short on purpose. This decides whether the shell previews something inline and what a
 * saved file is called; it is not a content sniffer and it does not need to be, because
 * whatever wrote the file knows what it wrote and can say so in the `resource_link`. This is
 * the fallback for the ones that do not bother.
 */
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml', html: 'text/html',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const mimeOf = (name: string): string =>
  TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'

/**
 * The extensions **Open** will not open, and an honest account of what that is worth.
 *
 * Opening a file means handing it to whatever the operating system has registered for it,
 * and for these that means *running it*. The escalation this stops is real and specific: a
 * plugin holding no `proc.spawn` writes `invoice.pdf.bat`, offers it, and a person presses a
 * button labelled *Open* — which is a plugin running a program through a permission it was
 * never granted, using the user's own click as the grant.
 *
 * **ponytail: this is a deny list, and deny lists forget.** It is not the load-bearing half
 * and it is not pretended to be. What actually holds is above — the id map, so only a file
 * some tool offered in this session can be named at all — and the `confirm` on the route in
 * `guard.ts`. This is the third layer, it will be out of date the day some format gains an
 * exploit, and *Show in folder* stays available for everything it refuses, so nothing here
 * is a dead end: the person can still get to the file, in their own file manager, and decide
 * for themselves.
 */
const EXECUTABLE = new Set([
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'msc', 'cpl', 'dll', 'sys', 'drv',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'wsf', 'wsh', 'js', 'jse', 'hta',
  'jar', 'lnk', 'url', 'scf', 'reg', 'inf', 'gadget', 'appref-ms',
  'app', 'command', 'sh', 'bash', 'zsh', 'run', 'appimage', 'deb', 'rpm', 'pkg', 'dmg',
])

/** Whether **Open** will hand this to the operating system. `false` is not a dead end. */
export const openable = (name: string): boolean => !EXECUTABLE.has(extname(name).slice(1).toLowerCase())

/**
 * Hand a file to the desktop: open it, or show it where it lives.
 *
 * **Arguments as an array, never a command line.** Every one of these takes a path that came
 * from a plugin, and a shell in the middle would make that path something a filename with a
 * quote or an ampersand in it could break out of. `spawn` with an argument array does not
 * involve a shell at all, so there is nothing to escape and nothing to get wrong.
 *
 * Core spawning something that is not a plugin is not new — `library.ts` spawns the system
 * `tar` to unpack a download — but it is rare enough to say why: the shell is a web page, a
 * web page cannot open a file on the machine it is drawn on, and core is the only part of
 * Alexia that is both local and listening.
 */
export function reach(path: string, how: 'open' | 'reveal'): void {
  const [program, args] =
    process.platform === 'win32' ?
      // `explorer` exits 1 on success, which is why nothing here reads an exit code.
      ['explorer.exe', how === 'reveal' ? [`/select,${path}`] : [path]]
    : process.platform === 'darwin' ? ['open', how === 'reveal' ? ['-R', path] : [path]]
    : ['xdg-open', [how === 'reveal' ? dirname(path) : path]]

  // Detached and ignored: this outlives the request, and a viewer somebody leaves open for
  // an hour must not be holding core's pipes open behind it.
  const child = spawn(program, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    // Nothing to say to anybody here. The route has already answered, and a desktop with no
    // `xdg-open` on it is a machine where this button was never going to work.
  })
  child.unref()
}
