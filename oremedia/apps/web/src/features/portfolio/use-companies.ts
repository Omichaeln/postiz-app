import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../lib/trpc';

/** Spec 5.1: the portfolio is a projection over the user's memberships (access.listCompanies). */
export function useCompanies() {
  const trpc = useTRPC();
  return useQuery(trpc.access.listCompanies.queryOptions());
}
