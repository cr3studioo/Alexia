// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three D1 methods this registry uses, declared here rather than installed.
 *
 * `@cloudflare/workers-types` is 400 KB of ambient declarations for a surface this file
 * uses eleven lines of. The binding is stable, it is documented, and a wrong shape here is
 * a type error on the first query rather than a silent runtime one.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ success: boolean }>
}

export interface D1Database {
  prepare(sql: string): D1Statement
  exec(sql: string): Promise<unknown>
}

export interface Env {
  DB: D1Database
  /**
   * The one credential, and the reason there is no account system: the only person who
   * writes to this registry is the person who runs it. A missing token means nothing can
   * be written at all, which is the safe way for a misconfigured deploy to fail.
   */
  ADMIN_TOKEN?: string
}
