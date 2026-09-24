import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { MemoryStorageProvider } from '../storage';
import { FakeScanner, ScannerUnavailableError, type Scanner } from './scanner';
import {
  SNIFF_BYTES,
  derivatives,
  hashAndDedupe,
  initialAssetState,
  moveToImmutable,
  sanitise,
  scan,
  sniffType,
  verifyObject,
} from './steps';

const ctx: TenantContext = {
  tenantId: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  actor: { kind: 'user', id: 'usr_1' },
  brandIds: 'all',
  correlationId: 'corr_steps',
};

// ---- fixture bytes, generated in the test (no binary files in the repository) -------------------------------

const png = () =>
  sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 1 } } })
    .png()
    .toBuffer();

const rotatedJpeg = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** A structurally valid PNG whose IHDR declares 40000×40000 pixels (1.6 gigapixels) with almost no data. */
function bombPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(40000, 0);
  ihdr.writeUInt32BE(40000, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svgWithScript = `<?xml version="1.0"?><svg ${SVG_NS} width="100" height="100"><script>alert(1)</script><rect width="100" height="100" fill="#0f0"/></svg>`;
const svgWithHandler = `<svg ${SVG_NS} width="100" height="100"><rect width="100" height="100" fill="#0f0" onload="evil()"/></svg>`;
const svgWithExternalRef = `<svg ${SVG_NS} width="100" height="100"><image xlink:href="http://evil.example/x.png" width="10" height="10"/><rect width="100" height="100" fill="#0f0"/></svg>`;
const svgWithEntity = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${SVG_NS} width="10" height="10"><text>&xxe;</text></svg>`;
const svgWithExternalStyle = `<svg ${SVG_NS} width="100" height="100"><style>@import url(http://evil.example/a.css);</style><rect width="100" height="100"/></svg>`;
const safeSvg = `<svg ${SVG_NS} width="120" height="80" viewBox="0 0 120 80"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect id="r" width="120" height="80" fill="url(#g)"/><use xlink:href="#r"/></svg>`;

const garbageFont = () => Buffer.concat([Buffer.from([0, 1, 0, 0]), randomBytes(200)]);
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];
const realFontPath = FONT_CANDIDATES.find((p) => existsSync(p));

/** Built from two halves so the repository itself never contains the contiguous test signature. */
const eicar = () =>
  Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));

const head = (b: Buffer) => b.subarray(0, SNIFF_BYTES);

describe('ingest step 1: verifyObject', () => {
  it('missing, empty and oversize objects are rejected; a valid one reports its size', async () => {
    const storage = new MemoryStorageProvider();
    await runInTenant(ctx, async () => {
      const key = `quarantine/${ctx.tenantId}/ui_1`;
      expect(await verifyObject(storage, key, 100)).toMatchObject({ ok: false, reason: 'object_missing' });
      await storage.putObject(key, Buffer.alloc(0), { contentType: 'image/png' });
      expect(await verifyObject(storage, key, 100)).toMatchObject({ ok: false, reason: 'object_missing' });
      await storage.putObject(key, Buffer.alloc(101), { contentType: 'image/png' });
      expect(await verifyObject(storage, key, 100)).toMatchObject({ ok: false, reason: 'exceeds_cap' });
      await storage.putObject(key, Buffer.alloc(100), { contentType: 'image/png' });
      expect(await verifyObject(storage, key, 100)).toEqual({ ok: true, bytes: 100 });
    });
  });
});

describe('ingest step 2: sniffType (content is authoritative)', () => {
  it('accepts a PNG declared as a PNG photo', async () => {
    expect(await sniffType(head(await png()), { kind: 'photo', mime: 'image/png' })).toEqual({
      ok: true,
      mime: 'image/png',
      group: 'image',
    });
  });
  it('rejects a declared mime that does not match the bytes', async () => {
    expect(await sniffType(head(await png()), { kind: 'photo', mime: 'image/jpeg' })).toMatchObject({
      ok: false,
      reason: 'declared_mime_mismatch',
    });
  });
  it('rejects content whose group does not fit the declared kind', async () => {
    expect(await sniffType(head(await png()), { kind: 'font', mime: 'image/png' })).toMatchObject({
      ok: false,
      reason: 'type_mismatch',
    });
    expect(
      await sniffType(head(Buffer.from(safeSvg)), { kind: 'photo', mime: 'image/svg+xml' }),
    ).toMatchObject({ ok: false, reason: 'type_mismatch' });
  });
  it('detects SVG by content and fonts by magic', async () => {
    expect(await sniffType(head(Buffer.from(safeSvg)), { kind: 'logo', mime: 'image/svg+xml' })).toEqual({
      ok: true,
      mime: 'image/svg+xml',
      group: 'svg',
    });
    expect(
      await sniffType(head(Buffer.from(svgWithScript)), { kind: 'icon', mime: 'image/svg+xml' }),
    ).toEqual({ ok: true, mime: 'image/svg+xml', group: 'svg' });
    expect(await sniffType(head(garbageFont()), { kind: 'font', mime: 'font/ttf' })).toEqual({
      ok: true,
      mime: 'font/ttf',
      group: 'font',
    });
    expect(
      await sniffType(Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(64)]), {
        kind: 'font',
        mime: 'application/x-font-otf',
      }),
    ).toEqual({ ok: true, mime: 'font/otf', group: 'font' });
    expect(
      await sniffType(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(64)]), {
        kind: 'font',
        mime: 'font/ttf',
      }),
    ).toMatchObject({ ok: false, reason: 'font_collection_unsupported' });
  });
  it('rejects unrecognised bytes, archives and recognised-but-unaccepted formats', async () => {
    expect(await sniffType(randomBytes(512), { kind: 'photo', mime: 'image/png' })).toMatchObject({
      ok: false,
      reason: 'type_unrecognised',
    });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect(await sniffType(zip, { kind: 'reference', mime: 'application/zip' })).toMatchObject({
      ok: false,
      reason: 'archive_rejected',
    });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
    expect(await sniffType(gif, { kind: 'photo', mime: 'image/gif' })).toMatchObject({
      ok: false,
      reason: 'format_unsupported',
    });
  });
});

describe('ingest step 3: scan', () => {
  it('the EICAR string is detected; clean bytes pass; an unreachable scanner is a retryable non-verdict', async () => {
    const fake = new FakeScanner();
    expect(await scan(fake, eicar())).toMatchObject({ ok: false, reason: 'malware_detected' });
    expect(await scan(fake, await png())).toEqual({ ok: true, engine: 'fake' });
    const down: Scanner = {
      engine: 'down',
      scan: async () => {
        throw new ScannerUnavailableError('connection refused');
      },
    };
    expect(await scan(down, await png())).toMatchObject({
      ok: false,
      reason: 'scanner_unavailable',
      retryable: true,
    });
  });
});

describe('ingest step 4: sanitise SVG', () => {
  it.each([
    ['script element', svgWithScript, 'element:script'],
    ['event handler', svgWithHandler, 'handler:onload'],
    ['external xlink:href', svgWithExternalRef, 'external_ref:xlink:href'],
    ['external stylesheet import', svgWithExternalStyle, 'style:external_url'],
  ])('rejects an SVG carrying %s', async (_label, svg, expectedDetail) => {
    const r = await sanitise(Buffer.from(svg), 'image/svg+xml', 'svg');
    expect(r).toMatchObject({ ok: false, reason: 'svg_unsafe_content' });
    expect((r as { detail?: string }).detail).toContain(expectedDetail);
  });
  it('rejects entity declarations before any parsing', async () => {
    expect(await sanitise(Buffer.from(svgWithEntity), 'image/svg+xml', 'svg')).toMatchObject({
      ok: false,
      reason: 'svg_unsafe_content',
      detail: 'entity_declaration',
    });
  });
  it('accepts a clean SVG, keeps internal references and rasterises a PNG preview', async () => {
    const r = await sanitise(Buffer.from(safeSvg), 'image/svg+xml', 'svg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mime).toBe('image/svg+xml');
    expect(r.width).toBe(120);
    expect(r.height).toBe(80);
    const text = r.bytes.toString('utf8');
    expect(text).toContain('url(#g)');
    expect(text).toContain('xlink:href="#r"');
    expect(text).not.toContain('<script');
    const previewMeta = await sharp(r.preview).metadata();
    expect(previewMeta.format).toBe('png');
    expect(previewMeta.width).toBeGreaterThanOrEqual(120);
  });
  it('rejects an SVG that exceeds the pixel budget by its intrinsic size', async () => {
    const huge = `<svg ${SVG_NS} width="40000" height="40000"><rect width="10" height="10"/></svg>`;
    expect(await sanitise(Buffer.from(huge), 'image/svg+xml', 'svg')).toMatchObject({
      ok: false,
      reason: 'pixel_limit_exceeded',
    });
  });
});

describe('ingest step 4: sanitise raster images', () => {
  it('re-encodes a valid PNG and records its dimensions', async () => {
    const r = await sanitise(await png(), 'image/png', 'image');
    expect(r).toMatchObject({ ok: true, mime: 'image/png', width: 64, height: 48, sanitised: true });
  });
  it('normalises EXIF orientation and drops the EXIF block', async () => {
    const r = await sanitise(await rotatedJpeg(), 'image/jpeg', 'image');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.width, r.height]).toEqual([48, 64]);
    const meta = await sharp(r.bytes).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });
  it('rejects a decompression bomb from its header, before decoding', async () => {
    expect(await sanitise(bombPng(), 'image/png', 'image')).toMatchObject({
      ok: false,
      reason: 'pixel_limit_exceeded',
    });
  });
  it('honours a caller-supplied pixel budget', async () => {
    expect(await sanitise(await png(), 'image/png', 'image', { maxPixels: 1000 })).toMatchObject({
      ok: false,
      reason: 'pixel_limit_exceeded',
    });
  });
  it('rejects truncated or non-image bytes', async () => {
    const truncated = (await png()).subarray(0, 40);
    const r = await sanitise(truncated, 'image/png', 'image');
    expect(r.ok).toBe(false);
    expect(['image_undecodable', 'format_unsupported']).toContain((r as { reason: string }).reason);
    expect(await sanitise(randomBytes(100), 'image/png', 'image')).toMatchObject({ ok: false });
  });
});

describe('ingest step 4: sanitise fonts and PDFs', () => {
  it('rejects a truncated or garbage font', async () => {
    expect(await sanitise(garbageFont(), 'font/ttf', 'font')).toMatchObject({
      ok: false,
      reason: 'font_unparsable',
    });
    expect(await sanitise(Buffer.from('not a font at all'), 'font/ttf', 'font')).toMatchObject({
      ok: false,
      reason: 'font_unparsable',
    });
  });
  it.skipIf(!realFontPath)(
    'parses a real TrueType font and records family and licence metadata',
    async () => {
      const r = await sanitise(readFileSync(realFontPath as string), 'font/ttf', 'font');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fontMetadata?.family).toBeTruthy();
      expect(r.fontMetadata?.glyphs).toBeGreaterThan(0);
      expect(r.sanitised).toBe(false);
    },
  );
  it('accepts a PDF by header and rejects anything else', async () => {
    expect(await sanitise(Buffer.from('%PDF-1.4\n%âãÏÓ\n'), 'application/pdf', 'pdf')).toMatchObject({
      ok: true,
    });
    expect(await sanitise(Buffer.from('hello'), 'application/pdf', 'pdf')).toMatchObject({
      ok: false,
      reason: 'format_unsupported',
    });
  });
  it('video and audio are not processable in Release 1', async () => {
    expect(await sanitise(Buffer.alloc(16), 'video/mp4', 'video')).toMatchObject({
      ok: false,
      reason: 'format_unsupported',
    });
  });
});

describe('ingest steps 5–8: hash, derivatives, move, catalogue decision', () => {
  it('hashes with SHA-256 and proposes the existing asset instead of merging', async () => {
    const bytes = await png();
    const fresh = await hashAndDedupe(bytes, async () => null);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashAndDedupe(bytes, async () => 'ast_existing')).toMatchObject({
      ok: false,
      reason: 'duplicate_of',
      duplicateOfAssetId: 'ast_existing',
    });
  });
  it('builds thumbnail, preview and web derivatives without enlarging', async () => {
    const r = await derivatives({ bytes: await png(), group: 'image' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derivatives.map((d) => d.purpose)).toEqual(['thumbnail', 'preview', 'web']);
    for (const d of r.derivatives) {
      expect(d.mime).toBe('image/webp');
      expect(d.width).toBeLessThanOrEqual(64);
      expect((await sharp(d.bytes).metadata()).format).toBe('webp');
    }
    expect(await derivatives({ bytes: Buffer.alloc(10), group: 'font' })).toEqual({
      ok: true,
      derivatives: [],
    });
  });
  it('moves objects to immutable keys and deletes the quarantine object', async () => {
    const storage = new MemoryStorageProvider();
    await runInTenant(ctx, async () => {
      const from = `quarantine/${ctx.tenantId}/ui_1/sanitised`;
      const upload = `quarantine/${ctx.tenantId}/ui_1`;
      const to = `assets/${ctx.tenantId}/brd_1/ast_1/av_1/original`;
      await storage.putObject(upload, Buffer.from('raw'), { contentType: 'image/png' });
      await storage.putObject(from, Buffer.from('clean'), { contentType: 'image/png' });
      expect(
        await moveToImmutable(storage, { copies: [{ fromKey: from, toKey: to }], deleteKeys: [upload] }),
      ).toEqual({
        ok: true,
        copied: 1,
      });
      expect((await storage.getObject(to))?.toString()).toBe('clean');
      expect(await storage.headObject(upload)).toBeNull();
    });
  });
  it('the initial state is an explicit input', () => {
    expect(initialAssetState(true)).toBe('approved');
    expect(initialAssetState(false)).toBe('pending_review');
  });
});
