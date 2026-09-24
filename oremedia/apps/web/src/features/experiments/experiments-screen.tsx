import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Panel, Skeleton } from '@oremedia/ui';
import { PageHeading, RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { CreateExperimentForm } from './create-experiment-form';
import { ExperimentDetail } from './experiment-detail';
import { DIRECTIONAL_LABEL, experimentStateChip, modeLabel } from './experiment-helpers';
import { useExperiments } from './use-experiments';

const EXPERIMENT_PARAM = 'experiment';

/**
 * Spec 21.1 `experiments/`: the brand's experiments with their state and mode (always labelled, spec 16.6), a design
 * form, and the selected experiment's frozen design, lifecycle and results. The selection is in the URL.
 */
export function ExperimentsScreen() {
  const { brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(EXPERIMENT_PARAM);
  const list = useExperiments(brandId);
  const select = (id: string) => setParams({ [EXPERIMENT_PARAM]: id }, { replace: true });

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <PageHeading
        title="Experiments"
        description={`Pre-registered tests for ${brand.name}. Structured comparisons are directional; not causal. No result is declared before the pre-registered sample and window.`}
        actions={
          <Button size="sm" onClick={() => void list.refetch()} disabled={list.isFetching}>
            {list.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="All experiments" data-testid="experiments">
            {list.isPending && <Skeleton label="Loading experiments" lines={3} />}
            {list.isError && (
              <RequestError
                error={list.error}
                onRetry={() => void list.refetch()}
                title={toUiError(list.error).kind === 'forbidden' ? 'Permission denied' : undefined}
              />
            )}
            {list.isSuccess && list.data.items.length === 0 && (
              <EmptyState
                title="No experiments yet"
                description="Design one below, or accept a recommendation that prepares a test."
              />
            )}
            {list.isSuccess && list.data.items.length > 0 && (
              <ul className="flex flex-col gap-1" aria-label="Experiments">
                {list.data.items.map((x) => {
                  const chip = experimentStateChip(x.state);
                  const selected = x.id === selectedId;
                  return (
                    <li key={x.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => select(x.id)}
                        data-testid={`experiment-${x.id}`}
                        className={`flex w-full flex-col gap-1 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted'}`}
                      >
                        <span className="font-medium">{x.hypothesis}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                          <Badge tone="neutral" glyph={false}>
                            {modeLabel(x.mode)}
                          </Badge>
                          {x.conclusionLabel === DIRECTIONAL_LABEL && (
                            <span className="text-xs text-muted-foreground">{DIRECTIONAL_LABEL}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <CreateExperimentForm brandId={brandId} onCreated={select} />
        </div>
        <div className="min-w-0">
          {selectedId ? (
            <ExperimentDetail key={selectedId} experimentId={selectedId} />
          ) : (
            <Panel title="Experiment" data-testid="experiment-detail">
              <EmptyState
                title="No experiment selected"
                description="Choose an experiment to see its frozen design, lifecycle and results."
              />
            </Panel>
          )}
        </div>
      </div>
    </main>
  );
}
