// Workflow entry for task queue `render` (spec 4.4: worker-render). Bundled at build time by apps/worker-render
// (bundleWorkflowCode) into dist/workflows.render.js; only what this queue serves is exported here.
export { renderJobWorkflowV1 } from '../render-job.workflow.v1';
