// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { bundlePlugin } from '../../../scripts/bundle-plugin.mjs'
import { Plugins } from '../../../packages/core/src/plugins.js'
import { PluginTooling } from '../../../packages/core/src/tooling.js'
import { Skills } from '../../../packages/core/src/skills.js'
import { Store } from '../../../packages/core/src/store.js'
import { memorySecrets } from '../../../packages/core/src/secrets.js'

test('installed research exposes its tool and research guidance without downloading a runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alexia-research-discovery-'))
  const provider = join(root, 'extensions', 'web-research')
  const store = new Store(':memory:')
  const plugins = new Plugins({ dir: join(root, 'extensions'), dataDir: root, store, secrets: memorySecrets() })
  try {
    const manifest = await bundlePlugin(fileURLToPath(new URL('../../../', import.meta.url)), 'web-research', provider)
    plugins.load()
    const skills = new Skills({ dir: join(root, 'skills'), store, bundled: () => plugins.enabled(manifest.id) ? manifest.skills.map((path) => ({ dir: join(provider, path), pluginId: manifest.id })) : [] })
    expect(skills.tool).toBeUndefined()
    plugins.enable(manifest.id)
    skills.invalidate()
    const tools = await new PluginTooling(plugins, undefined, skills).list()
    expect(tools.find((tool) => tool.name === 'web-research__research')).toMatchObject({ parameters: { required: ['query'] } })
    expect(tools.find((tool) => tool.name === 'skill')?.description).toContain('web-research: Use when the user asks to research')
    expect(skills.all.find((skill) => skill.name === 'web-research')).toMatchObject({ pluginId: manifest.id, live: true })
    expect(existsSync(join(plugins.ownDir(manifest.id), 'runtime'))).toBe(false)
  } finally {
    await plugins.stop()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
