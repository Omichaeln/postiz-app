import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { formatMicros, runStateChip } from './run-helpers';
import type { RunDto } from './use-agent-runs';

export interface RunsListProps {
  runs: Array<{ runId: string; run: RunDto | undefined; error: unknown; isPending: boolean }>;
  selectedId: string | null;
  hrefFor: (runId: string) => string;
  /** Why the brand-wide history is not available (audit.read denied); the device list still shows. */
  historyNotice: string | null;
  /** The audit query has not settled yet and nothing is known from this device: show loading, not "no runs". */
  historyPending: boolean;
  historyError: unknown;
  onRetryHistory: () => void;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/** Runs list: state chip, task kind, initiator, cost, started and finished; every row is a link (keyboard path). */
export function RunsList({
  runs,
  selectedId,
  hrefFor,
  historyNotice,
  historyPending,
  historyError,
  onRetryHistory,
}: RunsListProps) {
  return (
    <div className="flex flex-col gap-3">
      {historyError !== null && historyNotice === null && (
        <RequestError error={historyError} onRetry={onRetryHistory} title="Run history unavailable" />
      )}
      {historyNotice && <p className="text-xs text-muted-foreground">{historyNotice}</p>}
      {runs.length === 0 && historyPending && <Skeleton label="Loading runs" lines={3} />}
      {runs.length === 0 && !historyPending && (
        <EmptyState
          title="No runs yet"
          description="Nothing has run for this brand. Start a run below; it appears here with its state, cost and every step."
        />
      )}
      {runs.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Runs">
          {runs.map(({ runId, run, error, isPending }) => {
            const selected = runId === selectedId;
            return (
              <li key={runId} data-testid="run-row" data-run-state={run?.state}>
                {isPending && <Skeleton label={`Loading run ${runId}`} lines={2} className="py-2" />}
                {error !== null && !run && (
                  <p className="py-2 text-sm text-muted-foreground">
                    <code>{runId}</code>: {toUiError(error).message}
                  </p>
                )}
                {run && (
                  <Link
                    to={hrefFor(runId)}
                    aria-current={selected ? 'page' : undefined}
                    className={`block rounded-md px-2 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-secondary' : ''}`}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={runStateChip(run.state).tone}>{runStateChip(run.state).label}</Badge>
                      <span className="font-medium">{run.taskKind.replace(/_/g, ' ')}</span>
                      <span className="text-muted-foreground">{formatMicros(run.costMicros)}</span>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {run.initiatorKind} {run.initiatorId} · started {when(run.createdAt)} · finished{' '}
                      {when(run.finishedAt)}
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
