import { describe, expect, it } from 'vitest';
import type {
  RenderFormatResult,
  RenderJobActivitiesV1,
  RenderJobInputV1,
  RenderResolveSuccess,
} from '@oremedia/contracts/render';
import { failureReason, isFailureOfType, runRenderJob } from './render-job.workflow.v1';

const input: RenderJobInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_render',
  renderJobId: 'rj_1',
};

const resolved: RenderResolveSuccess = {
  ok: true,
  rendererVersion: '1.0.0',
  brandVersionId: 'bv_1',
  revisionContentHash: 'c'.repeat(64),
  fonts: [
    {
      assetVersionId: 'av_font',
      storageKey: 'assets/ten_A/brd_1/ast_f/av_font/original',
      contentHash: 'f'.repeat(64),
      mime: 'font/ttf',
    },
  ],
  assets: [
    {
      assetVersionId: 'av_logo',
      storageKey: 'assets/ten_A/brd_1/ast_l/av_logo/original',
      contentHash: 'a'.repeat(64),
      mime: 'image/png',
      width: 400,
      height: 120,
    },
  ],
  targets: [
    { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
    { pageId: 'page_1', formatKey: 'ig_feed_4x5', reflow: true },
  ],
  manifest: {
    rendererVersion: '1.0.0',
    fonts: [{ assetVersionId: 'av_font', contentHash: 'f'.repeat(64) }],
    assets: [{ assetVersionId: 'av_logo', contentHash: 'a'.repeat(64) }],
    brandVersionId: 'bv_1',
    revisionContentHash: 'c'.repeat(64),
  },
};

const renderedFor = (pageId: string, formatKey: string): RenderFormatResult => ({
  pageId,
  formatKey,
  storageKey: `assets/ten_A/brd_1/exports/rev_1/rj_1/${pageId}-${formatKey}.png`,
  contentHash: 'e'.repeat(64),
  bytes: 1234,
  width: 1080,
  height: formatKey === 'ig_feed_4x5' ? 1350 : 1080,
  mime: 'image/png',
  findings: [],
});

/** Fake activities: every step succeeds unless overridden; every call is recorded in order. */
function fakes(overrides: Partial<RenderJobActivitiesV1> = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const rec = <K extends keyof RenderJobActivitiesV1>(name: K, impl: RenderJobActivitiesV1[K]) =>
    (async (arg: never) => {
      calls.push({ name, input: arg });
      return (impl as (a: never) => unknown)(arg);
    }) as RenderJobActivitiesV1[K];
  const base: RenderJobActivitiesV1 = {
    beginRender: async () => ({
      renderJobId: 'rj_1',
      revisionId: 'rev_1',
      documentId: 'doc_1',
      brandId: 'brd_1',
      formatKeys: ['square_1080', 'ig_feed_4x5'],
    }),
    resolveRenderInputs: async () => resolved,
    renderFormat: async (i) => renderedFor(i.target.pageId, i.target.formatKey),
    storeExport: async (i) => ({
      storageKey: i.export.storageKey,
      contentHash: i.export.contentHash,
      bytes: i.export.bytes,
    }),
    completeRender: async (i) => ({ exportIds: i.exports.map((_e, n) => `exp_${n + 1}`) }),
    failRender: async () => undefined,
  };
  const merged = { ...base, ...overrides } as RenderJobActivitiesV1;
  const acts = Object.fromEntries(
    (Object.keys(merged) as Array<keyof RenderJobActivitiesV1>).map((k) => [k, rec(k, merged[k])]),
  ) as unknown as RenderJobActivitiesV1;
  return { acts, calls, names: () => calls.map((c) => c.name) };
}

const activityFailure = (type: string, message = type) =>
  Object.assign(new Error('activity failed'), {
    name: 'ActivityFailure',
    cause: Object.assign(new Error(message), { name: 'ApplicationFailure', type }),
  });

describe('renderJobWorkflowV1 orchestration (spec 11.5, 13.1)', () => {
  it('begins, resolves, renders and verifies every target in order, then completes as ready', async () => {
    const f = fakes();
    const result = await runRenderJob(f.acts, input);
    expect(result).toEqual({ outcome: 'ready', exportIds: ['exp_1', 'exp_2'] });
    expect(f.names()).toEqual([
      'beginRender',
      'resolveRenderInputs',
      'renderFormat',
      'storeExport',
      'renderFormat',
      'storeExport',
      'completeRender',
    ]);
    const renders = f.calls
      .filter((c) => c.name === 'renderFormat')
      .map((c) => c.input as Record<string, unknown>);
    expect(renders[0]).toMatchObject({
      tenantId: 'ten_A',
      renderJobId: 'rj_1',
      revisionId: 'rev_1',
      documentId: 'doc_1',
      brandId: 'brd_1',
      brandVersionId: 'bv_1',
      rendererVersion: '1.0.0',
      target: { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
      fonts: resolved.fonts,
      assets: resolved.assets,
    });
    expect(renders[1]).toMatchObject({ target: { formatKey: 'ig_feed_4x5', reflow: true } });
    const complete = f.calls.at(-1)?.input as Record<string, unknown>;
    expect(complete).toMatchObject({
      renderJobId: 'rj_1',
      rendererVersion: '1.0.0',
      manifest: resolved.manifest,
    });
    expect((complete['exports'] as RenderFormatResult[]).map((e) => e.formatKey)).toEqual([
      'square_1080',
      'ig_feed_4x5',
    ]);
    expect(f.names()).not.toContain('failRender');
  });

  it('a missing (ineligible) asset fails the job with rights_ineligible and renders nothing', async () => {
    const f = fakes({
      resolveRenderInputs: async () => ({
        ok: false,
        reason: 'rights_ineligible',
        detail: 'av_photo: rights_expired',
      }),
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'rights_ineligible' });
    expect(f.names()).toEqual(['beginRender', 'resolveRenderInputs', 'failRender']);
    expect(f.calls.at(-1)?.input).toMatchObject({
      renderJobId: 'rj_1',
      reason: 'rights_ineligible',
      detail: 'av_photo: rights_expired',
    });
  });

  it('a RightsIneligibleError thrown by an activity (non-retryable) also ends as rights_ineligible', async () => {
    const f = fakes({
      resolveRenderInputs: async () => {
        throw activityFailure('RightsIneligibleError', 'An asset is not eligible for this use');
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'rights_ineligible' });
    expect(f.calls.at(-1)?.input).toMatchObject({
      reason: 'rights_ineligible',
      detail: 'An asset is not eligible for this use',
    });
  });

  it('a storage failure after render (retries exhausted) fails the job with storage_failed', async () => {
    let attempts = 0;
    const f = fakes({
      storeExport: async () => {
        attempts += 1;
        throw activityFailure('Error', 'object store unreachable');
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'storage_failed' });
    // The workflow sees one exhausted failure (Temporal retried the activity itself); it never completes.
    expect(attempts).toBe(1);
    expect(f.names()).toEqual([
      'beginRender',
      'resolveRenderInputs',
      'renderFormat',
      'storeExport',
      'failRender',
    ]);
    expect(f.calls.at(-1)?.input).toMatchObject({
      reason: 'storage_failed',
      detail: 'object store unreachable',
    });
  });

  it('a render failure after retries fails the job with render_failed; a later format never runs', async () => {
    const f = fakes({
      renderFormat: async (i) => {
        if (i.target.formatKey === 'ig_feed_4x5') throw activityFailure('Error', 'browser crashed');
        return renderedFor(i.target.pageId, i.target.formatKey);
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'render_failed' });
    expect(f.names()).toEqual([
      'beginRender',
      'resolveRenderInputs',
      'renderFormat',
      'storeExport',
      'renderFormat',
      'failRender',
    ]);
  });

  it('an export whose stored bytes do not match fails with export_integrity', async () => {
    const f = fakes({
      storeExport: async () => {
        throw activityFailure('RenderIntegrityError', 'Stored export does not match the rendered bytes');
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'export_integrity' });
  });

  it('a job that is no longer pending fails with illegal_state without rendering', async () => {
    const f = fakes({
      beginRender: async () => {
        throw activityFailure('ValidationFailedError', 'Render job is ready');
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'illegal_state' });
    expect(f.names()).toEqual(['beginRender', 'failRender']);
  });

  it('a job or revision missing in the tenant fails with not_found', async () => {
    const f = fakes({
      beginRender: async () => {
        throw activityFailure('NotFoundError', 'RenderJob not found');
      },
    });
    expect(await runRenderJob(f.acts, input)).toEqual({ outcome: 'failed', reason: 'not_found' });
  });

  it('failureReason maps failure types by phase; isFailureOfType walks the cause chain', () => {
    expect(failureReason(activityFailure('PolicyDeniedError'), 'resolve')).toBe('policy_denied');
    expect(failureReason(activityFailure('IllegalTransitionError'), 'complete')).toBe('illegal_state');
    expect(failureReason(activityFailure('Error'), 'complete')).toBe('storage_failed');
    expect(failureReason(activityFailure('Error'), 'render')).toBe('render_failed');
    expect(failureReason(new Error('x'), 'resolve')).toBe('render_failed');
    expect(
      isFailureOfType({ name: 'ActivityFailure', cause: { type: 'NotFoundError' } }, 'NotFoundError'),
    ).toBe(true);
    expect(isFailureOfType(null, 'NotFoundError')).toBe(false);
  });
});
