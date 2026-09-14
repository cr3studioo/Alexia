// SPDX-License-Identifier: AGPL-3.0-only
import * as mac from './macos.js'
import * as win from './windows.js'

/**
 * The desktop this plugin drives, whichever one it is running on (D148).
 *
 * `windows.js` and `macos.js` export the same calls — `screenshot`, `click`, `type`, `key`,
 * `elements`, `invoke` and the rest — plus the two sentences that cannot be shared, which are
 * how a key combination is written. Everything above this file asks `desktop` and never which.
 *
 * **It imports the two backends and nothing else**, and they import only `node:` modules. That
 * is not tidiness: `replay.js` promises that a saved plan cannot reach a model, and its test
 * proves it by walking these imports. A third import here would be a hop that test has to see.
 */
export const desktop = mac.supported() ? mac : win
