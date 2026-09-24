// Asset library (spec 9): ingestion pipeline, rights, eligibility and delivery.
export { assetService, type AuthoriseUseOptions } from './service';
export { assetIngest, type IngestDeps } from './ingest/pipeline';
export * as ingestSteps from './ingest/steps';
export {
  ClamAvScanner,
  FakeScanner,
  FailClosedScanner,
  ScannerUnavailableError,
  createScannerFromEnv,
  type Scanner,
  type ScanVerdict,
} from './ingest/scanner';
export {
  S3StorageProvider,
  MemoryStorageProvider,
  assertTenantKey,
  parseStorageKey,
  configureStorage,
  createStorageFromEnv,
  readS3Config,
  storage,
  storageKeys,
  type StorageProvider,
  type S3StorageConfig,
  type SignedUrl,
  type StorageObjectHead,
} from './storage';
export {
  compatibleKinds,
  evaluateEligibility,
  rightsExpiryThreshold,
  rightsRequired,
  type EligibilityCandidate,
  type EligibilityRequest,
  type EligibilityVerdict,
  type RightsRecord,
} from './eligibility';
export {
  AssetRepository,
  AssetVersionRepository,
  AssetDerivativeRepository,
  UsageRightsRepository,
  AssetGrantRepository,
  AssetUsageRepository,
  UploadIntentRepository,
} from './repositories';
