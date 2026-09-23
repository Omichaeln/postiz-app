/**
 * Custom ESLint rules from the Oremedia specification (section 5.4 and 14.5).
 *
 *  - oremedia/no-raw-db: importing the raw Drizzle client outside packages/db is an error.
 *  - oremedia/no-provider-branching: string comparisons against provider identifiers outside
 *    packages/providers are an error (behaviour differences live in the adapter and its capability).
 *  - oremedia/no-direct-fetch-in-providers: adapters perform network I/O only through ProviderIO.
 *  - oremedia/module-table-ownership: a module may import only the schema tables it owns.
 */
import { noRawDb } from './rules/no-raw-db.js';
import { noProviderBranching } from './rules/no-provider-branching.js';
import { noDirectFetchInProviders } from './rules/no-direct-fetch-in-providers.js';
import { moduleTableOwnership } from './rules/module-table-ownership.js';

const plugin = {
  meta: { name: 'eslint-plugin-oremedia', version: '0.1.0' },
  rules: {
    'no-raw-db': noRawDb,
    'no-provider-branching': noProviderBranching,
    'no-direct-fetch-in-providers': noDirectFetchInProviders,
    'module-table-ownership': moduleTableOwnership,
  },
};

export default plugin;
