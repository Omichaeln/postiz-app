import { and, eq } from 'drizzle-orm';
import type { KillSwitchScope } from '@oremedia/contracts/operations';
import { TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import { killSwitches } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { audit } from './audit';

class KillSwitchRepository extends TenantScopedRepository<typeof killSwitches> {
  constructor() {
    super(killSwitches);
  }
  async find(brandId: string, scope: KillSwitchScope, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(killSwitches)
      .where(this.scope(and(eq(killSwitches.brandId, brandId), eq(killSwitches.scope, scope))))
      .limit(1);
    return rows[0] ?? null;
  }
  async upsertEngaged(
    brandId: string,
    scope: KillSwitchScope,
    engaged: boolean,
    reason: string | null,
    byUserId: string,
    tx?: Tx,
  ) {
    const existing = await this.find(brandId, scope, tx);
    if (existing) {
      await this.updateScoped(
        existing.id,
        existing.version,
        { engaged, reason, engagedByUserId: byUserId },
        tx,
      );
      return existing.id;
    }
    const id = newId('incident');
    await this.insertScoped({ id, brandId, scope, engaged, reason, engagedByUserId: byUserId }, tx);
    return id;
  }
}

const repo = new KillSwitchRepository();

/** Spec 13.4 kill_switch_off and 23.3: disable new agent starts and release dispatch independently. */
export const killSwitch = {
  /** Engaged if the brand switch or the tenant-wide switch ('' brand) is on. */
  async isOn(scope: KillSwitchScope, brandId?: string, tx?: Tx): Promise<boolean> {
    const tenantWide = await repo.find('', scope, tx);
    if (tenantWide?.engaged) return true;
    if (brandId) {
      const b = await repo.find(brandId, scope, tx);
      if (b?.engaged) return true;
    }
    return false;
  },
  async set(
    scope: KillSwitchScope,
    brandId: string | null,
    engaged: boolean,
    reason: string | null,
    actor: { kind: string; id: string },
    tx?: Tx,
  ): Promise<void> {
    const ctx = requireTenant();
    const id = await repo.upsertEngaged(brandId ?? '', scope, engaged, reason, actor.id, tx);
    await audit.record(
      actor,
      engaged ? 'kill_switch.engage' : 'kill_switch.release',
      { type: 'kill_switch', id },
      'allowed',
      tx,
      { scope, brandId: brandId ?? ctx.tenantId, reason },
    );
  },
};
