// SPDX-License-Identifier: AGPL-3.0-only
// `node --test plugins/file-finder/test` (Node 24) runs a directory argument as a module and
// resolves it to this file, so this file brings in every test. `pnpm test` (vitest) picks the
// `*.test.js` files up directly and never loads this one. A new test file is added to this list.
import './load.test.js'
import './finder.test.js'
import './tools.test.js'
