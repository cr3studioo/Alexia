import { globSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

export interface SourceFile {
  /** Repo-relative, forward slashes, on every platform. */
  path: string
  text: string
}

/** Every file matching `patterns`, node_modules and build output excluded. */
export function files(patterns: string[]): SourceFile[] {
  return globSync(patterns, {
    cwd: repoRoot,
    exclude: (p) => p.includes('node_modules') || p.includes(`${sep}dist${sep}`),
  })
    .map((p) => p.split(sep).join(posix.sep))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }))
}

/**
 * Hand-written TypeScript that ships. Deliberately `src/` only: the invariant checks
 * themselves quote the very literals they forbid, and a check that fails on its own
 * source is a check nobody keeps.
 */
export const shippedSource = [
  'packages/*/src/**/*.ts',
  'packages/*/src/**/*.tsx',
  'plugins/*/src/**/*.ts',
  'plugins/*/*.ts',
  // The first-party plugins are shipped source and they are written in JavaScript, which
  // means every check in this folder had been reading past them. Top level only, so the
  // glob does not walk into `node_modules`.
  'plugins/*/*.js',
  'registry/src/**/*.ts',
]

/** `path:line  text` for every line matching `pattern`. Reads as a failure message. */
export function hits(f: SourceFile, pattern: RegExp): string[] {
  return f.text
    .split('\n')
    .flatMap((line, i) => (pattern.test(line) ? [`${f.path}:${i + 1}  ${line.trim()}`] : []))
}

/** Every hit across every file. */
export function scan(patterns: string[], pattern: RegExp): string[] {
  return files(patterns).flatMap((f) => hits(f, pattern))
}
