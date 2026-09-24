import { describe, expect, it } from 'vitest';
import { ApiClientCreate, ApiScope } from '@oremedia/contracts/access';
import { apiKeyAllows, principalHasScope } from './scopes';

describe('API client key scopes (spec 7.6)', () => {
  it('a listed scope allows exactly that scope', () => {
    expect(apiKeyAllows(['content:write'], 'content:write')).toBe(true);
    expect(apiKeyAllows(['content:write'], 'content:read')).toBe(false); // write does not imply read
    expect(apiKeyAllows(['brands:read'], 'publications:write')).toBe(false);
  });

  it('an empty scope list (keys issued before enforcement) allows reads only', () => {
    for (const scope of ApiScope.options) expect(apiKeyAllows([], scope)).toBe(scope.endsWith(':read'));
  });

  it('a stored value outside the vocabulary grants nothing', () => {
    expect(apiKeyAllows(['*'], 'brands:read')).toBe(false);
    expect(apiKeyAllows(['admin'], 'content:write')).toBe(false);
  });

  it('only API client keys are scoped', () => {
    const session = { kind: 'user', userId: 'u', sessionId: 's', selectedTenantId: null } as const;
    expect(principalHasScope(session, 'access:write')).toBe(true);
    const key = {
      kind: 'api_client',
      apiClientId: 'ac',
      servicePrincipalId: 'sp',
      tenantId: 't',
      scopes: ['brands:read'],
    } as const;
    expect(principalHasScope({ ...key, scopes: [...key.scopes] }, 'brands:read')).toBe(true);
    expect(principalHasScope({ ...key, scopes: [...key.scopes] }, 'brands:write')).toBe(false);
  });

  it('new keys can only be issued with scopes from the vocabulary', () => {
    expect(ApiClientCreate.safeParse({ servicePrincipalId: 'sp', scopes: ['brands:read'] }).success).toBe(
      true,
    );
    expect(ApiClientCreate.safeParse({ servicePrincipalId: 'sp', scopes: [] }).success).toBe(true);
    expect(ApiClientCreate.safeParse({ servicePrincipalId: 'sp', scopes: ['everything'] }).success).toBe(
      false,
    );
  });
});
