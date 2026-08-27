// SPDX-License-Identifier: Apache-2.0
// Regenerates the editor-facing JSON Schema. Run: pnpm --filter @alexia/protocol gen:schema
// A test asserts the checked-in file still matches, so this cannot quietly rot.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginJsonSchema, SCHEMA_PATH } from '../src/json-schema.js'

const out = join(import.meta.dirname, '..', '..', '..', ...SCHEMA_PATH)
writeFileSync(out, JSON.stringify(pluginJsonSchema(), null, 2) + '\n')
console.error(`wrote ${out}`)
