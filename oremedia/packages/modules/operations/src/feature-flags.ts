import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { FeatureFlagKey } from '@oremedia/contracts/operations';
import { FeatureFlagKey as FeatureFlagKeySchema } from '@oremedia/contracts/operations';
import { PlatformRepository, currentTenant, runAsPlatform, type Tx } from '@oremedia/db';
import { featureFlags } from '@oremedia/db/schema/operations';

/**
 * Spec 22.1: engineering flags are short-lived, server-enforced, and carry owner, removal date and success metric.
 * Evaluation is a pure function of the stored row and the tenant id; the client never decides.
 */
export interface FlagDefinition {
  key: FeatureFlagKey;
  owner: string;
  removalDate: string;
  successMetric: string;
  enabledDefault: boolean;
}

export const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    key: 'studio.agent_proposals',
    owner: 'creative',
    removalDate: '2027-03-31',
    successMetric: 'proposal acceptance rate ≥ 40 % over 4 weeks',
    enabledDefault: false,
  },
  {
    key: 'publishing.channel.linkedin_page',
    owner: 'publishing',
    removalDate: '2027-03-31',
    successMetric: 'certified; 99 % publications reach published or failed within 1 h',
    enabledDefault: false,
  },
  {
    key: 'publishing.channel.instagram_business',
    owner: 'publishing',
    removalDate: '2027-03-31',
    successMetric: 'certified; same as above',
    enabledDefault: false,
  },
  {
    key: 'publishing.channel.facebook_page',
    owner: 'publishing',
    removalDate: '2027-03-31',
    successMetric: 'certified; same as above',
    enabledDefault: false,
  },
  {
    key: 'publishing.channel.x',
    owner: 'publishing',
    removalDate: '2027-03-31',
    successMetric: 'certified; same as above',
    enabledDefault: false,
  },
  {
    key: 'publishing.channel.tiktok',
    owner: 'publishing',
    removalDate: '2027-03-31',
    successMetric: 'certified; same as above',
    enabledDefault: false,
  },
  {
    key: 'mandates.managed_autopublish',
    owner: 'review',
    removalDate: '2027-06-30',
    successMetric: 'zero unauthorised publications over the managed-autopublish pilot',
    enabledDefault: false,
  },
  {
    key: 'intelligence.brand_analyst',
    owner: 'intelligence',
    removalDate: '2027-03-31',
    successMetric: 'recommendation acceptance ≥ 25 %',
    enabledDefault: false,
  },
  {
    key: 'experiments.randomised',
    owner: 'experiments',
    removalDate: '2027-03-31',
    successMetric: 'one randomised experiment analysed end to end per pilot brand',
    enabledDefault: false,
  },
];

class FlagRepository extends PlatformRepository {
  async get(key: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
    return rows[0] ?? null;
  }
  async all(tx?: Tx) {
    return this.conn(tx).select().from(featureFlags);
  }
}

const repo = new FlagRepository();

/** Flags may be read inside a request (correlate with it) or by a worker outside any tenant context. */
const correlationId = () => currentTenant()?.correlationId ?? 'flags';

export function evaluateFlag(
  row: { enabledDefault: boolean; targeting: { tenantIds?: string[]; percentage?: number } } | null,
  def: FlagDefinition,
  tenantId: string,
): boolean {
  if (!row) return def.enabledDefault;
  if (row.targeting.tenantIds?.includes(tenantId)) return true;
  if (typeof row.targeting.percentage === 'number' && row.targeting.percentage > 0) {
    const bucket =
      parseInt(createHash('sha256').update(`${def.key}:${tenantId}`).digest('hex').slice(0, 8), 16) % 100;
    if (bucket < row.targeting.percentage) return true;
  }
  return row.enabledDefault;
}

export const featureFlag = {
  definitions: FLAG_DEFINITIONS,
  async isEnabled(key: FeatureFlagKey, tenantId: string, tx?: Tx): Promise<boolean> {
    FeatureFlagKeySchema.parse(key);
    const def = FLAG_DEFINITIONS.find((d) => d.key === key);
    if (!def) return false;
    const row = await runAsPlatform('feature-flags', correlationId(), () => repo.get(key, tx));
    return evaluateFlag(row, def, tenantId);
  },
  async snapshot(tenantId: string, tx?: Tx): Promise<Record<FeatureFlagKey, boolean>> {
    const rows = await runAsPlatform('feature-flags', correlationId(), () => repo.all(tx));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = {} as Record<FeatureFlagKey, boolean>;
    for (const def of FLAG_DEFINITIONS)
      out[def.key] = evaluateFlag(byKey.get(def.key) ?? null, def, tenantId);
    return out;
  },
};
