/** Reads one cookie by name; the CSRF cookie is the only one the app reads (the session cookie is HttpOnly). */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
