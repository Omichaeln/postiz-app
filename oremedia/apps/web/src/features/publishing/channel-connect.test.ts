import { describe, expect, it } from 'vitest';
import {
  callbackError,
  callbackParams,
  providerLabel,
  redirectUriFor,
  unavailableReason,
} from './channel-connect';

describe('unavailableReason (spec 14.6)', () => {
  it('explains an uncertified or unknown provider and ignores other refusals', () => {
    expect(unavailableReason([{ path: 'providerKey', issue: 'provider_not_certified:x' }])).toContain(
      'Not certified',
    );
    expect(unavailableReason([{ path: 'providerKey', issue: 'unknown_provider:y' }])).toContain(
      'not registered',
    );
    expect(unavailableReason([{ path: 'brandId', issue: 'other' }])).toBeNull();
  });
});

describe('callback parsing (spec 14.7)', () => {
  it('needs both state and code', () => {
    expect(callbackParams('?state=s1&code=c1')).toEqual({ state: 's1', code: 'c1' });
    expect(callbackParams('state=s1')).toBeNull();
    expect(callbackParams('')).toBeNull();
  });
  it('reads the provider error redirect as text', () => {
    expect(callbackError('error=access_denied&error_description=User+said+no')).toBe(
      'access_denied: User said no',
    );
    expect(callbackError('error=access_denied')).toBe('access_denied');
    expect(callbackError('state=s')).toBeNull();
  });
  it('builds the redirect URI and labels providers', () => {
    expect(redirectUriFor('https://app.example', '/c/t/b/b/settings')).toBe(
      'https://app.example/c/t/b/b/settings',
    );
    expect(providerLabel('linkedin_page')).toBe('LinkedIn Page');
    expect(providerLabel('other')).toBe('other');
  });
});
