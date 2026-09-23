import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { noRawDb } from './rules/no-raw-db.js';
import { noProviderBranching } from './rules/no-provider-branching.js';
import { noDirectFetchInProviders } from './rules/no-direct-fetch-in-providers.js';
import { moduleTableOwnership } from './rules/module-table-ownership.js';

const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});
const at = (filename, code) => ({ code, filename });

describe('oremedia/no-raw-db', () => {
  it('bans the raw client outside packages/db, allows it inside and in the outbox dispatcher', () => {
    tester.run('no-raw-db', noRawDb, {
      valid: [
        at('/r/packages/db/src/scoped-repository.ts', "import { getDb } from './client';"),
        at('/r/packages/db/src/x.ts', "import { getDb } from '@oremedia/db/client';"),
        at(
          '/r/packages/modules/operations/src/outbox-dispatcher.ts',
          "import { getDb } from '@oremedia/db/client';",
        ),
        at('/r/packages/modules/brand/src/service.ts', "import { withTransaction } from '@oremedia/db';"),
      ],
      invalid: [
        {
          ...at('/r/packages/modules/brand/src/service.ts', "import { getDb } from '@oremedia/db/client';"),
          errors: [{ messageId: 'raw' }],
        },
        {
          ...at('/r/apps/api/src/x.ts', "import { getDb } from '../../../packages/db/src/client';"),
          errors: [{ messageId: 'raw' }],
        },
      ],
    });
  });
});

describe('oremedia/no-provider-branching', () => {
  it('flags provider-key comparisons outside packages/providers', () => {
    tester.run('no-provider-branching', noProviderBranching, {
      valid: [
        at('/r/packages/providers/src/registry.ts', "if (key === 'linkedin_page') {}"),
        at('/r/packages/modules/publishing/src/x.ts', "if (kind === 'approval') {}"),
        at('/r/packages/modules/publishing/src/x.ts', 'const cap = registry.get(providerKey);'),
      ],
      invalid: [
        {
          ...at('/r/packages/modules/publishing/src/x.ts', "if (provider === 'instagram_business') {}"),
          errors: [{ messageId: 'branch' }],
        },
        {
          ...at('/r/apps/worker-core/src/x.ts', "switch (p) { case 'x': break; }"),
          errors: [{ messageId: 'branch' }],
        },
        { ...at('/r/packages/ai/src/x.ts', "const b = 'tiktok' !== k;"), errors: [{ messageId: 'branch' }] },
      ],
    });
  });
});

describe('oremedia/no-direct-fetch-in-providers', () => {
  it('adapters must go through ProviderIO', () => {
    tester.run('no-direct-fetch-in-providers', noDirectFetchInProviders, {
      valid: [
        at('/r/packages/providers/src/io.ts', 'const r = await fetch(url, init);'),
        at(
          '/r/packages/providers/src/linkedin_page/adapter.ts',
          'const r = await io.request(url, init, { mutation: true });',
        ),
        at('/r/packages/modules/assets/src/x.ts', 'const r = await fetch(url);'),
      ],
      invalid: [
        {
          ...at('/r/packages/providers/src/linkedin_page/adapter.ts', 'const r = await fetch(url);'),
          errors: [{ messageId: 'fetch' }],
        },
        {
          ...at('/r/packages/providers/src/x/adapter.ts', "import axios from 'axios';"),
          errors: [{ messageId: 'fetch' }],
        },
        {
          ...at('/r/packages/providers/src/x/adapter.ts', 'axios.get(url);'),
          errors: [{ messageId: 'fetch' }],
        },
      ],
    });
  });
});

describe('oremedia/module-table-ownership', () => {
  it('a module imports only its own schema file', () => {
    tester.run('module-table-ownership', moduleTableOwnership, {
      valid: [
        at(
          '/r/packages/modules/brand/src/repositories.ts',
          "import { brands } from '@oremedia/db/schema/brand';",
        ),
        at(
          '/r/packages/modules/brand/src/repositories.ts',
          "import { id } from '@oremedia/db/schema/_columns';",
        ),
        at('/r/packages/modules/brand/src/service.ts', "import { withTransaction } from '@oremedia/db';"),
        at('/r/apps/api/src/x.ts', "import { brands } from '@oremedia/db/schema/brand';"),
      ],
      invalid: [
        {
          ...at(
            '/r/packages/modules/brand/src/repositories.ts',
            "import { assets } from '@oremedia/db/schema/assets';",
          ),
          errors: [{ messageId: 'foreign' }],
        },
      ],
    });
  });
});
