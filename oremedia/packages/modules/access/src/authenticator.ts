import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authentication (spec 3.1, 18): D-03 leaves the provider open. This module owns the parts that are provider-
 * independent: opaque bearer/session tokens, hashing at rest, and constant-time comparison. Password or
 * magic-link flows plug in here once D-03 is decided; nothing in the policy layer depends on them.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newOpaqueToken(prefix: string): { token: string; hash: string; prefixForLookup: string } {
  const raw = randomBytes(32).toString('base64url');
  const token = `${prefix}_${raw}`;
  return { token, hash: hashToken(token), prefixForLookup: token.slice(0, 12) };
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const hashForAudit = (value: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${value}`).digest('hex');
