import { readCookie } from './cookies';

/**
 * How the app authenticates (spec 7.1, apps/api/src/context.ts):
 *  - a cookie session (`oremedia_session`, HttpOnly) plus the CSRF double-submit cookie (`oremedia_csrf`), or
 *  - a bearer token (`ses_…` session token, `ak_…` API key) in the Authorization header.
 * D-03 (authentication provider) is open, so no credentials flow exists yet; the sign-in screen explains that and
 * accepts a pasted token, which is kept per tab (sessionStorage) and never written to a cookie or localStorage.
 */
const TOKEN_KEY = 'oremedia.session_token';
export const SESSION_COOKIE = 'oremedia_session';
export const CSRF_COOKIE = 'oremedia_csrf';

export function getBearerToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setBearerToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    // Private mode or blocked storage: the token then lives only for this page load.
  }
}

export function clearBearerToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to clear
  }
}

/** True when there is anything that could authenticate a request; the API remains the judge. */
export function hasCredential(): boolean {
  return Boolean(getBearerToken() || readCookie(CSRF_COOKIE));
}
