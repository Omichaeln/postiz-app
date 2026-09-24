import { Socket } from 'node:net';
import { logger } from '@oremedia/observability';

/**
 * Spec 9.1 step 3: scan with ClamAV (clamd INSTREAM over TCP) or a managed scanner. A scanner that cannot be
 * reached is an infrastructure failure, not a clean result: the step reports it as retryable and the intent
 * stays quarantined. In production a missing scanner endpoint fails closed the same way.
 */
export type ScanVerdict =
  { clean: true; engine: string } | { clean: false; engine: string; signature: string };

export interface Scanner {
  readonly engine: string;
  /** Resolves with a verdict; throws ScannerUnavailableError when no verdict could be obtained. */
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export class ScannerUnavailableError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ScannerUnavailableError';
  }
}

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  chunkBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CHUNK = 64 * 1024;

/** clamd INSTREAM: `zINSTREAM\0`, then `<u32 BE length><chunk>`... terminated by a zero-length chunk. */
export class ClamAvScanner implements Scanner {
  readonly engine = 'clamav';
  constructor(private readonly opts: ClamAvOptions) {}

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const { host, port } = this.opts;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const chunk = this.opts.chunkBytes ?? DEFAULT_CHUNK;
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          err instanceof ScannerUnavailableError
            ? err
            : new ScannerUnavailableError(err.message, { cause: err }),
        );
      };
      socket.setTimeout(timeoutMs, () =>
        fail(new ScannerUnavailableError(`clamd timed out after ${timeoutMs}ms`)),
      );
      socket.on('error', fail);
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('close', () => {
        if (settled) return;
        settled = true;
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim();
        if (/\bOK$/.test(reply)) return resolve({ clean: true, engine: this.engine });
        const found = /^stream:\s*(.+?)\s+FOUND$/.exec(reply);
        if (found) return resolve({ clean: false, engine: this.engine, signature: found[1] as string });
        reject(new ScannerUnavailableError(`clamd returned no verdict: ${reply.slice(0, 120)}`));
      });
      socket.connect(port, host, () => {
        socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          const part = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4, 0));
      });
    });
  }
}

/** Marker of the EICAR test file; the fake matches the marker so test fixtures need not carry the full string. */
const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** Test scanner: flags the EICAR test string, passes everything else. */
export class FakeScanner implements Scanner {
  readonly engine = 'fake';
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const text = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
    return text.includes(EICAR_MARKER)
      ? { clean: false, engine: this.engine, signature: 'Eicar-Test-Signature' }
      : { clean: true, engine: this.engine };
  }
}

/** Production without a configured scanner: never a verdict, so nothing is ever accepted (fail closed). */
export class FailClosedScanner implements Scanner {
  readonly engine = 'none';
  async scan(): Promise<ScanVerdict> {
    throw new ScannerUnavailableError('SCANNER_CLAMD_ADDRESS is not configured; uploads stay quarantined');
  }
}

type Env = Record<string, string | undefined>;

/** `SCANNER_CLAMD_ADDRESS=host:port` selects ClamAV; production without it fails closed; elsewhere the fake is used. */
export function createScannerFromEnv(env: Env = process.env): Scanner {
  const address = env['SCANNER_CLAMD_ADDRESS'];
  if (address) {
    const [host, portText] = address.split(':');
    const port = Number(portText ?? 3310);
    if (!host || !Number.isInteger(port)) throw new Error('SCANNER_CLAMD_ADDRESS must be host:port');
    return new ClamAvScanner({
      host,
      port,
      timeoutMs: env['SCANNER_TIMEOUT_MS'] ? Number(env['SCANNER_TIMEOUT_MS']) : undefined,
    });
  }
  if ((env['NODE_ENV'] ?? 'development') === 'production') {
    logger().error(
      {},
      'SCANNER_CLAMD_ADDRESS not set in production: uploads will stay quarantined (fail closed)',
    );
    return new FailClosedScanner();
  }
  logger().warn({}, 'SCANNER_CLAMD_ADDRESS not set: using the fake scanner (non-production only)');
  return new FakeScanner();
}
