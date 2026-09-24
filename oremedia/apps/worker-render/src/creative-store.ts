import type { RenderJobStore } from '@oremedia/activities';
import { CreativeRevisionRepository, RenderJobRepository, creativeService } from '@oremedia/module-creative';

/**
 * The creative module's render-job surface as the render activities need it (spec 11.5: the worker reports through
 * the module and the job moves only by the render job state machine). The job DTO does not yet carry brandId or
 * documentId, so those two fields are read from the module's public repositories (tenant- and brand-scoped).
 */
export function creativeRenderJobStore(): RenderJobStore {
  const jobs = new RenderJobRepository();
  const revisions = new CreativeRevisionRepository();
  return {
    async getJob(actor, renderJobId) {
      const job = await creativeService.renders.get(actor, { renderJobId }); // re-checks creative.read
      const row = await jobs.getById(renderJobId);
      const revision = await revisions.getById(job.revisionId);
      return {
        renderJobId: job.id,
        state: job.state,
        revisionId: job.revisionId,
        documentId: revision.documentId,
        brandId: row.brandId,
        formatKeys: job.formatKeys,
      };
    },
    async getRevision(actor, documentId, revisionId) {
      const r = await creativeService.revisions.get(actor, { documentId, revisionId });
      return { snapshot: r.snapshot, contentHash: r.contentHash, brandVersionId: r.brandVersionId };
    },
    async markRendering(renderJobId, tx) {
      await creativeService.renders.markRendering({ renderJobId }, tx);
    },
    async markReady(renderJobId, exports, tx) {
      const r = await creativeService.renders.markReady({ renderJobId, exports }, tx);
      return { exportIds: r.exportIds };
    },
    async markFailed(renderJobId, error, tx) {
      await creativeService.renders.markFailed({ renderJobId, error }, tx);
    },
  };
}
