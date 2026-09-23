import { describe, expect, it } from 'vitest';
import { filterFields } from './allowlist';
import { createLogger } from './logger';
import { Writable } from 'node:stream';

describe('log field allowlist (spec 17.3)', () => {
  it('drops unknown fields and anything that looks like a secret, keeps correlation ids', () => {
    const out = filterFields({
      correlationId: 'c1',
      tenantId: 't1',
      accessToken: 'x',
      email: 'a@b.c',
      weird: 1,
      refresh_token: 'y',
      promptText: 'p',
    });
    expect(out).toEqual({ correlationId: 'c1', tenantId: 't1' });
  });
  it('the logger never emits a token even under an allowed key', async () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ service: 'test', destination: dest, level: 'info' });
    log.info(
      {
        correlationId: 'c1',
        publicationId: 'pub_1',
        reason: { token: 'SECRET_VALUE' } as unknown as string,
        secretThing: 'SECRET2',
      },
      'hello',
    );
    await new Promise((r) => setTimeout(r, 20));
    const line = chunks.join('');
    expect(line).toContain('"correlationId":"c1"');
    expect(line).not.toContain('SECRET_VALUE');
    expect(line).not.toContain('SECRET2');
  });
});
