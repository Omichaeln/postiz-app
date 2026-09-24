import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import type { FixtureAsset, FixtureFont } from '@oremedia/editor/renderer/fixtures';

/**
 * Test-only helpers for the golden-render suite (spec 19.5): deterministic image generation for the fixture assets
 * (no binary fixtures beyond the fonts and goldens), the pinned fixture fonts, and the pixel comparison with the
 * specification's tolerance (differing pixels ≤ 0.1 %, per-channel tolerance 2), which pixelmatch's perceptual
 * threshold is not.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = resolve(here, '../../../tooling/test-fixtures');
export const FONTS_DIR = join(FIXTURES_ROOT, 'fonts');
export const GOLDEN_DIR = join(FIXTURES_ROOT, 'golden');
export const ACTUAL_DIR = join(GOLDEN_DIR, '.actual');

export async function loadFixtureFont(
  font: FixtureFont,
): Promise<{ family: string; mime: string; bytes: Buffer }> {
  return { family: font.assetVersionId, mime: font.mime, bytes: await readFile(join(FONTS_DIR, font.file)) };
}

/** Pixel generators: every value is a pure function of (x, y, width, height), so the bytes never change. */
function gradient(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const band = Math.sin(((x + y) / (width + height)) * Math.PI * 12) > 0 ? 24 : 0;
      px[i] = Math.round((x / width) * 220) + band;
      px[i + 1] = Math.round((y / height) * 200) + band;
      px[i + 2] = Math.round(((width - x) / width) * 160) + 40;
    }
  return px;
}

function checker(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 3);
  const cell = 100;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      // A red frame around the crop region the fixtures select (300,200 → 900,600) makes the crop verifiable.
      const onFrame =
        x >= 300 && x < 900 && y >= 200 && y < 600 && (x < 312 || x >= 888 || y < 212 || y >= 588);
      px[i] = onFrame ? 217 : dark ? 40 : 230;
      px[i + 1] = onFrame ? 84 : dark ? 48 : 232;
      px[i + 2] = onFrame ? 43 : dark ? 56 : 226;
    }
  return px;
}

function logo(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const r = height / 2;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inDisc = (x - r) ** 2 + (y - r) ** 2 <= (r * 0.9) ** 2;
      const inBar = width > height && x > height * 1.2 && x < width - r * 0.4 && y > r * 0.6 && y < r * 1.4;
      const hole = (x - r) ** 2 + (y - r) ** 2 <= (r * 0.35) ** 2;
      if ((inDisc && !hole) || inBar) {
        px[i] = 15;
        px[i + 1] = 110;
        px[i + 2] = 99;
        px[i + 3] = 255;
      } else if (hole) {
        px[i] = 217;
        px[i + 1] = 84;
        px[i + 2] = 43;
        px[i + 3] = 128; // half-transparent centre: alpha survives the trip
      }
    }
  return px;
}

/** Encoded deterministically: a large photo as JPEG (as an upload would be), everything else as PNG. */
export async function generateFixtureAsset(
  asset: FixtureAsset,
): Promise<{ assetVersionId: string; mime: string; bytes: Buffer }> {
  if (asset.kind === 'logo') {
    const bytes = await sharp(logo(asset.width, asset.height), {
      raw: { width: asset.width, height: asset.height, channels: 4 },
    })
      .png({ compressionLevel: 6, adaptiveFiltering: false })
      .toBuffer();
    return { assetVersionId: asset.assetVersionId, mime: 'image/png', bytes };
  }
  const raw =
    asset.kind === 'gradient' ? gradient(asset.width, asset.height) : checker(asset.width, asset.height);
  const image = sharp(raw, { raw: { width: asset.width, height: asset.height, channels: 3 } });
  if (asset.kind === 'gradient') {
    const bytes = await image.jpeg({ quality: 88, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
    return { assetVersionId: asset.assetVersionId, mime: 'image/jpeg', bytes };
  }
  const bytes = await image.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
  return { assetVersionId: asset.assetVersionId, mime: 'image/png', bytes };
}

export interface PixelComparison {
  width: number;
  height: number;
  total: number;
  differing: number;
  /** Percentage of pixels with any channel differing by more than the tolerance. */
  percent: number;
  sameDimensions: boolean;
}

/** Spec 19.5: a pixel differs when any RGBA channel differs by more than `tolerance` (default 2). */
export function comparePng(expected: Buffer, actual: Buffer, tolerance = 2): PixelComparison {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  const total = a.width * a.height;
  if (a.width !== b.width || a.height !== b.height)
    return { width: a.width, height: a.height, total, differing: total, percent: 100, sameDimensions: false };
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs((a.data[i] as number) - (b.data[i] as number)) > tolerance ||
      Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > tolerance ||
      Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)) > tolerance ||
      Math.abs((a.data[i + 3] as number) - (b.data[i + 3] as number)) > tolerance
    )
      differing += 1;
  }
  return {
    width: a.width,
    height: a.height,
    total,
    differing,
    percent: (differing / total) * 100,
    sameDimensions: true,
  };
}

/** A pixelmatch diff image for humans (the gate is comparePng); null when dimensions differ. */
export function diffPng(expected: Buffer, actual: Buffer): Buffer | null {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) return null;
  const out = new PNG({ width: a.width, height: a.height });
  pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.05, includeAA: true });
  return PNG.sync.write(out);
}
