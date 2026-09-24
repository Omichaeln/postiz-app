import { QueryClient } from '@tanstack/react-query';
import { toUiError } from './errors';

/** Retries only network failures; an envelope error is a decision, not a transient (spec 7.2). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, err) => toUiError(err).kind === 'network' && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}
