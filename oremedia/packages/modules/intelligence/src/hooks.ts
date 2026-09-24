import type { MetricCoverageV1, MetricValueV1 } from '@oremedia/contracts/measurement';
import type { ExperimentDesign } from '@oremedia/contracts/experiments';
import type { AnalystTargetV1 } from '@oremedia/contracts/intelligence';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import type { z } from 'zod';

/**
 * Cross-module hooks (same pattern as the publishing module's hooks.ts: modules never import each other's
 * tables). The composition root wires the measurement module's metrics query, the experiments module's create and
 * list, the publication calendar and the analyst targets; until then the defaults are loud so a composition
 * mistake cannot pass silently.
 */

/**
 * Spec 15.2 / 16.3: metric snapshots with freshness and coverage for a brand and window; the measurement module
 * registers its query (the composition root adapts subjects: the analyst asks by brand, never by publication).
 */
export interface MetricsWindowQuery {
  brandId: string;
  metricKeys: string[];
  windowStart: string;
  windowEnd: string;
  channelConnectionIds: string[];
}
export type MetricsSource = (
  actor: ResolvedActor,
  query: MetricsWindowQuery,
  tx?: Tx,
) => Promise<{ values: MetricValueV1[]; coverage: MetricCoverageV1 }>;
export class MetricsSourceUnregisteredError extends Error {
  constructor() {
    super('metrics source not registered (composition root must call registerMetricsSource)');
    this.name = 'MetricsSourceUnregisteredError';
  }
}
const unregisteredMetricsSource: MetricsSource = async () => {
  throw new MetricsSourceUnregisteredError();
};
let metricsSource: MetricsSource = unregisteredMetricsSource;
export const registerMetricsSource = (fn: MetricsSource): void => {
  metricsSource = fn;
};
export const resetMetricsSource = (): void => {
  metricsSource = unregisteredMetricsSource;
};
export const metrics = {
  query: (actor: ResolvedActor, query: MetricsWindowQuery, tx?: Tx) => metricsSource(actor, query, tx),
};

/** Spec 16.4 prepare_test / 12.4 experiments.proposeDesign: the experiments module registers its create. */
export type ExperimentDesigner = (
  actor: ResolvedActor,
  input: z.infer<typeof ExperimentDesign>,
  tx: Tx,
  opts?: { autonomyMode?: AutonomyMode },
) => Promise<{ experimentId: string }>;
const unregisteredDesigner: ExperimentDesigner = async () => {
  throw new Error(
    'experiment designer not registered (composition root must call registerExperimentDesigner)',
  );
};
let experimentDesigner: ExperimentDesigner = unregisteredDesigner;
export const registerExperimentDesigner = (fn: ExperimentDesigner): void => {
  experimentDesigner = fn;
};
export const resetExperimentDesigner = (): void => {
  experimentDesigner = unregisteredDesigner;
};
export const experiments = {
  design: (
    actor: ResolvedActor,
    input: z.infer<typeof ExperimentDesign>,
    tx: Tx,
    opts?: { autonomyMode?: AutonomyMode },
  ) => experimentDesigner(actor, input, tx, opts),
};

/** Spec 16.9 "Experiments" view: the experiments module registers its brand listing (any shape; shown as data). */
export interface ExperimentSummary {
  id: string;
  hypothesis: string;
  mode: string;
  conclusionLabel: string;
  state: string;
  recommendationId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  latestResult: { verdict: string; verdictReason: string; computedAt: string } | null;
}
export type ExperimentSource = (brandId: string, tx?: Tx) => Promise<ExperimentSummary[]>;
let experimentSource: ExperimentSource = async () => [];
export const registerExperimentSource = (fn: ExperimentSource): void => {
  experimentSource = fn;
};
export const experimentsForBrand = (brandId: string, tx?: Tx): Promise<ExperimentSummary[]> =>
  experimentSource(brandId, tx);

/**
 * Spec 16.8 exploration: "enough volume" is publications per month on the brand; the publishing module registers
 * its calendar count. Absent, the volume is zero and nothing is explored.
 */
export type PublicationVolumeSource = (brandId: string, from: Date, to: Date, tx?: Tx) => Promise<number>;
let volumeSource: PublicationVolumeSource = async () => 0;
export const registerPublicationVolumeSource = (fn: PublicationVolumeSource): void => {
  volumeSource = fn;
};
export const publicationVolume = (brandId: string, from: Date, to: Date, tx?: Tx): Promise<number> =>
  volumeSource(brandId, from, to, tx);

/**
 * The weekly analyst sweep and the monthly baseline comparison need every active brand with the service
 * principal that acts for it; that listing spans tenants and belongs to the composition root (brand and access
 * modules), never to this module.
 */
export type AnalystTargetSource = (correlationId: string) => Promise<AnalystTargetV1[]>;
const unregisteredTargets: AnalystTargetSource = async () => {
  throw new Error(
    'analyst target source not registered (composition root must call registerAnalystTargetSource)',
  );
};
let targetSource: AnalystTargetSource = unregisteredTargets;
export const registerAnalystTargetSource = (fn: AnalystTargetSource): void => {
  targetSource = fn;
};
export const resetAnalystTargetSource = (): void => {
  targetSource = unregisteredTargets;
};
export const analystTargets = (correlationId: string): Promise<AnalystTargetV1[]> =>
  targetSource(correlationId);
