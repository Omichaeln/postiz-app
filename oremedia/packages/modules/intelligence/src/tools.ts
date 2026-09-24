import type { IntelligenceToolSource } from '@oremedia/ai';
import { requiredSamplePerArm } from '@oremedia/domain/experiments/index';
import { experiments, metrics } from './hooks';
import { intelligenceService } from './service';

/** Defaults for an agent-proposed design (spec 10.4 experiment-design): a person completes and pre-registers it. */
export const PROPOSED_DESIGN_DEFAULTS = {
  baselineRate: 0.05,
  minDetectableLift: 0.2,
  observationWindowHours: 24 * 14,
  alpha: 0.05,
} as const;

/**
 * Spec 12.4: what the generic tools in @oremedia/ai reach when this module is composed. Every method runs as the
 * run's service principal inside the tool's transaction; policy is asserted again by the services it calls.
 */
export const intelligenceToolSource: IntelligenceToolSource = {
  async metricsQuery(actor, input, tx) {
    const { values } = await metrics.query(
      actor,
      {
        brandId: input.brandId,
        metricKeys: input.metricKeys,
        windowStart: input.from,
        windowEnd: input.to,
        channelConnectionIds: input.channelConnectionIds,
      },
      tx,
    );
    const byKey = new Map<string, Array<{ at: string; value: number | null; complete: boolean }>>();
    for (const v of values) {
      const points = byKey.get(v.metricKey) ?? [];
      if (v.series)
        for (const p of v.series)
          points.push({ at: p.at, value: p.value, complete: v.completeness === 'complete' });
      else points.push({ at: v.windowEnd, value: v.value, complete: v.completeness === 'complete' });
      byKey.set(v.metricKey, points);
    }
    return {
      series: input.metricKeys.map((metricKey) => ({
        metricKey,
        points: (byKey.get(metricKey) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      })),
    };
  },

  async voiceClusters(actor, input, tx) {
    const { items } = await intelligenceService.voice.clusters(
      actor,
      { brandId: input.brandId, limit: input.limit },
      tx,
    );
    // Labels and counts only: sample references are message ids, never author identities or full texts.
    return {
      clusters: items.map((c) => ({ id: c.id, label: c.label, size: c.size, examples: c.sampleMessageRefs })),
    };
  },

  recommendationsCreate: (actor, input, tx) =>
    intelligenceService.recommendations.createFromRun(actor, input, tx),

  async experimentsProposeDesign(actor, input, tx) {
    const weight = 1 / input.variants.length;
    return experiments.design(
      actor,
      {
        brandId: input.brandId,
        ...(input.recommendationId ? { recommendationId: input.recommendationId } : {}),
        design: {
          v: 1,
          hypothesis: input.hypothesis,
          mode: 'structured_comparison',
          variants: input.variants.map((v) => ({
            label: v.key.slice(0, 80),
            contentRevisionId: '',
            allocationWeight: weight,
          })),
          primaryMetricKey: input.primaryMetricKey,
          guardrailMetricKeys: [],
          guardrailThresholds: {},
          allocationMethod: 'matched_slots',
          unitType: 'publication_slot',
          minSamplePerArm: requiredSamplePerArm(
            PROPOSED_DESIGN_DEFAULTS.baselineRate,
            PROPOSED_DESIGN_DEFAULTS.minDetectableLift,
          ),
          observationWindowHours: PROPOSED_DESIGN_DEFAULTS.observationWindowHours,
          stoppingRule: { kind: 'fixed_horizon', alpha: PROPOSED_DESIGN_DEFAULTS.alpha },
        },
      },
      tx,
      { autonomyMode: input.autonomyMode },
    );
  },
};
