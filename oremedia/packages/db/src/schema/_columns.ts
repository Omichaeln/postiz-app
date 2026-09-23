import { bigint, char, datetime, int, varchar } from 'drizzle-orm/mysql-core';

/** Spec 6.1 / 6.2 column conventions. */
export const id = (name = 'id') => varchar(name, { length: 32 }).primaryKey();
export const ref = (name: string) => varchar(name, { length: 32 });
export const tenantId = () => varchar('tenant_id', { length: 32 }).notNull();
export const brandId = () => varchar('brand_id', { length: 32 }).notNull();
export const createdAt = () =>
  datetime('created_at', { fsp: 3 })
    .notNull()
    .$defaultFn(() => new Date());
export const updatedAt = () =>
  datetime('updated_at', { fsp: 3 })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
export const version = () => int('version').notNull().default(0);
export const hash = (name: string) => char(name, { length: 64 });
export const micros = (name: string) => bigint(name, { mode: 'number' });
export const ts = (name: string) => datetime(name, { fsp: 3 });
