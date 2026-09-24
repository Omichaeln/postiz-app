import { supportSessions } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** One open, read-only support session per tenant (spec 5.7) so a foreign caller has a session id to escalate. */
export const ACCESS_SEED: SeedExtension = async (db, { tenantId }) => {
  const supportSessionId = newId('supportSession');
  await db.insert(supportSessions).values({
    id: supportSessionId,
    operatorId: newId('user'),
    tenantId,
    reason: 'seeded support session for the cross-tenant harness',
    ticketRef: 'SEED-1',
    consentRecorded: true,
    mode: 'read_only',
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { supportSessionId };
};
