import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Panel, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import {
  ALLOCATION_METHODS,
  EMPTY_DESIGN,
  modeLabel,
  MODES,
  parseDesign,
  STOPPING_RULES,
  UNIT_TYPES,
  type DesignForm,
  type VariantRow,
} from './experiment-helpers';

export interface CreateExperimentFormProps {
  brandId: string;
  onCreated: (experimentId: string) => void;
}

const label = (s: string) => s.replace(/_/g, ' ');

/**
 * Spec 16.6 design: the pre-registration fields as a form. Creating stores a draft (`designed`); the design is frozen
 * with a hash only when the person pre-registers it from the detail. Contract validation runs before the request.
 */
export function CreateExperimentForm({ brandId, onCreated }: CreateExperimentFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [form, setForm] = useState<DesignForm>(EMPTY_DESIGN);
  const [issues, setIssues] = useState<Array<{ path: string; issue: string }>>([]);
  const create = useMutation(
    trpc.experiments.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setForm(EMPTY_DESIGN);
        void queryClient.invalidateQueries(trpc.experiments.pathFilter());
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
        onCreated(res.experimentId);
      },
    }),
  );
  const set = <K extends keyof DesignForm>(key: K, value: DesignForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setVariant = (i: number, patch: Partial<VariantRow>) =>
    setForm((f) => ({ ...f, variants: f.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseDesign(form);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues([]);
    create.mutate({ brandId, design: parsed.design });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  const issue = (path: string) =>
    issues.find((i) => i.path === path)?.issue ?? ui?.details.find((d) => d.path === `design.${path}`)?.issue;

  return (
    <Panel title="Design an experiment" id="create-experiment">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="Hypothesis" htmlFor="x-hypothesis" error={issue('hypothesis')}>
          <Textarea
            id="x-hypothesis"
            value={form.hypothesis}
            onChange={(e) => set('hypothesis', e.target.value)}
            rows={2}
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Mode"
            htmlFor="x-mode"
            hint="A structured comparison is directional; not causal. Only a randomised design can support causal claims."
          >
            <Select
              id="x-mode"
              value={form.mode}
              onValueChange={(v) => set('mode', v)}
              options={MODES.map((m) => ({ value: m, label: modeLabel(m) }))}
            />
          </Field>
          <Field label="Primary metric key" htmlFor="x-primary" error={issue('primaryMetricKey')}>
            <Input
              id="x-primary"
              value={form.primaryMetricKey}
              onChange={(e) => set('primaryMetricKey', e.target.value)}
              required
            />
          </Field>
        </div>
        <Field
          label="Guardrail metric keys"
          htmlFor="x-guardrails"
          hint="Comma-separated. A primary win with a guardrail breach is not supported."
          error={issue('guardrailMetricKeys')}
        >
          <Input
            id="x-guardrails"
            value={form.guardrailMetricKeys}
            onChange={(e) => set('guardrailMetricKeys', e.target.value)}
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">
            Variants (content revisions differing only in the tested attribute)
          </legend>
          {form.variants.map((v, i) => (
            <div key={i} className="grid grid-cols-[4rem_1fr_5rem] items-end gap-2">
              <Field label="Label" htmlFor={`x-v${i}-label`} error={issue(`variants.${i}.label`)}>
                <Input
                  id={`x-v${i}-label`}
                  value={v.label}
                  onChange={(e) => setVariant(i, { label: e.target.value })}
                />
              </Field>
              <Field
                label="Content revision"
                htmlFor={`x-v${i}-revision`}
                error={issue(`variants.${i}.contentRevisionId`)}
              >
                <Input
                  id={`x-v${i}-revision`}
                  value={v.contentRevisionId}
                  onChange={(e) => setVariant(i, { contentRevisionId: e.target.value })}
                  placeholder="cr_…"
                />
              </Field>
              <Field
                label="Weight"
                htmlFor={`x-v${i}-weight`}
                error={issue(`variants.${i}.allocationWeight`)}
              >
                <Input
                  id={`x-v${i}-weight`}
                  type="number"
                  min={0}
                  step="any"
                  value={v.allocationWeight}
                  onChange={(e) => setVariant(i, { allocationWeight: e.target.value })}
                />
              </Field>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={form.variants.length >= 6}
              disabledReason={form.variants.length >= 6 ? 'At most six variants' : undefined}
              onClick={() =>
                set('variants', [
                  ...form.variants,
                  {
                    label: String.fromCharCode(65 + form.variants.length),
                    contentRevisionId: '',
                    allocationWeight: '1',
                  },
                ])
              }
            >
              Add variant
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={form.variants.length <= 2}
              disabledReason={form.variants.length <= 2 ? 'At least two variants' : undefined}
              onClick={() => set('variants', form.variants.slice(0, -1))}
            >
              Remove last variant
            </Button>
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Allocation method" htmlFor="x-allocation" error={issue('allocationMethod')}>
            <Select
              id="x-allocation"
              value={form.allocationMethod}
              onValueChange={(v) => set('allocationMethod', v)}
              options={ALLOCATION_METHODS.map((m) => ({ value: m, label: label(m) }))}
            />
          </Field>
          <Field label="Unit of randomisation" htmlFor="x-unit" error={issue('unitType')}>
            <Select
              id="x-unit"
              value={form.unitType}
              onValueChange={(v) => set('unitType', v)}
              options={UNIT_TYPES.map((u) => ({ value: u, label: label(u) }))}
            />
          </Field>
          <Field
            label="Minimum sample per arm"
            htmlFor="x-sample"
            hint="From a power calculation."
            error={issue('minSamplePerArm')}
          >
            <Input
              id="x-sample"
              type="number"
              min={1}
              value={form.minSamplePerArm}
              onChange={(e) => set('minSamplePerArm', e.target.value)}
            />
          </Field>
          <Field
            label="Observation window (hours)"
            htmlFor="x-window"
            error={issue('observationWindowHours')}
          >
            <Input
              id="x-window"
              type="number"
              min={1}
              value={form.observationWindowHours}
              onChange={(e) => set('observationWindowHours', e.target.value)}
            />
          </Field>
          <Field label="Stopping rule" htmlFor="x-stopping">
            <Select
              id="x-stopping"
              value={form.stoppingRule}
              onValueChange={(v) => set('stoppingRule', v)}
              options={STOPPING_RULES.map((r) => ({ value: r, label: label(r) }))}
            />
          </Field>
          <Field label="Alpha" htmlFor="x-alpha" error={issue('stoppingRule.alpha')}>
            <Input
              id="x-alpha"
              type="number"
              min={0}
              max={1}
              step="0.01"
              value={form.alpha}
              onChange={(e) => set('alpha', e.target.value)}
            />
          </Field>
        </div>
        {issues.length > 0 && (
          <StatusBanner
            tone="critical"
            title="The design is incomplete"
            description={issues.map((i) => `${i.path || 'design'}: ${i.issue}`).join('; ')}
            data-testid="design-issues"
          />
        )}
        {ui && ui.kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${ui.message} Designing an experiment needs experiment.manage for this brand.`}
            data-testid="create-denied"
          />
        )}
        {ui && ui.kind !== 'forbidden' && (
          <RequestError error={create.error} title="The experiment was not created" />
        )}
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create draft'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
