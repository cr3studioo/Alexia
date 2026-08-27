// SPDX-License-Identifier: Apache-2.0

/**
 * The logger, and the reason this file exists at all.
 *
 * **stdout is the wire.** One `console.log` in a plugin corrupts the JSON-RPC stream and
 * Alexia drops the plugin — so the obvious thing to reach for has to be the correct thing.
 * This is it: every level goes to stderr, which Alexia captures, tags with your plugin id,
 * and shows in your plugin's log panel. You lose nothing by using it.
 */
const write = (level: string, args: unknown[]): void => {
  // `console.error` is stderr, which is the whole requirement. No dependency earns its place
  // here: a plugin ships what it imports, and this is four lines.
  console.error(`[${level}]`, ...args)
}

export const log = {
  debug: (...args: unknown[]): void => write('debug', args),
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args),
}
