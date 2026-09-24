export {
  runInTenant,
  requireTenant,
  currentTenant,
  TenantContextMissingError,
  type TenantContext,
} from './tenant-context';
export { withTransaction, TransactionClosedError } from './transaction';
export type { Tx, Db } from './client';
export {
  configureDatabase,
  closeDatabase,
  configureRoleDatabase,
  runWithDatabaseRole,
  type DatabaseRole,
} from './client';
export {
  TenantScopedRepository,
  BrandScopedRepository,
  PlatformRepository,
  runAsPlatform,
  currentPlatformJob,
  affectedRows,
} from './scoped-repository';
export {
  GLOBAL_TABLES,
  GLOBAL_PLUS_TENANT_TABLES,
  INSERT_ONLY_TABLES,
  RETENTION_ROLE_GRANTS,
  type RetentionPrivilege,
} from './global-tables';
export { runMigrations } from './migrate';
export {
  TenantPurgeRepository,
  tenantScopedTables,
  purgeOrder,
  type PurgeScope,
  type PurgeTableOptions,
} from './tenant-purge';
