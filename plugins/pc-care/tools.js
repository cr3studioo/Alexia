// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema } from '@alexia/sdk'
import { CHECKS, SETTINGS } from './care.js'
import { ACTIONS, MOST_S } from './power.js'

/**
 * One tool per capability, shaped to the contracts in `docs/spec/capabilities.md`, and
 * `power_cancel`. `parts` is undefined on a computer this cannot work on: the tools then say so,
 * and claim no capability.
 *
 * The annotations are what permissions are decided from. One tool has one set of them, so
 * `system_care` is destructive although its reports change nothing, and `power_do` is destructive
 * although locking loses nothing.
 */

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function registerTools(alexia, parts) {
  function tool(name, cap, config, work) {
    const handler = async (...given) => {
      if (!parts) return refuse(`Looking after this computer is not available on ${process.platform} yet.`)
      // A tool with an input schema is called (args, ctx); one without is called (ctx).
      const [args, ctx] = config.inputSchema ? given : [{}, given[0]]
      try {
        const { text, data } = await work(args ?? {}, ctx?.mcpReq?.signal)
        return { content: [{ type: 'text', text }], structuredContent: data }
      } catch (error) {
        return refuse(error.message)
      }
    }
    alexia.tool(name, { ...config, ...(parts && cap && { _meta: { 'alexia/provides': [cap] } }) }, handler)
  }

  const input = (properties, required) => fromJsonSchema({ type: 'object', properties, required })
  const what = {
    type: 'string',
    enum: SETTINGS,
    description: 'volume and brightness are 0 to 100; mute, dark_mode and focus (do not disturb) are on or off.',
  }

  tool(
    'system_get',
    'system.get',
    {
      description: 'Read one setting of this computer: sound volume, mute, screen brightness, dark mode or do not disturb.',
      inputSchema: input({ what }, ['what']),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, signal) => parts.care.get(args, signal),
  )

  tool(
    'system_set',
    'system.set',
    {
      description: 'Change one setting of this computer: sound volume, mute, screen brightness, dark mode or do not disturb.',
      inputSchema: input(
        { what, value: { type: ['number', 'boolean'], description: 'A number 0 to 100 for volume and brightness, otherwise true or false.' } },
        ['what', 'value'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args, signal) => parts.care.set(args, signal),
  )

  tool(
    'system_care',
    'system.care',
    {
      description:
        'Check this computer: disk space, what starts with it, waiting updates (never installed) or old temp files. ' +
        'By default it only reports. apply true with check temp deletes temp files older than 7 days that are not open. ' +
        'disable with check startup switches that one startup item off.',
      inputSchema: input(
        {
          check: { type: 'string', enum: CHECKS, description: 'What to look at.' },
          apply: { type: 'boolean', description: 'Only for temp: delete the old files. Defaults to false.' },
          disable: { type: 'string', description: 'Only for startup: the name of the one item to switch off, as the report gives it.' },
        },
        ['check'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args, signal) => parts.care.care(args, signal),
  )

  tool(
    'power_do',
    'power.do',
    {
      description:
        'Lock this computer, put it to sleep, restart it or shut it down, now or after in_s seconds. Restart and ' +
        'shutdown always wait at least 60 seconds, and power_cancel stops anything still waiting.',
      inputSchema: input(
        {
          action: { type: 'string', enum: ACTIONS, description: 'What to do.' },
          in_s: { type: 'integer', minimum: 0, maximum: MOST_S, description: 'Seconds to wait first.' },
        },
        ['action'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args, signal) => parts.power.run(args, signal),
  )

  tool(
    'power_cancel',
    undefined,
    {
      description: 'Stop a lock, sleep, restart or shutdown that power_do has waiting.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => parts.power.cancel(),
  )
}
