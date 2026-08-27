import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  {
    // Plain .js in this repo is always a Node program (a plugin entry point, a test
    // fixture). Two globals is cheaper than a dependency that knows every environment.
    files: ['**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  tseslint.configs.recommended,
)
