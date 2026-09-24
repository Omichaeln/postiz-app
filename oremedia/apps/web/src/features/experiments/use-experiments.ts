import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type ExperimentDto = inferOutput<Trpc['experiments']['get']>;
export type ExperimentSummaryDto = inferOutput<Trpc['experiments']['list']>['items'][number];
export type ResultsDto = inferOutput<Trpc['experiments']['results']['get']>;
export type ResultDto = ResultsDto['items'][number];
export type ComputeResultDto = inferOutput<Trpc['experiments']['results']['compute']>;

/** One hook per query (spec 21.1); the brand's experiments newest first, every state. */
export function useExperiments(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.experiments.list.queryOptions({ brandId, page: { limit: 100 } }));
}

export function useExperiment(experimentId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.experiments.get.queryOptions({ experimentId: experimentId ?? '' }),
    enabled: experimentId !== null,
  });
}

export function useExperimentResults(experimentId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.experiments.results.get.queryOptions({ experimentId: experimentId ?? '' }),
    enabled: experimentId !== null,
  });
}
