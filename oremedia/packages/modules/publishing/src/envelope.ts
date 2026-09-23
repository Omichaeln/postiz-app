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
  const iv = randomBytes(12);
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
    return JSON.parse(plain.toString('utf8')) as DecryptedCredentials;
  } finally {
    dataKey.fill(0);
  }
}
