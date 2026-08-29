import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Build output, none of it written here. `dist-app` is what `pnpm package` bundles — the
  // same code twice, the second time without its types — and `target` is cargo's, where a
  // Tauri build leaves generated JavaScript that answers to nobody's style but its own.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'dist-app/**',
      '**/target/**',
      // What `scripts/sidecar.mjs` arranges for Tauri: the same bundle as `dist-app`, moved.
      // `gen/` is Tauri's own generated schema output, and `binaries/` is a copy of Node.
      'src-tauri/resources/**',
      'src-tauri/binaries/**',
      'src-tauri/gen/**',
    ],
  },
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
        // A multipart upload, without a dependency: `fetch` takes a `FormData` and a `Blob`
        // is how a file goes into one. Both have been Node globals since 18.
        FormData: 'readonly',
        Blob: 'readonly',
      },
    },
  },
  tseslint.configs.recommended,
)
