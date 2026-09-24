import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { requireTenant } from '@oremedia/db';
import { logger } from '@oremedia/observability';

/**
 * Spec 9.1 / 20.2: the storage abstraction ported as a pattern from Postiz's upload interface, with tenant-prefixed
 * keys enforced by the implementation, `headObject`/`copyObject`/`deleteObject` added and no local-disk storage in
 * production. Every key is `quarantine/{tenant}/...`, `assets/{tenant}/{brand}/{asset}/{version}/...` or
 * `releases/{tenant}/...`; a key that does not carry the *current* tenant's prefix is refused before any I/O.
 */
export type StoragePrefix = 'quarantine' | 'assets' | 'releases';

export interface StorageObjectHead {
  bytes: number;
  contentType: string | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/** Inclusive byte range, as in HTTP Range. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageProvider {
  signUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }): Promise<SignedUrl>;
  signDownloadUrl(key: string, opts: { expiresInSec: number }): Promise<SignedUrl>;
  headObject(key: string): Promise<StorageObjectHead | null>;
  getObject(key: string, range?: ByteRange): Promise<Buffer | null>;
  putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  copyObject(fromKey: string, toKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

/** Key builders: the only way keys are made, so the prefix and tenant segment can never be omitted. */
export const storageKeys = {
  /** The presigned PUT target (spec 9.1) and, with `part`, the pipeline's intermediate objects. */
  quarantine: (tenantId: string, intentId: string, part?: string): string =>
    part ? `quarantine/${tenantId}/${intentId}/${part}` : `quarantine/${tenantId}/${intentId}`,
  original: (tenantId: string, brandId: string, assetId: string, versionId: string): string =>
    `assets/${tenantId}/${brandId}/${assetId}/${versionId}/original`,
  derivative: (
    tenantId: string,
    brandId: string,
    assetId: string,
    versionId: string,
    purpose: string,
  ): string => `assets/${tenantId}/${brandId}/${assetId}/${versionId}/${purpose}`,
  release: (tenantId: string, brandId: string, versionId: string, purpose: string, nonce: string): string =>
    `releases/${tenantId}/${brandId}/${versionId}/${purpose}/${nonce}`,
};

const KEY_PATTERN = /^(quarantine|assets|releases)\/([A-Za-z0-9_]+)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export function parseStorageKey(key: string): { prefix: StoragePrefix; tenantId: string } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m || key.includes('..')) return null;
  return { prefix: m[1] as StoragePrefix, tenantId: m[2] as string };
}

/** Refuses a malformed key or one carrying another tenant's prefix. Requires tenant context (spec 5.2). */
export function assertTenantKey(key: string): { prefix: StoragePrefix; tenantId: string } {
  const parsed = parseStorageKey(key);
  if (!parsed) throw new PolicyDeniedError('storage_key_malformed', 'Storage key is not valid');
  const { tenantId } = requireTenant();
  if (parsed.tenantId !== tenantId)
    throw new PolicyDeniedError('storage_key_tenant_mismatch', 'Storage key belongs to another tenant');
  return parsed;
}

/** Template base: every public operation checks the key against the current tenant, then delegates. Methods are
 *  async so a refused key is always a rejection, never a synchronous throw from a Promise-returning API. */
abstract class TenantPrefixedStorage implements StorageProvider {
  async signUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }): Promise<SignedUrl> {
    assertTenantKey(key);
    return this.doSignUploadUrl(key, opts);
  }
  async signDownloadUrl(key: string, opts: { expiresInSec: number }): Promise<SignedUrl> {
    assertTenantKey(key);
    return this.doSignDownloadUrl(key, opts);
  }
  async headObject(key: string): Promise<StorageObjectHead | null> {
    assertTenantKey(key);
    return this.doHeadObject(key);
  }
  async getObject(key: string, range?: ByteRange): Promise<Buffer | null> {
    assertTenantKey(key);
    return this.doGetObject(key, range);
  }
  async putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    assertTenantKey(key);
    return this.doPutObject(key, body, opts);
  }
  async copyObject(fromKey: string, toKey: string): Promise<void> {
    assertTenantKey(fromKey);
    assertTenantKey(toKey);
    return this.doCopyObject(fromKey, toKey);
  }
  async deleteObject(key: string): Promise<void> {
    assertTenantKey(key);
    return this.doDeleteObject(key);
  }

  protected abstract doSignUploadUrl(
    key: string,
    opts: { contentType: string; expiresInSec: number },
  ): Promise<SignedUrl>;
  protected abstract doSignDownloadUrl(key: string, opts: { expiresInSec: number }): Promise<SignedUrl>;
  protected abstract doHeadObject(key: string): Promise<StorageObjectHead | null>;
  protected abstract doGetObject(key: string, range?: ByteRange): Promise<Buffer | null>;
  protected abstract doPutObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  protected abstract doCopyObject(fromKey: string, toKey: string): Promise<void>;
  protected abstract doDeleteObject(key: string): Promise<void>;
}

export interface S3StorageConfig {
  /** R2 or any S3-compatible endpoint; omitted for AWS S3 proper. */
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  buckets: { assets: string; releases: string };
  forcePathStyle?: boolean;
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** AWS SDK v3 provider; works for Cloudflare R2 via `OBJECT_STORE_ENDPOINT`. Buckets are private; access is presigned. */
export class S3StorageProvider extends TenantPrefixedStorage {
  private readonly client: S3Client;
  constructor(
    private readonly cfg: S3StorageConfig,
    client?: S3Client,
  ) {
    super();
    this.client =
      client ??
      new S3Client({
        region: cfg.region,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
        ...(cfg.accessKeyId && cfg.secretAccessKey
          ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
          : {}),
      });
  }

  /** Release derivatives live in the releases bucket (spec 9.3); everything else in the assets bucket. */
  bucketForKey(key: string): string {
    return key.startsWith('releases/') ? this.cfg.buckets.releases : this.cfg.buckets.assets;
  }

  protected async doSignUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucketForKey(key), Key: key, ContentType: opts.contentType }),
      { expiresIn: opts.expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + opts.expiresInSec * 1000) };
  }
  protected async doSignDownloadUrl(key: string, opts: { expiresInSec: number }) {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucketForKey(key), Key: key }),
      { expiresIn: opts.expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + opts.expiresInSec * 1000) };
  }
  protected async doHeadObject(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
      return { bytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  protected async doGetObject(key: string, range?: ByteRange) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketForKey(key),
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  protected async doPutObject(key: string, body: Buffer, opts: { contentType: string }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketForKey(key),
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
  }
  protected async doCopyObject(fromKey: string, toKey: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketForKey(toKey),
        Key: toKey,
        CopySource: `${this.bucketForKey(fromKey)}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      }),
    );
  }
  protected async doDeleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
  }
}

/** Test double with the same tenant enforcement. Never used in production (createStorageFromEnv refuses). */
export class MemoryStorageProvider extends TenantPrefixedStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  /** Test helper: keys currently stored (across tenants; the enforcement is on the operations). */
  keys(): string[] {
    return [...this.objects.keys()];
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }

  protected async doSignUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }) {
    const expiresAt = new Date(Date.now() + opts.expiresInSec * 1000);
    return { url: `memory://upload/${key}?expires=${expiresAt.getTime()}`, expiresAt };
  }
  protected async doSignDownloadUrl(key: string, opts: { expiresInSec: number }) {
    const expiresAt = new Date(Date.now() + opts.expiresInSec * 1000);
    return { url: `memory://download/${key}?expires=${expiresAt.getTime()}`, expiresAt };
  }
  protected async doHeadObject(key: string) {
    const o = this.objects.get(key);
    return o ? { bytes: o.body.length, contentType: o.contentType } : null;
  }
  protected async doGetObject(key: string, range?: ByteRange) {
    const o = this.objects.get(key);
    if (!o) return null;
    return range ? o.body.subarray(range.start, range.end + 1) : o.body;
  }
  protected async doPutObject(key: string, body: Buffer, opts: { contentType: string }) {
    this.objects.set(key, { body: Buffer.from(body), contentType: opts.contentType });
  }
  protected async doCopyObject(fromKey: string, toKey: string) {
    const o = this.objects.get(fromKey);
    if (!o) throw new Error(`object not found: ${fromKey}`);
    this.objects.set(toKey, { body: Buffer.from(o.body), contentType: o.contentType });
  }
  protected async doDeleteObject(key: string) {
    this.objects.delete(key);
  }
}

type Env = Record<string, string | undefined>;

export function readS3Config(env: Env): S3StorageConfig | null {
  const assets = env['OBJECT_STORE_BUCKET_ASSETS'];
  const releases = env['OBJECT_STORE_BUCKET_RELEASES'];
  const endpoint = env['OBJECT_STORE_ENDPOINT'];
  const region = env['OBJECT_STORE_REGION'];
  if (!assets || !releases || (!endpoint && !region)) return null;
  return {
    ...(endpoint ? { endpoint } : {}),
    region: region ?? 'auto',
    accessKeyId: env['OBJECT_STORE_ACCESS_KEY_ID'],
    secretAccessKey: env['OBJECT_STORE_SECRET_ACCESS_KEY'],
    buckets: { assets, releases },
  };
}

/**
 * Production requires the S3 configuration and fails at startup otherwise (spec 9.1: no local-disk storage in
 * production). Outside production an in-memory provider is used with a warning.
 */
export function createStorageFromEnv(env: Env = process.env): StorageProvider {
  const cfg = readS3Config(env);
  if (cfg) return new S3StorageProvider(cfg);
  if ((env['NODE_ENV'] ?? 'development') === 'production')
    throw new Error(
      'Object storage is not configured: set OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES and ' +
        'OBJECT_STORE_ENDPOINT (or OBJECT_STORE_REGION). Local and in-memory storage are not permitted in production (spec 9.1).',
    );
  logger().warn({}, 'object store not configured: using in-memory storage (non-production only)');
  return new MemoryStorageProvider();
}

let provider: StorageProvider | null = null;

/** Composition root hook (main and tests); a bare `storage()` call configures from the environment once. */
export function configureStorage(p: StorageProvider): void {
  provider = p;
}

export function storage(): StorageProvider {
  if (!provider) provider = createStorageFromEnv();
  return provider;
}
