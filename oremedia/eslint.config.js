import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import oremedia from 'eslint-plugin-oremedia';

/**
 * Dependency rule (spec 3.3), enforced with eslint-plugin-boundaries:
 *   apps/*      → modules, contracts, observability, ui (web only), db public index
 *   workflows   → contracts only (+ @temporalio/workflow)
 *   activities  → modules, providers, contracts, db public index, observability
 *   modules/X   → domain, db, contracts, observability, editor, providers, ai and other modules' public index
 *   providers   → contracts, observability
 *   domain      → contracts only
 *   editor      → contracts, domain
 *   ai          → contracts, domain, db, observability, modules
 *   db          → contracts, domain
 *   ui          → contracts
 */
const elements = [
  { type: 'app-web', pattern: 'apps/web' },
  { type: 'app', pattern: 'apps/*' },
  { type: 'workflows', pattern: 'packages/workflows' },
  { type: 'activities', pattern: 'packages/activities' },
  { type: 'module', pattern: 'packages/modules/*' },
  { type: 'providers', pattern: 'packages/providers' },
  { type: 'domain', pattern: 'packages/domain' },
  { type: 'editor', pattern: 'packages/editor' },
  { type: 'ai', pattern: 'packages/ai' },
  { type: 'db', pattern: 'packages/db' },
  { type: 'ui', pattern: 'packages/ui' },
  { type: 'observability', pattern: 'packages/observability' },
  { type: 'contracts', pattern: 'packages/contracts' },
  { type: 'tooling', pattern: 'tooling/*' },
];

/** A dependency policy: files of `from` may import only elements of the listed types. */
const policy = (from, types) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: types } } } },
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'packages/db/migrations/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { oremedia, boundaries },
    settings: {
      'boundaries/elements': elements,
      'boundaries/dependency-nodes': ['import', 'dynamic-import'],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: [
            'tsconfig.json',
            'apps/*/tsconfig.json',
            'packages/*/tsconfig.json',
            'packages/modules/*/tsconfig.json',
            'tooling/*/tsconfig.json',
          ],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['error'] }],
      'oremedia/no-raw-db': 'error',
      'oremedia/no-provider-branching': 'error',
      'oremedia/no-direct-fetch-in-providers': 'error',
      'oremedia/module-table-ownership': 'error',
      'boundaries/no-unknown-files': 'off',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            policy('app-web', ['module', 'contracts', 'observability', 'ui', 'db', 'editor', 'tooling']),
            policy('app', [
              'module',
              'contracts',
              'observability',
              'db',
              'activities',
              'workflows',
              'providers',
              'ai',
              'editor',
              'tooling',
            ]),
            policy('workflows', ['contracts']),
            policy('activities', [
              'module',
              'providers',
              'contracts',
              'db',
              'observability',
              'ai',
              'editor',
              'domain',
            ]),
            policy('module', [
              'domain',
              'db',
              'contracts',
              'observability',
              'editor',
              'providers',
              'ai',
              'module',
            ]),
            policy('providers', ['contracts', 'observability']),
            policy('domain', ['contracts']),
            policy('editor', ['contracts', 'domain']),
            policy('ai', ['contracts', 'domain', 'db', 'observability', 'module']),
            policy('db', ['contracts', 'domain']),
            policy('ui', ['contracts']),
            policy('observability', ['contracts']),
            policy('tooling', [
              'tooling',
              'contracts',
              'db',
              'domain',
              'module',
              'app',
              'providers',
              'ai',
              'editor',
              'observability',
              'workflows',
              'activities',
            ]),
          ],
        },
      ],
    },
  },
  {
    // Workflow code is deterministic: no Node APIs, no I/O.
    files: ['packages/workflows/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'crypto',
                'http',
                'https',
                'net',
                'child_process',
                'mysql2',
                'drizzle-orm*',
                'ioredis',
                'undici',
              ],
              message: 'Workflows are deterministic: contracts and @temporalio/workflow only (spec 3.3).',
            },
            {
              group: [
                '@oremedia/*',
                '!@oremedia/contracts',
                '!@oremedia/contracts/*',
                '!@oremedia/workflows',
                '!@oremedia/workflows/*',
              ],
              message: 'Workflows may import contracts only.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'process', 'setTimeout', 'setInterval', 'fetch'],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tooling/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-console': 'off' },
  },
);
