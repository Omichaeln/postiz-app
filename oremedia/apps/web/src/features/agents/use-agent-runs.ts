import { useQueries, useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type RunDto = inferOutput<Trpc['agents']['runs']['get']>;
export type StepDto = inferOutput<Trpc['agents']['runs']['steps']>['items'][number];
export type InvocationDto = StepDto['invocations'][number];
export type AuditEventDto = inferOutput<Trpc['operations']['audit']['query']>['items'][number];

/** While a run is live the screen polls; a terminal run is a record and is fetched once (spec 12.2 states). */
const LIVE: ReadonlySet<string> = new Set(['planned', 'running', 'waiting_for_review']);
const POLL_MS = 5_000;

/** One hook per query (spec 21.1); the tenant header comes from the URL. */
export function useAgentRun(runId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.agents.runs.get.queryOptions({ runId: runId ?? '' }),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && LIVE.has(q.state.data.state) ? POLL_MS : false),
  });
}

export function useAgentRunSteps(runId: string | null, live: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.agents.runs.steps.queryOptions({ runId: runId ?? '', page: { limit: 200 } }),
    enabled: runId !== null,
    refetchInterval: live ? POLL_MS : false,
  });
}

/**
 * Brand-wide run history: the audit log records every run request, review wait and finish under resource type
 * `agent_run` with the brand in its metadata (spec 4.3). audit.read is an admin permission, so callers treat
 * FORBIDDEN as "history unavailable", not as a failure of the screen.
 */
export function useAgentRunAudit(brandId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.operations.audit.query.queryOptions({
      query: { resourceType: 'agent_run' },
      page: { limit: 200 },
    }),
    select: (page) => auditRunIds(page.items, brandId),
    refetchInterval: POLL_MS * 6,
  });
}

export function auditRunIds(items: AuditEventDto[], brandId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of items) {
    const meta = e.metadata as { brandId?: unknown } | null;
    if (meta?.brandId !== brandId || seen.has(e.resourceId)) continue;
    seen.add(e.resourceId);
    out.push(e.resourceId);
  }
  return out;
}

/** The runs of the list, one get per id (a single useQueries call); live runs keep polling. */
export function useAgentRuns(runIds: string[]) {
  const trpc = useTRPC();
  return useQueries({
    queries: runIds.map((runId) => ({
      ...trpc.agents.runs.get.queryOptions({ runId }),
      refetchInterval: (q: { state: { data?: RunDto } }) =>
        q.state.data && LIVE.has(q.state.data.state) ? POLL_MS : false,
    })),
  });
}
