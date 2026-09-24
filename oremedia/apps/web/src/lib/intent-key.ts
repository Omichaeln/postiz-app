import { useCallback, useState } from 'react';

/** Spec 21.1: one idempotency key per user intent, stable across retries, new for a new intent. */
export const newIntentKey = (): string => crypto.randomUUID();

export interface IntentKey {
  /** The key for the intent in progress; pass it as `trpc.context.idempotencyKey` on the mutation. */
  key: string;
  /** Call after the intent completed (or was abandoned) so the next submission is a new intent. */
  renew: () => string;
}

export function useIntentKey(): IntentKey {
  const [key, setKey] = useState(newIntentKey);
  const renew = useCallback(() => {
    const next = newIntentKey();
    setKey(next);
    return next;
  }, []);
  return { key, renew };
}

/** The tRPC request context a mutation call carries so the link can set the Idempotency-Key header. */
export const intentContext = (key: string): { context: { idempotencyKey: string } } => ({
  context: { idempotencyKey: key },
});

/**
 * The same context for `mutationOptions`: the tRPC query integration reads request options from `trpc`, not from
 * the top level of the options object, so spreading `intentContext` there silently drops the key.
 */
export const mutationIntent = (key: string): { trpc: { context: { idempotencyKey: string } } } => ({
  trpc: intentContext(key),
});
