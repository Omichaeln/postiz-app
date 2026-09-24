import { registerBrandChecker } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import {
  authorHashingFromEnv,
  configureAuthorHashing,
  configureLinkTracking,
  linkTrackingFromEnv,
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
 * here, so tests can compose without a key), the decrypting credential broker. The intelligence module's comment
 * sink is registered by its own composition when that worker hosts it.
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
}

/** Spec 14.7: worker-ingest (with worker-core) is a process whose KMS may decrypt. Loud without a key. */
export function composeCredentialBroker(env: NodeJS.ProcessEnv = process.env): void {
  configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: true }, env) });
}
