// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { ManifestShape } from './manifest.js'

/** Where the generated schema lives, relative to the repo root. */
export const SCHEMA_PATH = ['docs', 'spec', 'plugin.schema.json'] as const

/**
 * The JSON Schema an editor validates `plugin.json` against as it is typed.
 *
 * Generated from {@link ManifestShape}, which is deliberately the layer *without* the
 * cross-field rules — JSON Schema cannot express "the choice default is one of the
 * options", and a schema that silently dropped the rule would be worse than one that
 * never claimed it. Those rules live in `Manifest` and run at load.
 */
export function pluginJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://alexia.dev/schema/plugin.schema.json',
    title: 'Alexia plugin.json v1',
    ...z.toJSONSchema(ManifestShape, { io: 'input' }),
  }
}
