import { describe, expect, it } from 'vitest';
import { LocalKms, WrapOnlyKms } from './kms';
import { aadFor, envelopeFromRow, envelopeToRow, open, seal } from './envelope';

describe('credential envelope encryption (spec 14.7)', () => {
  const kms = new LocalKms('test-master-secret-0123456789');
  const creds = { accessToken: 'at_secret', refreshToken: 'rt_secret', expiresAt: '2026-12-01T00:00:00Z' };

  it('round-trips with the right AAD and produces no plaintext in the envelope', async () => {
    const aad = aadFor('ten_A', 'cc_1');
    const env = await seal(kms, creds, aad);
    expect(env.ciphertext.toString('utf8')).not.toContain('at_secret');
    expect(env.wrappedDataKey.length).toBeGreaterThan(32);
    expect(await open(kms, env, aad)).toEqual(creds);
  });
  it("refuses another owner's AAD (ciphertext bound to tenant and connection)", async () => {
    const env = await seal(kms, creds, aadFor('ten_A', 'cc_1'));
    await expect(open(kms, env, aadFor('ten_B', 'cc_1'))).rejects.toThrow(/AAD mismatch/);
    await expect(
      open(kms, { ...env, aad: aadFor('ten_B', 'cc_1') }, aadFor('ten_B', 'cc_1')),
    ).rejects.toThrow();
  });
  it('a tampered ciphertext fails authentication', async () => {
    const aad = aadFor('ten_A', 'cc_1');
    const env = await seal(kms, creds, aad);
    const tampered = Buffer.from(env.ciphertext);
    tampered[0] = (tampered[0]! + 1) & 0xff;
    await expect(open(kms, { ...env, ciphertext: tampered }, aad)).rejects.toThrow();
  });
  it('a wrap-only KMS (the API process) can seal but never open', async () => {
    const apiKms = new WrapOnlyKms(kms);
    const aad = aadFor('ten_A', 'cc_1');
    const env = await seal(apiKms, creds, aad);
    await expect(open(apiKms, env, aad)).rejects.toThrow(/not permitted to decrypt/);
    expect(await open(kms, env, aad)).toEqual(creds);
  });
});

describe('credential envelope row mapping (VARBINARY columns travel as text)', () => {
  it('round-trips through the row shape within the column sizes (iv 12, auth_tag 16)', async () => {
    const kms = new LocalKms('test-master-secret-0123456789');
    const aad = aadFor('ten_A', 'cc_1');
    const env = await seal(kms, { accessToken: 'at_secret', refreshToken: 'rt' }, aad);
    const row = envelopeToRow(env);
    expect(row.iv.length).toBeLessThanOrEqual(12);
    expect(row.authTag.length).toBeLessThanOrEqual(16);
    expect(row.wrappedDataKey.length).toBeLessThanOrEqual(512);
    expect(await open(kms, envelopeFromRow(row), aad)).toEqual({
      accessToken: 'at_secret',
      refreshToken: 'rt',
    });
    const tampered = {
      ...row,
      ciphertext: Buffer.from(
        'x' + Buffer.from(row.ciphertext, 'base64').toString('binary').slice(1),
        'binary',
      ).toString('base64'),
    };
    await expect(open(kms, envelopeFromRow(tampered), aad)).rejects.toThrow();
  });
});
