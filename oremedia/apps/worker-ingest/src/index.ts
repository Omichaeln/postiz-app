/** worker-ingest (spec 4.4): task queues ingest-metrics and ingest-comments; listening and crm arrive with Release 2. */
export { composeModules, composeCredentialBroker } from './composition';
export { startIngestWorkers, type IngestWorkersHandle } from './ingest-worker';
export { temporalConfigFromEnv, connectionOptions, type TemporalConfig } from './temporal';
