/** Writes packages/db/roles/app-role.sql and retention-role.sql from the schema (spec 6.1, 17.5). Run from the oremedia root. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateRetentionRoleSql, generateRoleSql } from '@oremedia/db/roles';

const dir = path.resolve(process.cwd(), 'packages/db/roles');
for (const [file, sql] of [
  ['app-role.sql', generateRoleSql('__DB_NAME__', '__APP_USER__')],
  ['retention-role.sql', generateRetentionRoleSql('__DB_NAME__', '__RETENTION_USER__')],
] as const) {
  const out = path.join(dir, file);
  writeFileSync(out, sql);
  console.error(`wrote ${out}`);
}
