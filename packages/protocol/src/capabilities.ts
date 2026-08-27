// SPDX-License-Identifier: Apache-2.0

/**
 * Capabilities: dotted names that stand for *a thing that can be done*, with no plugin
 * attached. `docs/spec/capabilities.md` is the document; a test diffs it against this file.
 *
 * Two kinds, one syntax, resolved completely differently — confusing them is the main way
 * to get this wrong:
 *
 * - a **permission** is something core grants, from the fixed list below, and a plugin
 *   asking for a name that is not on it does not install;
 * - a **service** is something another plugin provides, resolved at runtime by
 *   `alexia/capability/call`, and answered by whichever plugin offers it.
 */

/**
 * The complete permission registry. Core defines every one of these, which is exactly why
 * the list is closed: a plugin cannot widen what it may ask for by inventing a name.
 */
export const PERMISSIONS = [
  'fs.own_dir',
  'fs.read_scoped',
  'fs.write_scoped',
  'net.download',
  'net.request',
  'audio.input',
  'audio.output',
  'screen.capture',
  'input.control',
  'proc.spawn',
  'notify',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const isPermission = (cap: string): cap is Permission =>
  (PERMISSIONS as readonly string[]).includes(cap)

/**
 * The `_meta` key a tool uses to say which capabilities it answers.
 *
 * The manifest's `provides` is the static declaration — what the library shows and what
 * another plugin's `requires` resolves against. This is the runtime binding, and it is on
 * the tool rather than in the manifest for the same reason tools are not in the manifest:
 * a plugin with no model downloaded yet cannot answer `voice.transcribe`, and should not
 * claim to until it can.
 */
export const PROVIDES_META = 'alexia/provides'
