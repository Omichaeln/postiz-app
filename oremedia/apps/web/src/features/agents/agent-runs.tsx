import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, Field, Input, Panel } from '@oremedia/ui';
import { PageHeading } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { mergeRunIds, readRecentRuns, rememberRun } from './run-helpers';
import { RunDetail } from './run-detail';
import { RunsList } from './runs-list';
import { StartRunForm } from './start-run-form';
import { useAgentRunAudit, useAgentRuns } from './use-agent-runs';

const RUN_PARAM = 'run';

/** Spec 21.1 `agents/`: runs, steps, costs, exceptions. The selected run is in the URL so a link to it is stable. */
export function AgentRunsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(RUN_PARAM);
  const hrefFor = (runId: string) => `?${RUN_PARAM}=${encodeURIComponent(runId)}`;
  const audit = useAgentRunAudit(brandId);
  const [deviceIds, setDeviceIds] = useState(() => readRecentRuns(companyId, brandId).map((r) => r.runId));
  useEffect(() => {
    if (!selectedId) return;
    rememberRun({ companyId, brandId, runId: selectedId });
    setDeviceIds(readRecentRuns(companyId, brandId).map((r) => r.runId));
  }, [companyId, brandId, selectedId]);
  const runIds = useMemo(() => mergeRunIds(audit.data ?? [], deviceIds), [audit.data, deviceIds]);
  const runs = useAgentRuns(runIds);
  const auditUi = audit.isError ? toUiError(audit.error) : null;
  const historyNotice =
    auditUi?.kind === 'forbidden'
      ? 'Brand-wide history needs audit access (owner or admin). Showing runs started or opened on this device.'
      : null;
  const [openId, setOpenId] = useState('');
  const openById = (e: FormEvent) => {
    e.preventDefault();
    if (openId.trim()) setParams({ [RUN_PARAM]: openId.trim() });
  };

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <PageHeading
        title="Agent activity"
        description="Every run of a bounded agent for this brand: its state, cost, steps and tool invocations with redacted inputs. Private model reasoning is never stored or shown."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Runs" data-testid="runs">
            <RunsList
              runs={runIds.map((runId, i) => ({
                runId,
                run: runs[i]?.data,
                error: runs[i]?.error ?? null,
                isPending: runs[i]?.isPending ?? true,
              }))}
              selectedId={selectedId}
              hrefFor={hrefFor}
              historyNotice={historyNotice}
              historyPending={audit.isPending}
              historyError={audit.isError && !historyNotice ? audit.error : null}
              onRetryHistory={() => void audit.refetch()}
            />
            <form className="mt-4 flex items-end gap-2 border-t border-border pt-3" onSubmit={openById}>
              <Field label="Open a run by id" htmlFor="run-id" className="flex-1" hint="run_…">
                <Input id="run-id" value={openId} onChange={(e) => setOpenId(e.target.value)} />
              </Field>
              <Button type="submit" disabled={!openId.trim()}>
                Open
              </Button>
            </form>
          </Panel>
          <StartRunForm companyId={companyId} brandId={brandId} brandName={brand.name} hrefFor={hrefFor} />
        </div>
        <div className="min-w-0">
          {selectedId ? (
            <RunDetail key={selectedId} companyId={companyId} brandId={brandId} runId={selectedId} />
          ) : (
            <Panel title="Run" data-testid="run-detail">
              <EmptyState
                title="No run selected"
                description="Choose a run from the list to see its timeline, costs and anything that needs attention."
              />
            </Panel>
          )}
        </div>
      </div>
    </main>
  );
}
