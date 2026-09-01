// SPDX-License-Identifier: Apache-2.0

/**
 * The version of Alexia itself, written once (D118).
 *
 * **Three files used to say it and none of them was the source.** `Cargo.toml`, the Tauri
 * config and this constant all carry a version number, because each is read by something
 * that cannot import the others — cargo, the bundler, and core. So one of them is the
 * source and the rest are copies, and invariant `12-version-in-step` is what makes the
 * copies true rather than hopeful.
 *
 * **It is not decoration now that plugins are distributed separately** (D118). A plugin
 * release declares `min_app`, the shelf hides anything this build cannot run, and the app
 * updater compares what it finds on the release against this string. Get it wrong and a
 * user is offered a plugin that will not load, or offered an update they already have.
 *
 * Bump it in this file, run `pnpm invariants`, and the check names the two files that have
 * fallen behind.
 */
export const APP_VERSION = '0.3.0'

/**
 * Is `candidate` a later version than `installed`?
 *
 * Numeric, part by part, because `0.10.0` is later than `0.9.0` and a string comparison
 * says the opposite. A pre-release suffix is ignored rather than ordered: full semver
 * precedence is a page of rules to decide whether `1.0.0-rc.2` beats `1.0.0-rc.10`, and the
 * rule a publisher is actually held to is simply that a new release bumps a number.
 *
 * It lives here rather than in the library because three things now compare versions — the
 * shelf, the app updater and the compatibility gate below — and two copies of a comparison
 * are two chances to disagree about what `0.10.0` means.
 */
export function newer(candidate: string, installed: string): boolean {
  const parts = (v: string): number[] => v.split('-')[0]!.split('.').map((n) => Number(n) || 0)
  const [a, b] = [parts(candidate), parts(installed)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/**
 * Whether this Alexia is inside the app-version range a plugin declared (D118).
 *
 * **The half of compatibility that `alexia_protocol` cannot express.** The protocol integer
 * says which shape of the contract a plugin speaks; it says nothing about a capability that
 * arrived in a particular build, a bug fixed in one, or a route added last week. A plugin
 * author knows which Alexia they tested against, and `min_app` is the field where they say
 * so — checked here, before the download, so the answer to *why is this not on my shelf*
 * is a sentence rather than a plugin that installs and then refuses to load.
 *
 * Absent means *any*, which is what almost every plugin should say: a range is a promise
 * to keep, and narrowing one that did not need narrowing is how a shelf empties itself.
 */
export function withinApp(
  wants: { min_app?: string; max_app?: string },
  app: string = APP_VERSION,
): boolean {
  if (wants.min_app !== undefined && newer(wants.min_app, app)) return false
  if (wants.max_app !== undefined && newer(app, wants.max_app)) return false
  return true
}
