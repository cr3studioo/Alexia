import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Build output, none of it written here. `dist-app` is what `pnpm package` bundles — the
  // same code twice, the second time without its types — and `target` is cargo's, where a
  // Tauri build leaves generated JavaScript that answers to nobody's style but its own.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'dist-app/**', '**/target/**'] },
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
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        // Both are Node globals a plugin reaches for: `Buffer` for the bytes an image
        // arrives as, `AbortController` for a loop that has to be stoppable.
        Buffer: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  tseslint.configs.recommended,
)
