import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import {
  ClamAvScanner,
  FailClosedScanner,
  FakeScanner,
  ScannerUnavailableError,
  createScannerFromEnv,
} from './scanner';

const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** A clamd stand-in speaking INSTREAM: reads the length-prefixed chunks and answers OK or FOUND. */
function fakeClamd(opts: { silent?: boolean } = {}): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      if (!buffer.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let offset = 10;
      const parts: Buffer[] = [];
      while (offset + 4 <= buffer.length) {
        const len = buffer.readUInt32BE(offset);
        if (len === 0) {
          if (opts.silent) return;
          const body = Buffer.concat(parts).toString('latin1');
          socket.end(body.includes(EICAR_MARKER) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (offset + 4 + len > buffer.length) return;
        parts.push(buffer.subarray(offset + 4, offset + 4 + len));
        offset += 4 + len;
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    ),
  );
}

describe('ClamAvScanner (clamd INSTREAM over TCP)', () => {
  let clamd: { server: Server; port: number };
  let silent: { server: Server; port: number };
  beforeAll(async () => {
    clamd = await fakeClamd();
    silent = await fakeClamd({ silent: true });
  });
  afterAll(() => {
    clamd.server.close();
    silent.server.close();
  });

  it('returns a clean verdict and a signature on a hit, chunking the stream', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, chunkBytes: 7 });
    expect(await scanner.scan(Buffer.from('hello world, this is a harmless file'))).toEqual({
      clean: true,
      engine: 'clamav',
    });
    const eicar = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', `${EICAR_MARKER}!$H+H*`].join(''));
    expect(await scanner.scan(eicar)).toEqual({
      clean: false,
      engine: 'clamav',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });
  it('times out into ScannerUnavailableError instead of a verdict', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: silent.port, timeoutMs: 200 });
    await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it('a refused connection is ScannerUnavailableError', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe('scanner selection (fail closed in production)', () => {
  it('production without SCANNER_CLAMD_ADDRESS never yields a verdict', async () => {
    const s = createScannerFromEnv({ NODE_ENV: 'production' });
    expect(s).toBeInstanceOf(FailClosedScanner);
    await expect(s.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it('an address selects ClamAV; non-production without one uses the fake', () => {
    expect(
      createScannerFromEnv({ NODE_ENV: 'production', SCANNER_CLAMD_ADDRESS: 'clamd:3310' }),
    ).toBeInstanceOf(ClamAvScanner);
    expect(createScannerFromEnv({ NODE_ENV: 'test' })).toBeInstanceOf(FakeScanner);
    expect(() => createScannerFromEnv({ SCANNER_CLAMD_ADDRESS: ':abc' })).toThrow(/host:port/);
  });
});
