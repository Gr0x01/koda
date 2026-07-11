// Flat ESLint config — the cheap-insurance layer under `npm run lint` (typecheck stays the main
// gate). Recommended rules only, non-type-aware for speed; tune rules here as real noise appears.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'ios/**',
      'resources/**',
      'spike/**',
      'temp/**',
      '.worktrees/**',
      'supabase/**',
      'relay/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The engine stream and IPC seams handle genuinely unknown shapes; `any` at those edges is a
      // deliberate choice the Zod boundary makes safe.
      '@typescript-eslint/no-explicit-any': 'off',
      // `catch {}`-with-comment is the codebase's fail-soft idiom.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `_`-prefixed = deliberately unused (destructured fields, handler args).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  // Build/packaging scripts run under plain Node.
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  // React renderers (desktop + mobile): the hooks rules catch real stale-closure bugs.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
)
