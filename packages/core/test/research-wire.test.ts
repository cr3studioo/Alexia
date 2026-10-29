// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { PluginTooling } from '../src/tooling.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-research-wire-'))
const dir = join(root, 'extensions'); const provider = join(dir, 'evidence-provider')
mkdirSync(provider, { recursive: true })
writeFileSync(join(provider, 'plugin.json'), JSON.stringify({ manifest_version: 1, id: 'evidence-provider', name: 'Evidence', summary: 'Wire fixture', version: '1.0.0', license: 'MIT', alexia_protocol: 15, mcp_protocol: '2025-11-25', entry: { run: 'node', args: ['index.js'] }, panel: { label: 'Evidence', widgets: [{ type: 'research', key: 'viewer', label: 'Research' }] } }))
const sdk = pathToFileURL(join(import.meta.dirname, '../../sdk/dist/src/index.js')).href
writeFileSync(join(provider, 'index.js'), `
import { plugin, CALL_CONTEXT_META, FINAL_META } from ${JSON.stringify(sdk)}
const a = plugin()
a.tool('gather', { description: 'Gather test evidence.', annotations: {readOnlyHint:true,openWorldHint:false} }, async (ctx) => {
 const conversationId = ctx.mcpReq._meta[CALL_CONTEXT_META].conversationId
 const research = {runId: 'run-' + conversationId, conversationId, sequence:1, topic:'Question', startedAt:Date.now(), elapsedMs:0, stage:'reading', sources:[{id:'S1',url:'https://example.org/',title:'Example',state:'complete',passages:[{id:'P1',text:'Exact evidence.'}]}], counters:{read:44,inProgress:0,failed:0}, completion:'running',gaps:[]}
 a.progress(ctx,1,undefined,'Reading',{research})
 await a.server.server.ping()
 research.sequence=2; research.stage='finished'; research.completion='complete'
 a.progress(ctx,2,undefined,'Finished',{research})
 await a.server.server.ping()
 return {content:[{type:'text',text:'One sourced answer.'}],_meta:{[FINAL_META]:'One sourced answer.'}}
})
await a.start()
`)
const store = new Store(':memory:')
const plugins = new Plugins({ dir, store, dataDir: root, secrets: memorySecrets() })
plugins.load(); plugins.enable('evidence-provider')
const tooling = new PluginTooling(plugins)
afterAll(async () => { await plugins.stop(); store.close(); rmSync(root, { recursive: true, force: true }) })

test('typed SDK updates cross real MCP even without an open viewer or progress listener, and final avoids a second pass', async () => {
  const result = await tooling.call('evidence-provider__gather', {}, undefined, undefined, { conversationId: 'chat-1' })
  expect(result).toMatchObject({ ok: true, final: 'One sourced answer.' })
  expect(tooling.research.get('evidence-provider', 'chat-1')).toMatchObject({ runId: 'run-chat-1', sequence: 2, completion: 'complete', counters: { read: 1, inProgress: 0, failed: 0 } })
  expect(tooling.active('evidence-provider')).toBe(false)
  const second = await tooling.call('evidence-provider__gather', {}, undefined, undefined, { conversationId: 'chat-2' })
  expect(second.ok).toBe(true)
  expect(tooling.research.get('evidence-provider', 'chat-2')?.runId).toBe('run-chat-2')
  expect(tooling.research.get('evidence-provider', 'chat-1')?.runId).toBe('run-chat-1')
})
