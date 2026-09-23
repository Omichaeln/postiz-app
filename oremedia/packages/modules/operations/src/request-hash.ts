import { hashCanonical } from '@oremedia/domain/hash';

/** Spec 7.1: the idempotency request hash covers the procedure path and the raw input, canonically. */
export const hashRequest = (path: string, rawInput: unknown): string =>
  hashCanonical({ path, input: rawInput ?? null });
