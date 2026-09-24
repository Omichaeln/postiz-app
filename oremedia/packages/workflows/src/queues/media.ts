// Workflow entry for task queue `media` (spec 4.4: asset ingestion runs untrusted-input parsers, so it lives on
// worker-render, never on worker-core). Bundled at build time by apps/worker-render into dist/workflows.media.js.
export { assetIngestWorkflowV1 } from '../asset-ingest.workflow.v1';
