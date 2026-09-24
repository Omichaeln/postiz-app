export {
  runInTenant,
  requireTenant,
  currentTenant,
  TenantContextMissingError,
  type TenantContext,
} from './tenant-context';
export { withTransaction, TransactionClosedError } from './transaction';
export type { Tx, Db } from './client';
export { configureDatabase, closeDatabase } from './client';
export {
  TenantScopedRepository,
  BrandScopedRepository,
  PlatformRepository,
  runAsPlatform,
  currentPlatformJob,
  affectedRows,
} from './scoped-repository';
export { GLOBAL_TABLES, GLOBAL_PLUS_TENANT_TABLES, INSERT_ONLY_TABLES } from './global-tables';
export { runMigrations } from './migrate';
