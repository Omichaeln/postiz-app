import { proxyActivities } from '@temporalio/workflow';
import type {
  RenderFailureReason,
  RenderFormatResult,
  RenderJobActivitiesV1,
  RenderJobInputV1,
  RenderJobResultV1,
} from '@oremedia/contracts/render';

/**
 * Spec 11.5: creative.renders.request → renderJobWorkflowV1 on task queue `render` (workflow id
 * `render:<renderJobId>`). Deterministic orchestration only: begin (job → rendering), resolve the pinned inputs
 * (fonts, asset versions, hashes, targets), render every (page, format) as its own activity so a slow format is
 * retried alone, verify each stored export, then complete (job → ready with the export rows) or fail with a reason.
 * Every activity re-establishes tenant context (spec 5.2). Once deployed this file is immutable; changes ship as v2.
 */

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state, ineligible rights). */
const NON_RETRYABLE_ERROR_TYPES = [
  'PolicyDeniedError',
  'NotFoundError',
  'ValidationFailedError',
  'ConflictError',
  'TenantContextMissingError',
  'IllegalTransitionError',
  'RightsIneligibleError',
  'RenderIntegrityError',
];

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for a failure type or error name. */
export function isFailureOfType(err: unknown, type: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string; name?: string; cause?: unknown };
    if (e.type === type || e.name === type) return true;
    current = e.cause;
  }
  return false;
}

/** Maps an exhausted activity failure to the reason recorded on the job. */
export function failureReason(
  err: unknown,
  phase: 'begin' | 'resolve' | 'render' | 'store' | 'complete',
): RenderFailureReason {
  if (isFailureOfType(err, 'RightsIneligibleError')) return 'rights_ineligible' as const;
  if (isFailureOfType(err, 'NotFoundError')) return 'not_found' as const;
  if (isFailureOfType(err, 'PolicyDeniedError')) return 'policy_denied' as const;
  if (isFailureOfType(err, 'RenderIntegrityError')) return 'export_integrity' as const;
  if (isFailureOfType(err, 'IllegalTransitionError') || isFailureOfType(err, 'ValidationFailedError'))
    return 'illegal_state' as const;
  if (phase === 'store' || phase === 'complete') return 'storage_failed' as const;
  return 'render_failed' as const;
}

function detailOf(err: unknown): string {
  let current: unknown = err;
  let last = '';
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (typeof e.message === 'string' && e.message) last = e.message;
    current = e.cause;
  }
  return last.slice(0, 500);
}

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runRenderJob(
  acts: RenderJobActivitiesV1,
  input: RenderJobInputV1,
): Promise<RenderJobResultV1> {
  const fail = async (reason: RenderFailureReason, detail?: string): Promise<RenderJobResultV1> => {
    await acts.failRender({ ...input, reason, ...(detail ? { detail } : {}) });
    return { outcome: 'failed', reason };
  };

  let phase: 'begin' | 'resolve' | 'render' | 'store' | 'complete' = 'begin';
  try {
    const begun = await acts.beginRender(input); // job → rendering (idempotent for a re-delivered begin)
    phase = 'resolve';
    const resolved = await acts.resolveRenderInputs({ ...input, ...begun });
    if (!resolved.ok) return fail(resolved.reason, resolved.detail);

    phase = 'render';
    const exports: RenderFormatResult[] = [];
    for (const target of resolved.targets) {
      // Sequential: one browser context per job and bounded memory; each target has its own retry budget.
      const rendered = await acts.renderFormat({
        ...input,
        revisionId: begun.revisionId,
        documentId: begun.documentId,
        brandId: begun.brandId,
        brandVersionId: resolved.brandVersionId,
        target,
        fonts: resolved.fonts,
        assets: resolved.assets,
        rendererVersion: resolved.rendererVersion,
      });
      phase = 'store';
      const stored = await acts.storeExport({ ...input, brandId: begun.brandId, export: rendered });
      exports.push({ ...rendered, ...stored });
      phase = 'render';
    }

    phase = 'complete';
    const completed = await acts.completeRender({
      ...input,
      rendererVersion: resolved.rendererVersion,
      manifest: resolved.manifest,
      exports,
    });
    return { outcome: 'ready', exportIds: completed.exportIds };
  } catch (err) {
    // Retries are exhausted (or the error was non-retryable): the job must not stay in `rendering`. failRender
    // is tolerant of a job that never left `pending` or is already terminal (it records nothing then).
    return fail(failureReason(err, phase), detailOf(err));
  }
}

export async function renderJobWorkflowV1(input: RenderJobInputV1): Promise<RenderJobResultV1> {
  const fast = proxyActivities<RenderJobActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Rendering launches Chromium, loads every pinned font and asset and heartbeats while it draws.
  const heavy = proxyActivities<RenderJobActivitiesV1>({
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      initialInterval: '10s',
      maximumInterval: '2 minutes',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runRenderJob(
    {
      beginRender: fast.beginRender,
      resolveRenderInputs: fast.resolveRenderInputs,
      renderFormat: heavy.renderFormat,
      storeExport: fast.storeExport,
      completeRender: fast.completeRender,
      failRender: fast.failRender,
    },
    input,
  );
}
