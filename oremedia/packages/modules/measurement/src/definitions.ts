import type { z } from 'zod';
import { ConflictError } from '@oremedia/contracts/errors';
import {
  MetricDefinitionCreate,
  MetricDefinitionGet,
  MetricDefinitionList,
} from '@oremedia/contracts/measurement';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { requireTenant, runAsPlatform, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit } from '@oremedia/module-operations';
import { aggregationFor, comparableGroupFor, DERIVED_RATES } from './normalise';
import { MetricDefinitionRepository, MetricDefinitionSeedRepository } from './repositories';

/**
 * Spec 15.1 metric definitions: global rows (tenant_id NULL) are seeded from every certified provider's
 * capability analytics lists (provider-native name, unit, aggregation, comparable_group, definition_version);
 * tenants add their own (derived or business metrics) under their tenant id.
 */
const definitionsRepo = new MetricDefinitionRepository();
const seedRepo = new MetricDefinitionSeedRepository();

export const toDefinitionDto = (d: Awaited<ReturnType<MetricDefinitionRepository['getById']>>) => ({
  id: d.id,
  scope: d.tenantId ? ('tenant' as const) : ('global' as const),
  key: d.key,
  providerKey: d.providerKey,
  nativeName: d.nativeName,
  unit: d.unit,
  aggregation: d.aggregation,
  comparableGroup: d.comparableGroup,
  definitionVersion: d.definitionVersion,
  separatesPaidOrganic: d.separatesPaidOrganic,
  definition: d.definition,
  createdAt: d.createdAt.toISOString(),
});

const tenantResource = () => {
  const { tenantId } = requireTenant();
  return { type: 'tenant', tenantId, id: tenantId };
};

/** The global rows a capability implies: one per post and account metric plus the derived rates (no provider). */
export function globalDefinitionsFor(capability: ProviderCapabilityV1) {
  const names = [...new Set([...capability.analytics.post, ...capability.analytics.account])];
  return names.map((nativeName) => ({
    key: nativeName.slice(0, 80),
    providerKey: capability.key,
    nativeName: nativeName.slice(0, 120),
    unit: 'count',
    aggregation: aggregationFor(nativeName),
    comparableGroup: comparableGroupFor(nativeName),
    definitionVersion: 1,
    separatesPaidOrganic: /organic|paid|sponsored/i.test(nativeName),
    definition: `${capability.key} v${capability.version} ${nativeName}`,
  }));
}

export const derivedRateDefinitions = () =>
  DERIVED_RATES.map((r) => ({
    key: r.key,
    providerKey: null,
    nativeName: r.key,
    unit: 'ratio',
    aggregation: 'last' as const,
    comparableGroup: `rate:${r.numerator}/${r.denominator}`,
    definitionVersion: 1,
    separatesPaidOrganic: false,
    definition: `${r.numerator} / ${r.denominator} (spec 15.2 derived rate)`,
  }));

export const definitionService = {
  /**
   * Idempotent seeding under a declared platform job (composition roots call it at start): rows that exist for
   * (key, providerKey, definitionVersion) are left alone; the register never edits a definition in place.
   */
  async seedGlobal(
    capabilities: ProviderCapabilityV1[],
    correlationId = 'metric-definition-seed',
  ): Promise<number> {
    return runAsPlatform('metric-definition-seed', correlationId, async () => {
      let inserted = 0;
      const wanted = [...capabilities.flatMap(globalDefinitionsFor), ...derivedRateDefinitions()];
      const byProvider = new Map<string | null, typeof wanted>();
      for (const w of wanted) byProvider.set(w.providerKey, [...(byProvider.get(w.providerKey) ?? []), w]);
      for (const [providerKey, defs] of byProvider) {
        const existing = new Set(
          (await seedRepo.listGlobal(providerKey)).map((d) => `${d.key}@${d.definitionVersion}`),
        );
        const missing = defs.filter((d) => !existing.has(`${d.key}@${d.definitionVersion}`));
        await seedRepo.insertGlobal(missing.map((d) => ({ id: newId('metricDefinition'), ...d })));
        inserted += missing.length;
      }
      return inserted;
    });
  },

  async list(actor: ResolvedActor, input: z.infer<typeof MetricDefinitionList>, tx?: Tx) {
    const parsed = MetricDefinitionList.parse(input);
    await policy.assert(actor, 'insight.read', tenantResource(), {}, tx);
    return (await definitionsRepo.list(parsed.providerKey, tx)).map(toDefinitionDto);
  },

  async get(actor: ResolvedActor, input: z.infer<typeof MetricDefinitionGet>, tx?: Tx) {
    const parsed = MetricDefinitionGet.parse(input);
    await policy.assert(actor, 'insight.read', tenantResource(), {}, tx);
    return toDefinitionDto(await definitionsRepo.getById(parsed.definitionId, tx));
  },

  /** insight.manage: a tenant definition; the same (key, providerKey, version) twice is a conflict. */
  async create(actor: ResolvedActor, input: z.infer<typeof MetricDefinitionCreate>, tx: Tx) {
    const parsed = MetricDefinitionCreate.parse(input);
    await policy.assert(actor, 'insight.manage', tenantResource(), {}, tx);
    const prior = await definitionsRepo.findTenantDefined(parsed.key, parsed.providerKey, tx);
    if (prior && prior.definitionVersion >= parsed.definitionVersion)
      throw new ConflictError('MetricDefinition', prior.id, prior.definitionVersion);
    const id = newId('metricDefinition');
    await definitionsRepo.create(
      {
        id,
        key: parsed.key,
        providerKey: parsed.providerKey,
        nativeName: parsed.nativeName,
        unit: parsed.unit,
        aggregation: parsed.aggregation,
        comparableGroup: parsed.comparableGroup,
        definitionVersion: parsed.definitionVersion,
        separatesPaidOrganic: parsed.separatesPaidOrganic,
        definition: parsed.definition ?? null,
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'measurement.definitions.create',
      { type: 'metric_definition', id },
      'allowed',
      tx,
      { key: parsed.key, providerKey: parsed.providerKey, definitionVersion: parsed.definitionVersion },
    );
    return toDefinitionDto(await definitionsRepo.getById(id, tx));
  },

  /** Read-only lookup for the collector and the query service (no policy: the caller asserted its own action). */
  resolve: (key: string, providerKey: string | null, tx?: Tx) =>
    definitionsRepo.findLatest(key, providerKey, tx),
};
