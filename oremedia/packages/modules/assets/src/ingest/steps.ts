import { fileTypeFromBuffer } from 'file-type';
import * as fontkit from './fontkit-loader';
import DOMPurify from 'isomorphic-dompurify';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import {
  ACCEPTED_MIMES,
  ARCHIVE_MIMES,
  KIND_MIME_GROUPS,
  MAX_IMAGE_PIXELS,
  type AssetKind,
  type AssetState,
  type DerivativePurpose,
  type FontMetadata,
  type IngestRejectionReason,
  type IngestStepRejection,
  type IngestStepResult,
  type MimeGroup,
} from '@oremedia/contracts/assets';
import { sha256Hex } from '@oremedia/domain/hash';
import type { StorageProvider } from '../storage';
import { ScannerUnavailableError, type Scanner } from './scanner';

/**
 * Spec 9.1 ingestion steps as pure, individually testable functions. Every step returns a typed result and never
 * throws for an expected rejection: a rejection is a value with a reason code (contracts IngestRejectionReason).
 * The activities in packages/activities wrap these with tenant context and storage I/O.
 */
export const SNIFF_BYTES = 4100;

const reject = (reason: IngestRejectionReason, detail?: string): IngestStepRejection =>
  detail ? { ok: false, reason, detail } : { ok: false, reason };

// ---- 1. verify ------------------------------------------------------------------------------------------------

export async function verifyObject(
  storage: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<IngestStepResult<{ bytes: number }>> {
  const head = await storage.headObject(key);
  if (!head) return reject('object_missing');
  if (head.bytes <= 0) return reject('object_missing', 'empty object');
  if (head.bytes > maxBytes) return reject('exceeds_cap', `${head.bytes} bytes exceeds cap of ${maxBytes}`);
  return { ok: true, bytes: head.bytes };
}

// ---- 2. sniff -------------------------------------------------------------------------------------------------

const MIME_EQUIVALENTS: ReadonlyArray<readonly string[]> = [
  ['font/ttf', 'application/x-font-ttf', 'application/font-sfnt', 'font/sfnt'],
  ['font/otf', 'application/x-font-otf', 'application/font-sfnt', 'font/sfnt'],
  ['image/jpeg', 'image/jpg'],
  ['image/heic', 'image/heif'],
];

const normaliseMime = (m: string): string => (m.split(';')[0] ?? '').trim().toLowerCase();

function mimeMatches(declared: string, sniffed: string): boolean {
  const d = normaliseMime(declared);
  const s = normaliseMime(sniffed);
  if (d === s) return true;
  return MIME_EQUIVALENTS.some((set) => set.includes(d) && set.includes(s));
}

export function groupForMime(mime: string): MimeGroup | null {
  for (const [group, list] of Object.entries(ACCEPTED_MIMES))
    if (list.includes(mime)) return group as MimeGroup;
  return null;
}

/** Fonts by magic (spec 9.1): sfnt version tags, WOFF/WOFF2 signatures, TrueType collections. */
function sniffFontMagic(head: Uint8Array): string | 'collection' | null {
  if (head.length < 4) return null;
  const tag = Buffer.from(head.subarray(0, 4)).toString('latin1');
  if (tag === 'OTTO') return 'font/otf';
  if (tag === 'true' || (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)) return 'font/ttf';
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'ttcf') return 'collection';
  return null;
}

/** SVG by content, never by extension or declared mime. */
function looksLikeSvg(head: Uint8Array): boolean {
  const text = Buffer.from(head)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (!text.startsWith('<')) return false;
  return /<svg[\s>]/i.test(text);
}

const XML_LIKE = new Set(['application/xml', 'text/xml', 'text/html', 'image/svg+xml']);

export async function sniffType(
  head: Uint8Array,
  declared: { kind: AssetKind; mime: string },
): Promise<IngestStepResult<{ mime: string; group: MimeGroup }>> {
  const font = sniffFontMagic(head);
  if (font === 'collection') return reject('font_collection_unsupported');
  let mime: string | null = font;
  if (!mime) {
    const detected = await fileTypeFromBuffer(head);
    mime = detected?.mime ?? null;
  }
  if ((!mime || XML_LIKE.has(mime)) && looksLikeSvg(head)) mime = 'image/svg+xml';
  if (!mime) return reject('type_unrecognised');
  if (ARCHIVE_MIMES.includes(mime)) return reject('archive_rejected');
  const group = groupForMime(mime);
  if (!group) return reject('format_unsupported', mime);
  if (!KIND_MIME_GROUPS[declared.kind].includes(group))
    return reject('type_mismatch', `${group} content cannot be an asset of kind ${declared.kind}`);
  if (!mimeMatches(declared.mime, mime))
    return reject('declared_mime_mismatch', `declared ${normaliseMime(declared.mime)}, detected ${mime}`);
  return { ok: true, mime, group };
}

// ---- 3. scan --------------------------------------------------------------------------------------------------

export async function scan(
  scanner: Scanner,
  bytes: Uint8Array,
): Promise<IngestStepResult<{ engine: string }>> {
  try {
    const verdict = await scanner.scan(bytes);
    if (!verdict.clean) return reject('malware_detected', verdict.signature);
    return { ok: true, engine: verdict.engine };
  } catch (err) {
    if (err instanceof ScannerUnavailableError)
      return { ok: false, reason: 'scanner_unavailable', retryable: true, detail: err.message };
    throw err;
  }
}

// ---- 4. sanitise ----------------------------------------------------------------------------------------------

export interface SanitisedFile {
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  /** Rasterised PNG of a sanitised SVG (source of its derivatives). */
  preview?: Buffer;
  /** True when the stored bytes differ from the upload (metadata stripped, orientation normalised, SVG cleaned). */
  sanitised: boolean;
}

export interface SanitiseOptions {
  maxPixels?: number;
}

export async function sanitise(
  bytes: Buffer,
  mime: string,
  group: MimeGroup,
  opts: SanitiseOptions = {},
): Promise<IngestStepResult<SanitisedFile>> {
  switch (group) {
    case 'svg':
      return sanitiseSvg(bytes, opts);
    case 'image':
      return sanitiseImage(bytes, opts);
    case 'font':
      return sanitiseFont(bytes, mime);
    case 'pdf':
      return checkPdf(bytes, mime);
    default:
      return reject('format_unsupported', 'processing for this kind arrives in Release 2');
  }
}

const SVG_UNSAFE_TAGS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'handler',
  'listener',
  'base',
  'meta',
  'link',
]);
const SVG_URI_ATTRS = new Set(['href', 'xlink:href', 'src', 'xml:base', 'action', 'formaction']);
/**
 * DOMPurify tests this against every attribute value that is not on its URI-safe list, so it must accept plain
 * values (numbers, path data, `url(#id)`, keywords) and fragment references while rejecting anything carrying a
 * scheme (`http:`, `javascript:`, `data:`) or a protocol-relative `//` prefix. Embedded `data:` rasters on
 * `<image>` are still admitted by DOMPurify's own data-URI rule for image tags. The xlink namespace declaration
 * is the one absolute URL a design file legitimately carries.
 */
const SVG_ALLOWED_URI = /^(?:#|[^a-z/]|[a-z+.-]+(?:[^a-z+.:-]|$)|http:\/\/www\.w3\.org\/1999\/xlink$)/i;
const EXTERNAL_STYLE_REF = /(?:url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)|@import)/i;

/** Shape of DOMPurify.removed entries (jsdom nodes); typed structurally because the lib has no DOM types. */
type Removed = {
  element?: { nodeName: string } | null;
  attribute?: { name: string; value: string | null } | null;
};

/** Which removals mean the file carried active or external content (an attack fixture, not a design file). */
function unsafeRemovals(removed: Removed[]): string[] {
  const unsafe: string[] = [];
  for (const r of removed) {
    if (r.element) {
      const tag = r.element.nodeName.toLowerCase();
      if (SVG_UNSAFE_TAGS.has(tag)) unsafe.push(`element:${tag}`);
    } else if (r.attribute) {
      const name = r.attribute.name.toLowerCase();
      const value = (r.attribute.value ?? '').trimStart();
      if (name.startsWith('on')) unsafe.push(`handler:${name}`);
      else if (name.startsWith('xmlns')) continue;
      else if (SVG_URI_ATTRS.has(name) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//'))
        unsafe.push(`external_ref:${name}`);
    }
  }
  return unsafe;
}

/**
 * SVG: DOMPurify SVG profile with only fragment and data-image URIs allowed (scripts, event handlers and external
 * references stripped), then a PNG preview rasterised with sharp. A file from which active or external content
 * had to be removed is rejected rather than quietly cleaned (Phase 2 gate: attack fixtures rejected).
 */
async function sanitiseSvg(bytes: Buffer, opts: SanitiseOptions): Promise<IngestStepResult<SanitisedFile>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  // Entity declarations are never needed by a design file and are the vector for XXE and entity expansion.
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) return reject('svg_unsafe_content', 'entity_declaration');
  const clean = DOMPurify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `use` is outside DOMPurify's SVG profile because of external references; with hrefs limited to fragments it is safe.
    ADD_TAGS: ['use'],
    FORBID_TAGS: [...SVG_UNSAFE_TAGS],
    ALLOWED_URI_REGEXP: SVG_ALLOWED_URI,
    KEEP_CONTENT: false,
  });
  const removed = [...(DOMPurify.removed as Removed[])];
  const unsafe = unsafeRemovals(removed);
  if (EXTERNAL_STYLE_REF.test(clean)) unsafe.push('style:external_url');
  if (unsafe.length) return reject('svg_unsafe_content', [...new Set(unsafe)].slice(0, 10).join(','));
  if (!/<svg[\s>]/i.test(clean)) return reject('svg_unparsable');
  const cleanBytes = Buffer.from(clean, 'utf8');
  let meta: Metadata;
  try {
    meta = await sharp(cleanBytes, { limitInputPixels: false }).metadata();
  } catch {
    return reject('svg_unrenderable');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return reject('svg_unrenderable', 'no intrinsic size');
  if (width * height > maxPixels) return reject('pixel_limit_exceeded', `${width}x${height}`);
  const density = Math.round(72 * Math.max(1, Math.min(8, 1024 / Math.max(width, height))));
  let preview: Buffer;
  try {
    preview = await sharp(cleanBytes, { density, limitInputPixels: maxPixels }).png().toBuffer();
  } catch {
    return reject('svg_unrenderable');
  }
  return {
    ok: true,
    bytes: cleanBytes,
    mime: 'image/svg+xml',
    width,
    height,
    colourProfile: null,
    preview,
    sanitised: removed.length > 0 || clean !== text,
  };
}

const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

/**
 * Raster images: the header-declared dimensions are compared with the pixel budget BEFORE any decode
 * (decompression bombs), then sharp re-encodes with EXIF/GPS dropped, orientation normalised and the ICC profile
 * kept. HEIC/HEIF and AVIF are converted (spec 9.1 "HEIC→converted").
 */
async function sanitiseImage(bytes: Buffer, opts: SanitiseOptions): Promise<IngestStepResult<SanitisedFile>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    return reject('image_undecodable');
  }
  if (!meta.format || !RASTER_FORMATS.has(meta.format))
    return reject('format_unsupported', meta.format ?? 'unknown');
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return reject('image_undecodable', 'no dimensions');
  if (width * height > maxPixels) return reject('pixel_limit_exceeded', `${width}x${height}`);
  const pipeline = sharp(bytes, { limitInputPixels: maxPixels }).rotate().keepIccProfile();
  let mime: string;
  switch (meta.format) {
    case 'png':
      pipeline.png();
      mime = 'image/png';
      break;
    case 'webp':
      pipeline.webp({ quality: 95 });
      mime = 'image/webp';
      break;
    case 'jpeg':
      pipeline.jpeg({ quality: 95 });
      mime = 'image/jpeg';
      break;
    default:
      // heif (HEIC and AVIF are both reported as heif): converted, keeping alpha where the source has it.
      if (meta.hasAlpha) {
        pipeline.png();
        mime = 'image/png';
      } else {
        pipeline.jpeg({ quality: 92 });
        mime = 'image/jpeg';
      }
  }
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    return reject('image_undecodable');
  }
  const colourProfile = meta.icc ? `icc:${meta.space ?? 'unknown'}` : (meta.space ?? null);
  return {
    ok: true,
    bytes: out.data,
    mime,
    width: out.info.width,
    height: out.info.height,
    colourProfile,
    sanitised: true,
  };
}

interface FontLike {
  numGlyphs?: number;
  familyName?: string | null;
  subfamilyName?: string | null;
  postscriptName?: string | null;
  copyright?: string | null;
  version?: string | null;
  unitsPerEm?: number;
  name?: { records?: Record<string, Record<string, string> | undefined> };
}

const clip = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

function nameRecord(f: FontLike, key: string): string | null {
  const rec = f.name?.records?.[key];
  if (!rec) return null;
  const first = rec['en'] ?? Object.values(rec)[0];
  return clip(first, 500);
}

/** Fonts: parsed with fontkit; family and licence metadata recorded; anything unparsable is rejected. */
function sanitiseFont(bytes: Buffer, mime: string): IngestStepResult<SanitisedFile> {
  let font: unknown;
  try {
    font = fontkit.create(bytes);
  } catch {
    return reject('font_unparsable');
  }
  if (!font || typeof font !== 'object') return reject('font_unparsable');
  if ('fonts' in font) return reject('font_collection_unsupported');
  const f = font as FontLike;
  let fontMetadata: FontMetadata;
  try {
    const glyphs = typeof f.numGlyphs === 'number' ? f.numGlyphs : 0;
    if (glyphs <= 0 || !f.unitsPerEm) return reject('font_unparsable', 'no glyphs');
    fontMetadata = {
      family: clip(f.familyName, 200),
      subfamily: clip(f.subfamilyName, 200),
      postscriptName: clip(f.postscriptName, 200),
      copyright: clip(f.copyright, 500),
      licence: nameRecord(f, 'license'),
      licenceUrl: nameRecord(f, 'licenseURL'),
      fontVersion: clip(f.version, 100),
      glyphs,
    };
  } catch {
    return reject('font_unparsable');
  }
  return {
    ok: true,
    bytes,
    mime,
    width: null,
    height: null,
    colourProfile: null,
    fontMetadata,
    sanitised: false,
  };
}

/** PDF references: header check only; there is no sanitiser, they are served as files and never rendered server-side. */
function checkPdf(bytes: Buffer, mime: string): IngestStepResult<SanitisedFile> {
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-'))
    return reject('format_unsupported', 'not a pdf');
  return { ok: true, bytes, mime, width: null, height: null, colourProfile: null, sanitised: false };
}

// ---- 5. hash and dedupe ---------------------------------------------------------------------------------------

/** SHA-256 of the stored bytes; a match within the brand is a `duplicate_of` proposal, never a silent merge. */
export async function hashAndDedupe(
  bytes: Uint8Array,
  findExistingAssetId: (contentHash: string) => Promise<string | null>,
): Promise<IngestStepResult<{ contentHash: string }>> {
  const contentHash = sha256Hex(bytes);
  const existing = await findExistingAssetId(contentHash);
  if (existing)
    return {
      ok: false,
      reason: 'duplicate_of',
      duplicateOfAssetId: existing,
      detail: 'identical content already exists in this brand',
    };
  return { ok: true, contentHash };
}

// ---- 6. derivatives -------------------------------------------------------------------------------------------

export interface DerivativeFile {
  purpose: DerivativePurpose;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  transform: Record<string, string | number | boolean>;
}

const DERIVATIVE_SPECS: ReadonlyArray<{ purpose: DerivativePurpose; maxSide: number; quality: number }> = [
  { purpose: 'thumbnail', maxSide: 256, quality: 80 },
  { purpose: 'preview', maxSide: 1024, quality: 85 },
  { purpose: 'web', maxSide: 2048, quality: 88 },
];

/** Thumbnail, preview and web-optimised WebP renditions of a raster (or of an SVG's rasterised preview). */
export async function derivatives(
  source: { bytes: Buffer; group: MimeGroup; preview?: Buffer },
  opts: SanitiseOptions = {},
): Promise<IngestStepResult<{ derivatives: DerivativeFile[] }>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  const raster =
    source.group === 'image' ? source.bytes : source.group === 'svg' ? source.preview : undefined;
  if (!raster) return { ok: true, derivatives: [] };
  const out: DerivativeFile[] = [];
  for (const spec of DERIVATIVE_SPECS) {
    try {
      const r = await sharp(raster, { limitInputPixels: maxPixels })
        .resize({ width: spec.maxSide, height: spec.maxSide, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toBuffer({ resolveWithObject: true });
      out.push({
        purpose: spec.purpose,
        bytes: r.data,
        mime: 'image/webp',
        width: r.info.width,
        height: r.info.height,
        transform: {
          op: 'resize',
          fit: 'inside',
          maxSide: spec.maxSide,
          format: 'webp',
          quality: spec.quality,
        },
      });
    } catch {
      return reject('image_undecodable', `derivative ${spec.purpose}`);
    }
  }
  return { ok: true, derivatives: out };
}

// ---- 7. move to immutable -------------------------------------------------------------------------------------

/** Copies the sanitised objects to their immutable assets/ keys, then deletes the quarantine objects listed. */
export async function moveToImmutable(
  storage: StorageProvider,
  plan: { copies: Array<{ fromKey: string; toKey: string }>; deleteKeys: string[] },
): Promise<{ ok: true; copied: number }> {
  for (const c of plan.copies) await storage.copyObject(c.fromKey, c.toKey);
  for (const k of plan.deleteKeys) await storage.deleteObject(k);
  return { ok: true, copied: plan.copies.length };
}

// ---- 8. catalogue ---------------------------------------------------------------------------------------------

/** The initial state is an explicit input decided by the caller (policy), never inferred here (spec 9.1 step 8). */
export const initialAssetState = (autoApprove: boolean): AssetState =>
  autoApprove ? 'approved' : 'pending_review';
