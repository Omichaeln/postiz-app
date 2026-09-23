import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantContextMissingError, type ActorKind } from '@oremedia/contracts';

export interface TenantContext {
  readonly tenantId: string;
  readonly actor: { kind: ActorKind; id: string };
  readonly brandIds: ReadonlySet<string> | 'all'; // brands this actor may touch in this tenant
  readonly correlationId: string;
  readonly supportSessionId?: string; // set only on audited platform-operator access
}

const storage = new AsyncLocalStorage<TenantContext>();

export const runInTenant = <T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> => storage.run(ctx, fn);

export function requireTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    // Loud by design: a missing tenant context is a bug, never a fallback to "all rows".
    throw new TenantContextMissingError();
  }
  return ctx;
}

export const currentTenant = (): TenantContext | undefined => storage.getStore();

export { TenantContextMissingError };
