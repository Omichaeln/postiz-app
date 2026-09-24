import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import type { Kms } from './kms';

export interface Envelope {
  kmsKeyId: string;
  wrappedDataKey: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  aad: string;
}

/** AAD = `${tenantId}:${channelConnectionId}` binds ciphertext to its owner (spec 14.7). */
export const aadFor = (tenantId: string, channelConnectionId: string): string =>
  `${tenantId}:${channelConnectionId}`;

export async function seal(kms: Kms, credentials: DecryptedCredentials, aad: string): Promise<Envelope> {
  const { plaintext: dataKey, wrapped } = await kms.generateDataKey();
  // 12 ASCII characters (72 bits of entropy) so the IV survives the driver's text mapping of VARBINARY verbatim;
  // the data key is single-use per record, so IV uniqueness only needs to hold within this one encryption.
  const iv = Buffer.from(randomBytes(9).toString('base64url'), 'latin1');
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(credentials), 'utf8')),
    cipher.final(),
  ]);
  dataKey.fill(0);
  return { kmsKeyId: kms.keyId, wrappedDataKey: wrapped, ciphertext, iv, authTag: cipher.getAuthTag(), aad };
}

export async function open(kms: Kms, env: Envelope, expectedAad: string): Promise<DecryptedCredentials> {
  if (env.aad !== expectedAad) throw new Error('credential envelope AAD mismatch');
  const dataKey = await kms.unwrapDataKey(env.wrappedDataKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, env.iv);
    decipher.setAAD(Buffer.from(env.aad, 'utf8'));
    decipher.setAuthTag(env.authTag);
    const plain = Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
    try {
      return JSON.parse(plain.toString('utf8')) as DecryptedCredentials;
    } finally {
      plain.fill(0); // the plaintext buffer is zeroed as soon as it has been parsed (spec 14.7)
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * credential_refs stores the envelope's byte fields in VARBINARY columns; the driver maps them through a UTF-8
 * string, which is lossy for raw bytes, so they travel as text: the wrapped key and ciphertext as base64, the IV
 * verbatim (it is ASCII by construction) and the 16-byte GCM tag appended to the ciphertext, since base64 of the
 * tag does not fit its 16-byte column (schema gap reported: size the columns for text or map them as binary).
 */
const TAG_IN_CIPHERTEXT = 'in_ciphertext';
const TAG_BYTES = 16;
export interface EnvelopeRow {
  kmsKeyId: string;
  wrappedDataKey: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  aad: string;
}
export const envelopeToRow = (env: Envelope): EnvelopeRow => ({
  kmsKeyId: env.kmsKeyId,
  wrappedDataKey: env.wrappedDataKey.toString('base64'),
  ciphertext: Buffer.concat([env.ciphertext, env.authTag]).toString('base64'),
  iv: env.iv.toString('latin1'),
  authTag: TAG_IN_CIPHERTEXT,
  aad: env.aad,
});
export const envelopeFromRow = (row: EnvelopeRow): Envelope => {
  const bytes = Buffer.from(row.ciphertext, 'base64');
  const split = row.authTag === TAG_IN_CIPHERTEXT ? bytes.length - TAG_BYTES : bytes.length;
  return {
    kmsKeyId: row.kmsKeyId,
    wrappedDataKey: Buffer.from(row.wrappedDataKey, 'base64'),
    ciphertext: bytes.subarray(0, Math.max(0, split)),
    iv: Buffer.from(row.iv, 'latin1'),
    authTag:
      row.authTag === TAG_IN_CIPHERTEXT
        ? bytes.subarray(Math.max(0, split))
        : Buffer.from(row.authTag, 'base64'),
    aad: row.aad,
  };
};
