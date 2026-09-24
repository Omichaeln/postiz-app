import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AutonomyMode } from '@oremedia/contracts/tenancy';
import { TaskKind } from '@oremedia/contracts/skills';
import { Button, Field, Input, Panel, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { rememberRun } from './run-helpers';

export interface StartRunFormProps {
  companyId: string;
  brandId: string;
  brandName: string;
  hrefFor: (runId: string) => string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Spec 12.5: the mode actually granted is min(requested, principal, tenant policy, entitlement); the server decides
 * and the form only requests. One idempotency key per submission intent, renewed after success.
 */
export function StartRunForm({ companyId, brandId, brandName, hrefFor }: StartRunFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const [principalId, setPrincipalId] = useState('');
  const [taskKind, setTaskKind] = useState<string>('copywriting');
  const [autonomy, setAutonomy] = useState<string>('create');
  const [brief, setBrief] = useState('{\n  "goal": ""\n}');
  const [briefError, setBriefError] = useState<string | null>(null);
  const start = useMutation(
    trpc.agents.runs.start.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        rememberRun({ companyId, brandId, runId: res.runId });
        void queryClient.invalidateQueries(trpc.operations.audit.pathFilter());
        navigate(hrefFor(res.runId));
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(brief);
    } catch (err) {
      setBriefError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!isRecord(parsed)) {
      setBriefError('The brief must be a JSON object.');
      return;
    }
    setBriefError(null);
    start.mutate({
      brandId,
      servicePrincipalId: principalId.trim(),
      taskKind: TaskKind.parse(taskKind),
      requestedAutonomy: AutonomyMode.parse(autonomy),
      brief: parsed,
    });
  };
  const ui = start.isError ? toUiError(start.error) : null;
  const fieldIssue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  return (
    <Panel title="Start a run" id="start-run">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="Brand" htmlFor="run-brand" hint="Runs belong to the brand in the address bar.">
          <Input id="run-brand" value={brandName} readOnly aria-readonly="true" />
        </Field>
        <Field
          label="Service principal"
          htmlFor="run-principal"
          hint="sp_… of an active agent principal (access.servicePrincipals). Its grants and maximum autonomy bound the run."
          error={fieldIssue('servicePrincipalId')}
        >
          <Input
            id="run-principal"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Task kind" htmlFor="run-task" error={fieldIssue('taskKind')}>
            <Select
              id="run-task"
              value={taskKind}
              onValueChange={setTaskKind}
              options={TaskKind.options.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field
            label="Requested autonomy"
            htmlFor="run-autonomy"
            hint="Granted mode is the minimum of this, the principal, tenant policy and plan."
          >
            <Select
              id="run-autonomy"
              value={autonomy}
              onValueChange={setAutonomy}
              options={AutonomyMode.options.map((m) => ({ value: m, label: m.replace(/_/g, ' ') }))}
            />
          </Field>
        </div>
        <Field
          label="Brief (JSON object)"
          htmlFor="run-brief"
          error={briefError ?? fieldIssue('brief')}
          hint="Validated against the skill's input schema when the run starts."
        >
          <Textarea
            id="run-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={6}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        {ui && ui.kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${ui.message} Starting a run needs the agent.start_run permission for this brand and remaining generation budget on the plan.${ui.correlationId ? ` Reference ${ui.correlationId}.` : ''}`}
            data-testid="start-denied"
          />
        )}
        {ui && ui.kind !== 'forbidden' && ui.kind !== 'validation' && (
          <RequestError error={start.error} title="The run did not start" />
        )}
        {ui && ui.kind === 'validation' && !ui.details.length && (
          <RequestError error={start.error} title="The run did not start" />
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={start.isPending || !principalId.trim()}
            disabledReason={principalId.trim() ? undefined : 'Enter a service principal id first'}
          >
            {start.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
