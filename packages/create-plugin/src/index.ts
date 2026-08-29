// SPDX-License-Identifier: Apache-2.0
import { ALEXIA_PROTOCOL_MAX, MCP_PINNED } from '@alexia/protocol'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

/**
 * `npm create @alexia/plugin` (M3-4).
 *
 * Four questions and a folder that runs. The point is not saving typing — it is that the
 * **first plugin somebody writes is already correct about the three things that are easy
 * to get wrong**: stdout is the wire, the folder name is the id, and a tool description is
 * prompt text rather than a label.
 *
 * ponytail: `node:readline/promises` rather than a prompt library. Four questions, no
 * validation loop worth having, and a scaffold that pulls in a dependency tree is a bad
 * first impression of a project whose whole argument is that plugins are small.
 */

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export interface Answers {
  id: string
  name: string
  summary: string
  /** The one tool it ships with. A scaffold with no tool teaches nothing. */
  tool: string
  license: string
}

/** The manifest, with only the fields a first plugin actually needs filled in. */
export const manifestFor = (a: Answers): Record<string, unknown> => ({
  $schema: 'https://alexia.dev/plugin.schema.json',
  manifest_version: 1,
  id: a.id,
  name: a.name,
  summary: a.summary,
  version: '0.1.0',
  license: a.license,
  entry: { run: 'node', args: ['index.js'] },
  // The current revision, not the oldest one that loads. A scaffold that starts a plugin on
  // the revision about to be deprecated hands its author a migration on day one.
  alexia_protocol: ALEXIA_PROTOCOL_MAX,
  mcp_protocol: MCP_PINNED,
  // Commented out rather than absent: the shape is right there when it is needed, and a
  // capability nobody asked for is a permission prompt nobody had to read.
  settings: [{ type: 'status', key: 'ready', label: 'State' }],
})

export const indexFor = (a: Answers): string => `// SPDX-License-Identifier: ${a.license}
import { fromJsonSchema, log, plugin } from '@alexia/sdk'

/**
 * ${a.name} — ${a.summary}
 *
 * Three things to know, and they are the three that are easy to get wrong:
 *
 * 1. **stdout is the wire.** One \`console.log\` corrupts the JSON-RPC stream and Alexia
 *    drops this plugin. Use \`log\` — every level goes to stderr, which Alexia captures and
 *    shows in this plugin's log panel.
 * 2. **The folder name is the id.** Rename the folder and rename it in plugin.json, or it
 *    will not load.
 * 3. **A tool description is prompt text.** It is what the model reads when deciding
 *    whether to reach for this. Say what it does *and when to use it*; a label is a bug.
 */

const alexia = plugin()

alexia.tool(
  '${a.tool}',
  {
    description:
      'Say what this does, and when the model should reach for it. Two sentences beats one word.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What to do it to.' },
      },
      required: ['subject'],
    }),
    // MCP's own hints, and what Alexia's permission modes read. \`readOnlyHint: true\` means
    // this runs without asking in the default mode — so it has to be true.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  ({ subject }) => ({ content: [{ type: 'text', text: \`Did it to \${subject}.\` }] }),
)

await alexia.start()
// Only after start(): everything below talks to Alexia, and there is nothing to talk to
// until the transport is connected.
await alexia.status('ready', '● Ready').catch(() => {})
log.info(\`\${alexia.manifest.name} is ready\`)
`

export const packageFor = (a: Answers): Record<string, unknown> => ({
  name: a.id,
  version: '0.1.0',
  private: true,
  type: 'module',
  license: a.license,
  dependencies: { '@alexia/sdk': '^0.1.0' },
})

export const readmeFor = (a: Answers): string => `# ${a.name}

${a.summary}

## Running it

\`\`\`bash
npm install
\`\`\`

Then in Alexia: **Plugins → Add a plugin**, and paste this folder's full path. It arrives
installed and **not enabled** — the next screen shows what it asked for, in your own words
from \`requires[]\`, and somebody says yes.

## Before you publish it

\`\`\`bash
npx @alexia/conformance .
\`\`\`

That is the same suite review runs, so nothing about the queue is a surprise. Warnings are
worth fixing; failures do not get published.

## The three rules

- **stdout is the wire.** \`console.log\` breaks the connection. Use \`log\` from the SDK.
- **The folder name is the id.** They must match.
- **A tool description is prompt text.** It is the whole of how the model decides to call
  you. Say what it does and when to use it.

> The Alexia plugin contract is unstable and will break. There is no promised review
> turnaround — plugins are reviewed when the maintainer gets to them.
`

/** Write the folder. Refuses to overwrite: a scaffold that eats work is a scaffold nobody runs twice. */
export function scaffold(dir: string, answers: Answers): void {
  if (existsSync(dir)) throw new Error(`${dir} already exists.`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifestFor(answers), null, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), indexFor(answers))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageFor(answers), null, 2)}\n`)
  writeFileSync(join(dir, 'README.md'), readmeFor(answers))
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (question: string, fallback: string): Promise<string> =>
    (await rl.question(`${question} (${fallback}) `)).trim() || fallback

  try {
    const given = argv.find((arg) => !arg.startsWith('-'))
    let id = given ?? (await ask('What is it called? Lowercase, hyphens', 'my-plugin'))
    while (!ID.test(id)) {
      console.log('Lowercase letters, digits and hyphens only — it is also the folder name.')
      id = await ask('What is it called?', 'my-plugin')
    }
    const answers: Answers = {
      id,
      name: await ask('How should Alexia show it?', id),
      summary: await ask('One sentence about what it does', 'Does one useful thing.'),
      tool: (await ask('The name of its first tool', 'do_something')).replace(/[^a-z0-9_]/g, '_'),
      license: await ask('Licence', 'Apache-2.0'),
    }
    const dir = join(process.cwd(), answers.id)
    scaffold(dir, answers)
    console.log('')
    console.log(`${answers.id} is at ${dir}`)
    console.log('  npm install')
    console.log('  npx @alexia/conformance .')
    console.log('Then in Alexia: Plugins, Add a plugin, and paste that path.')
  } finally {
    rl.close()
  }
}
