/** Writes packages/db/roles/app-role.sql from the schema (spec 6.1). Run from the oremedia root. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateRoleSql } from '@oremedia/db/roles';

const out = path.resolve(process.cwd(), 'packages/db/roles/app-role.sql');
writeFileSync(out, generateRoleSql('__DB_NAME__', '__APP_USER__'));
console.error(`wrote ${out}`);
