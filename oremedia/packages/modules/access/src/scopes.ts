import type { ApiScope } from '@oremedia/contracts/access';
import type { Principal } from './resolve';

/**
 * Spec 7.6 per-key scopes. Only API client keys carry scopes; sessions, reviewer links and support sessions are
 * governed by the policy engine alone. A key with an empty scope list keeps read access (`*:read`) so keys issued
 * before enforcement keep working for reads; a stored value outside the vocabulary grants nothing.
 */
export function apiKeyAllows(scopes: readonly string[], required: ApiScope): boolean {
  if (scopes.length === 0) return required.endsWith(':read');
  return scopes.includes(required);
}

/** True when the principal may use a surface that requires `required` (non-key principals are not scoped). */
export function principalHasScope(principal: Principal, required: ApiScope): boolean {
  return principal.kind !== 'api_client' || apiKeyAllows(principal.scopes, required);
}
