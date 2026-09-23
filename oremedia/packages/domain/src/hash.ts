import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/** SHA-256 hex, char(64) (spec 6.1). */
export const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

/** Hash of the canonical JSON form; used for content hashes, snapshot hashes and approval bindings. */
export const hashCanonical = (value: unknown): string => sha256Hex(canonicalJson(value));

/** Caption text is hashed after NFC normalisation and trailing-whitespace trim (spec 13.2). */
export const normaliseText = (text: string): string => text.normalize('NFC').replace(/\s+$/u, '');
export const hashText = (text: string): string => sha256Hex(normaliseText(text));
