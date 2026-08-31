// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { APP_VERSION } from '@alexia/protocol'
import { repoRoot } from './_repo.js'

// Defends: the app has one version, and three files say it (D118, D119).
//
// Not one of the ten — those are about the plugin contract and what survives a folder being
// deleted, and this is bookkeeping. It is bookkeeping with teeth, though, and the teeth are
// why it is a test rather than a habit. Since plugins are distributed on their own schedule,
// the version is load-bearing in three places at once:
//
//   * a plugin release declares `min_app`, and the shelf hides anything this build is under;
//   * the updater compares `latest.json`'s version against the one compiled into the binary;
//   * `versionVerdict` refuses to load a plugin that needs a newer Alexia, by name.
//
// Cargo writes the version into the executable and the Tauri config writes it into the
// installer, so the number the updater compares against is theirs, not `APP_VERSION`'s. Three
// copies with no check between them is a release where the shelf and the updater disagree
// about which Alexia this is — the kind of bug that is invisible until somebody's update
// silently stops being offered.

const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')

test('version-in-step: Cargo.toml carries the version APP_VERSION declares', () => {
  const found = /^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1]
  expect(found, `src-tauri/Cargo.toml says ${String(found)}, APP_VERSION says ${APP_VERSION}`).toBe(APP_VERSION)
})

test('version-in-step: the Tauri config carries it too', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json')) as { version?: string }
  expect(config.version, `tauri.conf.json says ${String(config.version)}`).toBe(APP_VERSION)
})

test('version-in-step: the lockfile is not left behind', () => {
  // Cargo rewrites this on the next build, which is exactly the problem: a lockfile that
  // disagrees is a diff nobody reviewed turning up in the release commit.
  const found = /name = "alexia"\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'))?.[1]
  expect(found, `src-tauri/Cargo.lock says ${String(found)}`).toBe(APP_VERSION)
})

test('version-in-step: the updater has a key to check signatures against', () => {
  // An empty `pubkey` parses, ships, and then refuses every update on every machine with a
  // signature error — the failure mode this file exists to make impossible, because nobody
  // finds out until the first update after a release.
  const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
    plugins?: { updater?: { pubkey?: string; endpoints?: string[] } }
  }
  const updater = config.plugins?.updater
  expect(updater?.pubkey ?? '', 'tauri.conf.json has no updater pubkey — `tauri signer generate`').not.toBe('')
  expect(updater?.endpoints ?? [], 'the updater has nowhere to look').not.toEqual([])
})
