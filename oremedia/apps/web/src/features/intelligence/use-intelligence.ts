import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type WorkspaceDto = inferOutput<Trpc['intelligence']['workspace']['get']>;
export type InsightDto = WorkspaceDto['whatChanged']['items'][number];
export type RecommendationDto = WorkspaceDto['whatToDoNext']['items'][number];
export type PlaybookEntryDto = WorkspaceDto['brandPlaybook']['items'][number];
export type WorkspaceExperimentDto = WorkspaceDto['experiments']['planned'][number];
export type ClusterDto = inferOutput<Trpc['intelligence']['voice']['clusters']>['items'][number];
export type AnomalyDto = inferOutput<Trpc['intelligence']['anomalies']['list']>['items'][number];
export type AcceptResultDto = inferOutput<Trpc['intelligence']['recommendations']['accept']>;
export type AnalystRunDto = inferOutput<Trpc['intelligence']['analyst']['run']>;

const POLL_MS = 5_000;

/** Spec 16.9: the five views in one read; while an analysis was requested the screen polls for its output. */
export function useWorkspace(brandId: string, analysing: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.intelligence.workspace.get.queryOptions({ brandId }),
    refetchInterval: analysing ? POLL_MS : false,
  });
}

export function useVoiceClusters(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.intelligence.voice.clusters.queryOptions({ brandId, limit: 20 }));
}

export function useAnomalies(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.intelligence.anomalies.list.queryOptions({ brandId, page: { limit: 50 } }));
}

/** Proposed playbook entries (the workspace view carries approved ones only). */
export function useProposedPlaybook(brandId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.intelligence.playbook.list.queryOptions({ brandId, state: 'proposed', page: { limit: 50 } }),
  );
}
