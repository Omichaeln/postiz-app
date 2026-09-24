import {
  TenantPurgeRepository,
  purgeOrder,
  requireTenant,
  runAsPlatform,
  tenantScopedTables,
  type PurgeScope,
  type PurgeTableOptions,
  type Tx,
} from '@oremedia/db';
import * as accessSchema from '@oremedia/db/schema/access';
import * as agentsSchema from '@oremedia/db/schema/agents';
import * as assetsSchema from '@oremedia/db/schema/assets';
import * as billingSchema from '@oremedia/db/schema/billing';
import * as brandSchema from '@oremedia/db/schema/brand';
import * as communitySchema from '@oremedia/db/schema/community';
import * as contentSchema from '@oremedia/db/schema/content';
import * as creativeSchema from '@oremedia/db/schema/creative';
import * as experimentsSchema from '@oremedia/db/schema/experiments';
import * as intelligenceSchema from '@oremedia/db/schema/intelligence';
import * as measurementSchema from '@oremedia/db/schema/measurement';
import * as operationsSchema from '@oremedia/db/schema/operations';
import * as publishingSchema from '@oremedia/db/schema/publishing';
import * as reviewSchema from '@oremedia/db/schema/review';
import * as skillsSchema from '@oremedia/db/schema/skills';
import { UserDirectory } from '@oremedia/module-access';
import { parseStorageKey, storage } from '@oremedia/module-assets';
import {
  registerDeletionHandler,
  registerPlatformDeletionSteps,
  registerRetentionHandler,
  type DeletionEvidence,
  type DeletionScope,
} from '@oremedia/module-operations';
import { CredentialRefRepository } from '@oremedia/module-publishing';

type Table = ReturnType<typeof tenantScopedTables>[number];

/**
 * Spec 17.5 retained on a tenant or brand deletion, with the reason. Everything else a module owns is removed
 * (or, for the global identity rows, anonymised). The deletion integration test asserts this list exactly.
 */
export const RETAINED_ON_DELETION: Readonly<Record<string, string>> = {
  audit_events: 'Audit events: 7 years or contract (archive tier); actors are pseudonymous ids.',
  remote_evidence: 'Release evidence: 7 years; ids, hashes and the provider response only.',
  deletion_requests: 'The deletion record itself: which request removed what, with per-step evidence.',
};

/** Brand ownership of tables without brand_id: the brand-owned parent each hangs off. */
const BRAND_VIA: ReadonlyMap<Table, PurgeTableOptions> = new Map<Table, PurgeTableOptions>([
  [
    agentsSchema.agentSteps,
    { brandVia: { column: agentsSchema.agentSteps.runId, parent: agentsSchema.agentRuns } },
  ],
  [
    agentsSchema.toolInvocations,
    { brandVia: { column: agentsSchema.toolInvocations.runId, parent: agentsSchema.agentRuns } },
  ],
  [
    publishingSchema.publicationAttempts,
    {
      brandVia: {
        column: publishingSchema.publicationAttempts.publicationId,
        parent: publishingSchema.publications,
      },
    },
  ],
  [
    skillsSchema.skillVersions,
    { brandVia: { column: skillsSchema.skillVersions.skillId, parent: skillsSchema.skills } },
  ],
  // A brand deletion removes the brand row itself (tenant deletion removes every brand row by tenant_id).
  [brandSchema.brands, { brandColumn: brandSchema.brands.id }],
]);

const repoFor = (table: Table) => new TenantPurgeRepository(table, BRAND_VIA.get(table) ?? {});

const scopeOf = (s: DeletionScope): PurgeScope => (s.brandId ? { brandId: s.brandId } : {});

/** Purges a module's tables children-first, skipping the retained ones; the evidence is rows removed per table. */
async function purgeTables(tables: Table[], scope: DeletionScope, tx: Tx): Promise<DeletionEvidence> {
  const evidence: DeletionEvidence = {};
  for (const table of purgeOrder(tables)) {
    const repo = repoFor(table);
    if (RETAINED_ON_DELETION[repo.name]) continue;
    evidence[repo.name] = await repo.purge(scopeOf(scope), tx);
  }
  return evidence;
}

/**
 * The per-module database handlers, in foreign-key-safe order across modules (a module whose rows reference
 * another module's rows runs first: review → content, publishing → brand, render jobs → creative revisions …).
 */
const MODULE_TABLES: ReadonlyArray<[name: string, module: Record<string, unknown>]> = [
  ['agents', agentsSchema],
  ['review', reviewSchema],
  ['publishing', publishingSchema],
  ['measurement', measurementSchema],
  ['community', communitySchema],
  ['intelligence', intelligenceSchema],
  ['experiments', experimentsSchema],
  ['content', contentSchema],
  ['creative', creativeSchema],
  ['assets', assetsSchema],
  ['skills', skillsSchema],
  ['billing', billingSchema],
  ['brand', brandSchema],
  ['operations', operationsSchema],
  ['access', accessSchema],
];

/** Every tenant-scoped table is owned by exactly one registered handler (the deletion test also enforces this). */
export function deletionCoverage(): { uncovered: string[]; duplicated: string[] } {
  const owned = MODULE_TABLES.flatMap(([, m]) => tenantScopedTables(m).map((t) => repoFor(t).name));
  const all = tenantScopedTables().map((t) => repoFor(t).name);
  return {
    uncovered: all.filter((n) => !owned.includes(n)),
    duplicated: owned.filter((n, i) => owned.indexOf(n) !== i),
  };
}

/**
 * Spec 17.5 fan-out handlers, registered by the worker-core composition root (the process that runs
 * deletionRequestWorkflowV1): credentials are crypto-shredded, object keys deleted, then each module's rows are
 * purged children-first; audit and release evidence stay; the global identity rows are anonymised; the stores
 * with no API from here are recorded as operator actions (operations' platform steps).
 */
export function registerDeletionHandlers(): void {
  // Social tokens (spec 14.7): overwrite the wrapped data key and ciphertext first, so no copy of the row that a
  // backup or a later failure keeps can be opened; the rows themselves go with the publishing handler.
  const credentials = new CredentialRefRepository();
  registerDeletionHandler({
    name: 'credentials',
    store: 'database',
    subjects: ['tenant', 'brand'],
    async run(scope, tx) {
      const ids = new Set(
        await repoFor(publishingSchema.channelConnections).values(
          publishingSchema.channelConnections.credentialRefId,
          scopeOf(scope),
          tx,
        ),
      );
      if (!scope.brandId)
        for (const id of await repoFor(publishingSchema.credentialRefs).values(
          publishingSchema.credentialRefs.id,
          {},
          tx,
        ))
          ids.add(id);
      let shredded = 0;
      for (const id of ids) {
        const row = await credentials.findById(id, tx);
        if (!row || row.destroyedAt) continue;
        await credentials.destroy(row.id, row.version, 'disconnected', tx);
        shredded += 1;
      }
      return { credentials_shredded: shredded, credentials_seen: ids.size };
    },
  });

  // Object storage (spec 9 keys are tenant-prefixed): read the keys from the rows before the rows go.
  registerDeletionHandler({
    name: 'objects',
    store: 'object_storage',
    subjects: ['tenant', 'brand'],
    async run(scope, tx) {
      const keyColumns = [
        [assetsSchema.assetVersions, assetsSchema.assetVersions.storageKey],
        [assetsSchema.assetDerivatives, assetsSchema.assetDerivatives.storageKey],
        [assetsSchema.uploadIntents, assetsSchema.uploadIntents.storageKey],
        [creativeSchema.renderedExports, creativeSchema.renderedExports.storageKey],
      ] as const;
      const { tenantId } = requireTenant();
      const keys = new Set<string>();
      for (const [table, col] of keyColumns)
        for (const k of await repoFor(table).values(col, scopeOf(scope), tx)) keys.add(k);
      let deleted = 0;
      for (const k of keys) {
        // Keys are tenant-prefixed by construction (storageKeys); a key naming another tenant is never touched.
        if (parseStorageKey(k)?.tenantId !== tenantId) continue;
        await storage().deleteObject(k);
        deleted += 1;
      }
      return {
        objects_deleted: deleted,
        versions: 'bucket lifecycle expires noncurrent versions',
        releases: `lifecycle rule expires releases/${tenantId}/`,
      };
    },
  });

  for (const [name, module] of MODULE_TABLES) {
    if (name === 'access') continue; // below: identities are anonymised, not just purged
    registerDeletionHandler({
      name,
      store: 'database',
      subjects: ['tenant', 'brand'],
      run: (scope, tx) => purgeTables(tenantScopedTables(module), scope, tx),
    });
  }

  // Access (spec 17.5 user identity): the tenant's memberships, grants, service principals and API clients go;
  // a user left with no membership anywhere is anonymised (audit keeps the pseudonymous id); the tenant row stays
  // as a tombstone without its name.
  const directory = new UserDirectory();
  registerDeletionHandler({
    name: 'access',
    store: 'database',
    subjects: ['tenant', 'brand'],
    async run(scope, tx) {
      const { correlationId } = requireTenant();
      const userIds = scope.brandId
        ? []
        : await repoFor(accessSchema.memberships).values(accessSchema.memberships.userId, {}, tx);
      const evidence = await purgeTables(tenantScopedTables(accessSchema), scope, tx);
      if (scope.brandId) return evidence;
      let anonymised = 0;
      await runAsPlatform('deletion', correlationId, async () => {
        for (const userId of userIds)
          if (await directory.anonymiseIfUnaffiliated(userId, tx)) anonymised += 1;
        await directory.closeTenant(scope.tenantId, tx);
      });
      return { ...evidence, users_anonymised: anonymised, tenant_tombstoned: 1 };
    },
  });

  // Embeddings and search indexes (spec 17.5): Release 1 keeps none outside the rows (MySQL indexes go with them).
  registerDeletionHandler({
    name: 'indexes',
    store: 'indexes',
    subjects: ['tenant', 'brand'],
    run: async () => ({ external_indexes: 0, note: 'no index store outside MySQL in Release 1' }),
  });

  registerPlatformDeletionSteps();
}

/** Spec 17.5 TTL classes the modules own, with the table(s) each class removes by age. */
export function registerRetentionHandlers(): void {
  const byAge =
    (tables: Table[]) =>
    async (cutoff: Date, dryRun: boolean, tx: Tx): Promise<number> => {
      let rows = 0;
      for (const table of purgeOrder(tables)) {
        const repo = repoFor(table);
        rows += dryRun
          ? await repo.count({ olderThan: cutoff }, tx)
          : await repo.purge({ olderThan: cutoff }, tx);
      }
      return rows;
    };
  // Prompts and agent transcripts: 90 days; run summaries (agent_runs) and hashes are retained.
  registerRetentionHandler({
    name: 'agents.transcripts',
    dataClass: 'agent_transcripts',
    run: byAge([agentsSchema.agentSteps, agentsSchema.toolInvocations]),
  });
  // Provider results and metrics: 25 months rolling.
  registerRetentionHandler({
    name: 'measurement.snapshots',
    dataClass: 'metrics',
    run: byAge([measurementSchema.metricSnapshots, measurementSchema.linkClicks]),
  });
  // Customer voice raw messages: 12 months; clusters are kept with their sample message refs removed.
  registerRetentionHandler({
    name: 'community.messages',
    dataClass: 'customer_voice_raw',
    async run(cutoff, dryRun, tx) {
      const removed = await byAge([communitySchema.messages])(cutoff, dryRun, tx);
      const clusters = repoFor(intelligenceSchema.customerVoiceClusters);
      if (!dryRun) await clusters.anonymise({ sampleMessageRefs: [] }, { olderThan: cutoff }, tx);
      return removed;
    },
  });
}
