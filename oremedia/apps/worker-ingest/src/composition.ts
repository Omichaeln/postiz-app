import { registerBrandChecker } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { intelligenceService } from '@oremedia/module-intelligence';
import {
  authorHashingFromEnv,
  configureAuthorHashing,
  configureLinkTracking,
  linkTrackingFromEnv,
  registerCommentClassifier,
  registerCommentSink,
  registerMeasurementBrandChecker,
} from '@oremedia/module-measurement';
import {
  configureCredentialBroker,
  createKmsFromEnv,
  providerClientsFromEnv,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';

/**
 * Wires what the ingest worker needs (same shape as apps/worker-core/src/composition.ts, smaller): brand checks
 * through the brand module, provider app credentials, the per-tenant author-hash secret and, in the worker (not
 * here, so tests can compose without a key), the decrypting credential broker. Comment ingestion runs here, so the
 * customer-voice library (spec 16.5) is wired here too: the intelligence classifier (its model adapter and model id
 * come from the environment on first use, INTELLIGENCE_CLASSIFIER_MODEL_ID) runs before the ingesting transaction
 * opens, and the sink embeds and clusters inside it.
 */
export function composeModules(env: NodeJS.ProcessEnv = process.env): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  registerPublishingBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerMeasurementBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerProviderClients(providerClientsFromEnv(env));
  configureAuthorHashing(authorHashingFromEnv(env));
  configureLinkTracking(linkTrackingFromEnv(env));
  registerCommentClassifier((comment) => intelligenceService.voice.classify(comment));
  registerCommentSink(async (comments, tx) => {
    for (const c of comments)
      await intelligenceService.voice.ingest(
        {
          brandId: c.brandId,
          messageId: c.messageId,
          text: c.text,
          authorHash: c.authorHash,
          remoteCreatedAt: c.remoteCreatedAt,
          ...(c.classification ? { classification: c.classification } : {}),
        },
        tx,
      );
  });
}

/** Spec 14.7: worker-ingest (with worker-core) is a process whose KMS may decrypt. Loud without a key. */
export function composeCredentialBroker(env: NodeJS.ProcessEnv = process.env): void {
  configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: true }, env) });
}
