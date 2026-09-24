import { ExperimentMode, PreRegistrationV1, UnitType } from '@oremedia/contracts/experiments';
import type { ErrorDetail } from '@oremedia/contracts/errors';
import type { Tone } from '@oremedia/ui';

export interface Chip {
  tone: Tone;
  label: string;
}

/** Spec 16.6 experiment states as the contract defines them; every chip is text plus a glyph (spec 21.3). */
export const EXPERIMENT_STATE_CHIP: Record<string, Chip> = {
  designed: { tone: 'neutral', label: 'Designed' },
  pre_registered: { tone: 'info', label: 'Pre-registered' },
  running: { tone: 'info', label: 'Running' },
  stopped: { tone: 'warning', label: 'Stopped' },
  analysed: { tone: 'good', label: 'Analysed' },
};
export const experimentStateChip = (state: string): Chip =>
  EXPERIMENT_STATE_CHIP[state] ?? { tone: 'neutral', label: `Unknown state (${state})` };

export const MODE_LABEL: Record<string, string> = {
  randomised: 'Randomised',
  structured_comparison: 'Structured comparison',
};
export const modeLabel = (mode: string): string => MODE_LABEL[mode] ?? mode;

/** Spec 16.6: the label is shown verbatim; a structured comparison is always "directional; not causal". */
export const DIRECTIONAL_LABEL = 'directional; not causal';
export const conclusionText = (label: string): string =>
  label === 'causal_when_sound' ? 'Can support causal claims when design and execution are sound' : label;

export const shortHash = (hash: string | null): string => (hash ? `${hash.slice(0, 12)}…` : '—');

export const windowEnd = (startedAt: string, observationWindowHours: number): Date =>
  new Date(new Date(startedAt).getTime() + observationWindowHours * 3600_000);

/**
 * Spec 16.6: results are not declared before the pre-registered sample and window; the server refuses with
 * `window_not_reached_until_<iso>` and `sample_below_<n>_per_arm` details, and `design_changed` when the design
 * no longer hashes to the frozen value. Each is turned into a sentence; unknown issues are shown verbatim.
 */
export function resultsRefusalText(details: readonly ErrorDetail[]): string[] {
  const out: string[] = [];
  for (const d of details) {
    const until = /^window_not_reached_until_(.+)$/.exec(d.issue);
    const sample = /^sample_below_(\d+)_per_arm$/.exec(d.issue);
    if (until?.[1])
      out.push(`The observation window has not ended; it ends ${new Date(until[1]).toLocaleString()}.`);
    else if (sample?.[1]) out.push(`The sample is below the pre-registered minimum of ${sample[1]} per arm.`);
    else if (d.issue === 'design_changed')
      out.push('The design changed after pre-registration, so results against it are rejected.');
    else if (d.issue === 'window_reached' || d.issue === 'sample_reached') continue;
    else out.push(d.path ? `${d.path}: ${d.issue}` : d.issue);
  }
  return out;
}

export const isDesignChanged = (details: readonly ErrorDetail[]): boolean =>
  details.some((d) => d.issue === 'design_changed');

export const formatRate = (rate: number | null): string =>
  rate === null ? 'unavailable' : `${(rate * 100).toFixed(1)}%`;

export const formatPoints = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`;

export function estimateText(estimate: number | null, interval: readonly number[] | null): string {
  if (estimate === null) return 'No estimate (no data in one arm).';
  const ci =
    interval && interval.length === 2
      ? ` (95% interval ${formatPoints(interval[0] as number)} to ${formatPoints(interval[1] as number)})`
      : '';
  return `Difference ${formatPoints(estimate)}${ci}.`;
}

export interface VariantRow {
  label: string;
  contentRevisionId: string;
  allocationWeight: string;
}

export interface DesignForm {
  hypothesis: string;
  mode: string;
  variants: VariantRow[];
  primaryMetricKey: string;
  guardrailMetricKeys: string;
  allocationMethod: string;
  unitType: string;
  minSamplePerArm: string;
  observationWindowHours: string;
  stoppingRule: string;
  alpha: string;
}

export const EMPTY_DESIGN: DesignForm = {
  hypothesis: '',
  mode: 'structured_comparison',
  variants: [
    { label: 'A', contentRevisionId: '', allocationWeight: '1' },
    { label: 'B', contentRevisionId: '', allocationWeight: '1' },
  ],
  primaryMetricKey: '',
  guardrailMetricKeys: '',
  allocationMethod: 'matched_slots',
  unitType: 'publication_slot',
  minSamplePerArm: '30',
  observationWindowHours: '168',
  stoppingRule: 'fixed_horizon',
  alpha: '0.05',
};

export const ALLOCATION_METHODS = ['hashed_visitor', 'matched_slots', 'random'] as const;
export const STOPPING_RULES = ['fixed_horizon', 'sequential_msprt'] as const;
export const MODES = ExperimentMode.options;
export const UNIT_TYPES = UnitType.options;

export type DesignParse =
  { ok: true; design: PreRegistrationV1 } | { ok: false; issues: Array<{ path: string; issue: string }> };

/** The form → the pre-registration document, validated by the contract so the server sees a shaped design. */
export function parseDesign(form: DesignForm): DesignParse {
  const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
  const alpha = num(form.alpha);
  const candidate = {
    v: 1,
    hypothesis: form.hypothesis.trim(),
    mode: form.mode,
    variants: form.variants.map((v) => ({
      label: v.label.trim(),
      contentRevisionId: v.contentRevisionId.trim(),
      allocationWeight: num(v.allocationWeight),
    })),
    primaryMetricKey: form.primaryMetricKey.trim(),
    guardrailMetricKeys: form.guardrailMetricKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    allocationMethod: form.allocationMethod,
    unitType: form.unitType,
    minSamplePerArm: num(form.minSamplePerArm),
    observationWindowHours: num(form.observationWindowHours),
    stoppingRule:
      form.stoppingRule === 'sequential_msprt'
        ? { kind: 'sequential_msprt', alpha, tau: 1 }
        : { kind: 'fixed_horizon', alpha },
  };
  const parsed = PreRegistrationV1.safeParse(candidate);
  if (parsed.success) return { ok: true, design: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), issue: i.message })),
  };
}
