import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Key-management abstraction for envelope encryption (spec 14.7, ADR-09). Production uses a cloud KMS
 * (KMS_KEY_ID_CREDENTIALS) whose IAM policy grants Decrypt only to worker-core and worker-ingest. LocalKms is
 * for development and tests only: it wraps data keys with a master key derived from an environment secret.
 */
export interface Kms {
  readonly keyId: string;
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrapDataKey(wrapped: Buffer): Promise<Buffer>;
}

export class LocalKms implements Kms {
  readonly keyId: string;
  private readonly master: Buffer;
  constructor(masterSecret: string, keyId = 'local-kms') {
    if (masterSecret.length < 16) throw new Error('LocalKms master secret too short');
    this.keyId = keyId;
    this.master = createHash('sha256').update(masterSecret).digest();
  }
  async generateDataKey() {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]) };
  }
  async unwrapDataKey(wrapped: Buffer) {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/** A KMS that refuses to decrypt: what the API process gets (spec 14.7: the API process cannot decrypt). */
export class WrapOnlyKms implements Kms {
  constructor(private readonly inner: Kms) {}
  get keyId() {
    return this.inner.keyId;
  }
  generateDataKey() {
    return this.inner.generateDataKey();
  }
  async unwrapDataKey(): Promise<Buffer> {
    throw new Error('This process is not permitted to decrypt credentials');
  }
}
