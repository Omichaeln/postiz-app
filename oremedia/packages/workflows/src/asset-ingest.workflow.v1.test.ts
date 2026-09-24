import { describe, expect, it } from 'vitest';
import type {
  AssetIngestActivitiesV1,
  AssetIngestInputV1,
  IngestDerivativeRef,
  IngestStepRejection,
} from '@oremedia/contracts/assets';
import { isFailureOfType, runAssetIngest } from './asset-ingest.workflow.v1';

const input: AssetIngestInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_wf',
  intentId: 'ui_1',
  brandId: 'brd_1',
};

const derivative: IngestDerivativeRef = {
  purpose: 'thumbnail',
  key: 'quarantine/ten_A/ui_1/derivative-thumbnail',
  mime: 'image/webp',
  width: 10,
  height: 10,
  bytes: 100,
  contentHash: 'a'.repeat(64),
  transform: { op: 'resize' },
};

/** Fake activities: every step succeeds unless overridden; every call is recorded in order. */
function fakes(overrides: Partial<AssetIngestActivitiesV1> = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const rec = <K extends keyof AssetIngestActivitiesV1>(name: K, impl: AssetIngestActivitiesV1[K]) =>
    (async (arg: never) => {
      calls.push({ name, input: arg });
      return (impl as (a: never) => unknown)(arg);
    }) as AssetIngestActivitiesV1[K];
  const base: AssetIngestActivitiesV1 = {
    beginIngest: async () => ({
      intentId: 'ui_1',
      brandId: 'brd_1',
      kind: 'photo',
      declaredMime: 'image/png',
      maxBytes: 1000,
      storageKey: 'quarantine/ten_A/ui_1',
    }),
    verifyUpload: async () => ({ ok: true, bytes: 500 }),
    sniffUpload: async () => ({ ok: true, mime: 'image/png', group: 'image' }),
    scanUpload: async () => ({ ok: true, engine: 'fake' }),
    sanitiseUpload: async () => ({
      ok: true,
      sanitisedKey: 'quarantine/ten_A/ui_1/sanitised',
      previewKey: 'quarantine/ten_A/ui_1/preview.png',
      mime: 'image/png',
      bytes: 480,
      width: 64,
      height: 48,
      colourProfile: 'srgb',
      sanitised: true,
    }),
    hashUpload: async () => ({ ok: true, contentHash: 'b'.repeat(64) }),
    buildDerivatives: async () => ({ ok: true, derivatives: [derivative] }),
    moveToImmutable: async () => ({
      assetId: 'ast_1',
      assetVersionId: 'av_1',
      originalKey: 'assets/ten_A/brd_1/ast_1/av_1/original',
      derivatives: [{ ...derivative, key: 'assets/ten_A/brd_1/ast_1/av_1/thumbnail' }],
    }),
    catalogueAsset: async () => ({ assetId: 'ast_1', assetVersionId: 'av_1', state: 'pending_review' }),
    finaliseUpload: async () => undefined,
  };
  const merged = { ...base, ...overrides } as AssetIngestActivitiesV1;
  const acts = Object.fromEntries(
    (Object.keys(merged) as Array<keyof AssetIngestActivitiesV1>).map((k) => [k, rec(k, merged[k])]),
  ) as unknown as AssetIngestActivitiesV1;
  return { acts, calls, names: () => calls.map((c) => c.name) };
}

describe('assetIngestWorkflowV1 orchestration (spec 9.1)', () => {
  it('runs the eight steps in order and finalises as accepted with every intermediate key for cleanup', async () => {
    const f = fakes();
    const result = await runAssetIngest(f.acts, input);
    expect(result).toEqual({
      outcome: 'accepted',
      assetId: 'ast_1',
      assetVersionId: 'av_1',
      state: 'pending_review',
    });
    expect(f.names()).toEqual([
      'beginIngest',
      'verifyUpload',
      'sniffUpload',
      'scanUpload',
      'sanitiseUpload',
      'hashUpload',
      'buildDerivatives',
      'moveToImmutable',
      'catalogueAsset',
      'finaliseUpload',
    ]);
    const finalise = f.calls.at(-1)?.input as { outcome: string; cleanupKeys: string[] };
    expect(finalise.outcome).toBe('accepted');
    expect(finalise.cleanupKeys).toEqual([
      'quarantine/ten_A/ui_1',
      'quarantine/ten_A/ui_1/sanitised',
      'quarantine/ten_A/ui_1/preview.png',
      'quarantine/ten_A/ui_1/derivative-thumbnail',
    ]);
    const catalogue = f.calls.find((c) => c.name === 'catalogueAsset')?.input as Record<string, unknown>;
    expect(catalogue).toMatchObject({
      tenantId: 'ten_A',
      intentId: 'ui_1',
      contentHash: 'b'.repeat(64),
      originalKey: 'assets/ten_A/brd_1/ast_1/av_1/original',
      width: 64,
      sanitised: true,
    });
  });

  it.each<[string, keyof AssetIngestActivitiesV1, IngestStepRejection, string[]]>([
    [
      'a missing object',
      'verifyUpload',
      { ok: false, reason: 'object_missing' },
      ['beginIngest', 'verifyUpload'],
    ],
    [
      'a type mismatch',
      'sniffUpload',
      { ok: false, reason: 'type_mismatch' },
      ['beginIngest', 'verifyUpload', 'sniffUpload'],
    ],
    [
      'a malware hit',
      'scanUpload',
      { ok: false, reason: 'malware_detected' },
      ['beginIngest', 'verifyUpload', 'sniffUpload', 'scanUpload'],
    ],
    [
      'unsafe SVG content',
      'sanitiseUpload',
      { ok: false, reason: 'svg_unsafe_content' },
      ['beginIngest', 'verifyUpload', 'sniffUpload', 'scanUpload', 'sanitiseUpload'],
    ],
  ])(
    '%s rejects the intent with its reason and runs nothing further',
    async (_l, step, rejection, expected) => {
      const f = fakes({ [step]: async () => rejection } as Partial<AssetIngestActivitiesV1>);
      const result = await runAssetIngest(f.acts, input);
      expect(result).toEqual({ outcome: 'rejected', reason: rejection.reason });
      expect(f.names()).toEqual([...expected, 'finaliseUpload']);
      expect(f.calls.at(-1)?.input).toMatchObject({ outcome: 'rejected', reason: rejection.reason });
      expect(f.names()).not.toContain('catalogueAsset');
    },
  );

  it('a duplicate becomes a duplicate_of proposal carrying the existing asset id', async () => {
    const f = fakes({
      hashUpload: async () => ({ ok: false, reason: 'duplicate_of', duplicateOfAssetId: 'ast_existing' }),
    });
    expect(await runAssetIngest(f.acts, input)).toEqual({
      outcome: 'rejected',
      reason: 'duplicate_of',
      duplicateOfAssetId: 'ast_existing',
    });
    expect(f.calls.at(-1)?.input).toMatchObject({ outcome: 'rejected', duplicateOfAssetId: 'ast_existing' });
  });

  it('a scanner without a verdict (after retries) leaves the intent quarantined, never accepted', async () => {
    const activityFailure = Object.assign(new Error('activity failed'), {
      name: 'ActivityFailure',
      cause: Object.assign(new Error('clamd down'), {
        name: 'ApplicationFailure',
        type: 'ScannerUnavailableError',
      }),
    });
    const f = fakes({
      scanUpload: async () => {
        throw activityFailure;
      },
    });
    expect(await runAssetIngest(f.acts, input)).toEqual({
      outcome: 'quarantined',
      reason: 'scanner_unavailable',
    });
    expect(f.calls.at(-1)?.input).toMatchObject({ outcome: 'quarantined', reason: 'scanner_unavailable' });
    expect(f.names()).not.toContain('sanitiseUpload');
  });

  it('any other activity failure propagates (Temporal retries or fails the run)', async () => {
    const f = fakes({
      moveToImmutable: async () => {
        throw new Error('storage exploded');
      },
    });
    await expect(runAssetIngest(f.acts, input)).rejects.toThrow('storage exploded');
    expect(f.names()).not.toContain('finaliseUpload');
  });

  it('isFailureOfType walks the cause chain by type or name', () => {
    expect(isFailureOfType({ name: 'ScannerUnavailableError' }, 'ScannerUnavailableError')).toBe(true);
    expect(
      isFailureOfType(
        { name: 'ActivityFailure', cause: { type: 'ScannerUnavailableError' } },
        'ScannerUnavailableError',
      ),
    ).toBe(true);
    expect(
      isFailureOfType(
        { name: 'ActivityFailure', cause: { type: 'NotFoundError' } },
        'ScannerUnavailableError',
      ),
    ).toBe(false);
    expect(isFailureOfType(null, 'ScannerUnavailableError')).toBe(false);
  });
});
