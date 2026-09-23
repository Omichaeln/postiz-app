/**
 * Spec 5.4 (3): every table in packages/db/src/schema either has a tenant_id column or is listed in GLOBAL_TABLES
 * (or GLOBAL_PLUS_TENANT_TABLES, where tenant_id is nullable) with a written justification.
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { GLOBAL_PLUS_TENANT_TABLES, GLOBAL_TABLES } from '@oremedia/db';

let failures = 0;
let checked = 0;
for (const [exportName, value] of Object.entries(schema)) {
  if (!(value instanceof MySqlTable)) continue;
  const table = value as MySqlTable;
  const name = getTableName(table);
  const columns = getTableColumns(table);
  const tenantCol = Object.values(columns).find((c) => c.name === 'tenant_id');
  checked++;
  if (tenantCol && tenantCol.notNull) continue;
  if (tenantCol && !tenantCol.notNull) {
    if (GLOBAL_PLUS_TENANT_TABLES[name]) continue;
    console.error(
      `✖ ${name} (${exportName}): tenant_id is nullable but the table is not listed in GLOBAL_PLUS_TENANT_TABLES with a justification`,
    );
    failures++;
    continue;
  }
  if (GLOBAL_TABLES[name]) continue;
  console.error(
    `✖ ${name} (${exportName}): no tenant_id column and not listed in GLOBAL_TABLES with a justification`,
  );
  failures++;
}
for (const listed of [...Object.keys(GLOBAL_TABLES), ...Object.keys(GLOBAL_PLUS_TENANT_TABLES)]) {
  const exists = Object.values(schema).some(
    (v) => v instanceof MySqlTable && getTableName(v as MySqlTable) === listed,
  );
  if (!exists) {
    console.error(`✖ ${listed} is listed as global but no such table exists`);
    failures++;
  }
}
console.error(`checked ${checked} tables, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
