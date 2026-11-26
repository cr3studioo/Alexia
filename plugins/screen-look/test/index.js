// SPDX-License-Identifier: AGPL-3.0-only
// `node --test plugins/screen-look/test` (Node 24) runs a directory argument as a module and
// resolves it to this file, so this file brings in every test. `pnpm test` (vitest) picks the
// `*.test.js` files up directly and never loads this one. A new test file is added to this list.
import './load.test.js'
import './look.test.js'
import './png.test.js'
import './locate.test.js'
import './wire.test.js'
