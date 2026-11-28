// SPDX-License-Identifier: AGPL-3.0-only
// `node --test plugins/browser-pilot/test` (Node 24) runs a directory argument as a module
// and resolves it to this file, so this file brings in every test. `pnpm test` (vitest) picks
// the `*.test.js` files up directly and never loads this one.
import './load.test.js'
import './socket.test.js'
import './pilot.test.js'
