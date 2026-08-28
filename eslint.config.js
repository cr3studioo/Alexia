import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `dist-app` is what `pnpm package` builds: a bundle of this repo's own output plus a
  // generated launcher. Linting it lints the same code twice, the second time without its
  // types.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'dist-app/**'] },
  js.configs.recommended,
  {
    // Plain .js and .mjs in this repo are always a Node program (a plugin entry point, a
    // test fixture, a build script). Two globals is cheaper than a dependency that knows
    // every environment.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  tseslint.configs.recommended,
)
