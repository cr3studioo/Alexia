import { defineConfig } from 'vitest/config'

// Two projects, because `pnpm check` runs them as separate gates: a red unit test is a
// bug, a red invariant is the thesis breaking. `pnpm vitest run --project invariants -t <name>`
// runs one check alone — see docs/spec/invariants.md.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/test/invariants/**'],
        },
      },
      {
        test: {
          name: 'invariants',
          include: ['packages/core/test/invariants/**/*.test.ts'],
        },
      },
    ],
  },
})
