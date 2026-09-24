import type { ErrorDetail } from '@oremedia/contracts/errors';

/**
 * The Release 1 provider keys (spec 14.8, the registry in packages/providers). The API has no provider listing, so
 * the settings screen offers these and the server decides: an uncertified or unknown provider is refused with
 * CAPABILITY_UNSUPPORTED and the screen shows it unavailable with that reason (spec 14.6).
 */
export const RELEASE_1_PROVIDERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'linkedin_page', label: 'LinkedIn Page' },
  { key: 'instagram_business', label: 'Instagram Business' },
  { key: 'facebook_page', label: 'Facebook Page' },
  { key: 'x', label: 'X' },
];

export const providerLabel = (key: string): string =>
  RELEASE_1_PROVIDERS.find((p) => p.key === key)?.label ?? key;

/** Why a provider cannot be connected, from the server's refusal details; null when the refusal is something else. */
export function unavailableReason(details: readonly ErrorDetail[]): string | null {
  for (const d of details) {
    if (d.issue.startsWith('provider_not_certified:'))
      return 'Not certified for use yet: the platform review for this provider is not complete (spec 14.6).';
    if (d.issue.startsWith('unknown_provider:')) return 'Not available: this provider is not registered.';
  }
  return null;
}

/** The provider redirects back to the settings page with `state` and `code` in the query (spec 14.7 OAuth). */
export function callbackParams(search: string): { state: string; code: string } | null {
  const p = new URLSearchParams(search);
  const state = p.get('state');
  const code = p.get('code');
  return state && code ? { state, code } : null;
}

/** The provider's own error redirect (`error`, `error_description`), shown as text. */
export function callbackError(search: string): string | null {
  const p = new URLSearchParams(search);
  const error = p.get('error');
  if (!error) return null;
  const description = p.get('error_description');
  return description ? `${error}: ${description}` : error;
}

export const redirectUriFor = (origin: string, settingsPath: string): string => `${origin}${settingsPath}`;
