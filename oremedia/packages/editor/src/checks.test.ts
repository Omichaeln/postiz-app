import { describe, expect, it } from 'vitest';
import type { CreativeDocumentV1, CreativePage, Element } from '@oremedia/contracts/creative';
import { LOGO_DISTORTION_TOLERANCE, minContrastFor, runRenderChecks, type RenderCheckInput } from './checks';
import { eid, fixtureDocument, fixtureSnapshot, ids } from './fixtures';
import { FORMAT_DEFINITIONS } from './formats';
import type { SceneElementMetrics, SceneMetrics } from './renderer/metrics';

const format = FORMAT_DEFINITIONS['square_1080']!;

/** Metrics as the scene reports them for an unrotated, well-behaved render: every box is its transform. */
function metricsFor(
  page: CreativePage,
  patch: Record<string, Partial<SceneElementMetrics>> = {},
): SceneMetrics {
  const walk = (els: Element[]): SceneElementMetrics[] =>
    els.flatMap((el) => [
      {
        elementId: el.id,
        kind: el.type,
        x: el.transform.x,
        y: el.transform.y,
        width: el.transform.width,
        height: el.transform.height,
        ...(patch[el.id] ?? {}),
      },
      ...(el.type === 'group' ? walk(el.children) : []),
    ]);
  return { elements: walk(page.elements) };
}

function input(
  doc: CreativeDocumentV1 = fixtureDocument(),
  patch: Record<string, Partial<SceneElementMetrics>> = {},
  extra: Partial<RenderCheckInput> = {},
): RenderCheckInput {
  const page = doc.pages[0]!;
  return {
    doc,
    page,
    format,
    metrics: metricsFor(page, patch),
    snapshot: fixtureSnapshot(),
    output: { width: 1080, height: 1080, bytes: 200_000 },
    ...extra,
  };
}

const codes = (r: ReturnType<typeof runRenderChecks>) => r.findings.map((f) => f.code).sort();
const blocking = (r: ReturnType<typeof runRenderChecks>) =>
  r.findings.filter((f) => f.severity === 'blocking').map((f) => f.code);

describe('runRenderChecks (spec 11.5 deterministic checks)', () => {
  it('a clean fixture render has no blocking finding and validation ok', () => {
    const r = runRenderChecks(input());
    expect(blocking(r)).toEqual([]);
    expect(r.ok).toBe(true);
    // The estimate-based findings are replaced by measured ones, never reported twice.
    expect(codes(r)).not.toContain('possible_overflow');
  });

  it('measured text overflow blocks for overflow=error and warns for overflow=clip', () => {
    const doc = fixtureDocument();
    const r = runRenderChecks(input(doc, { [ids.body]: { textOverflow: true, height: 140 } }));
    expect(r.ok).toBe(false);
    expect(r.findings.find((f) => f.code === 'text_overflow')).toMatchObject({
      severity: 'blocking',
      pageId: 'page_1',
      elementId: ids.body,
    });
    const clipped = fixtureDocument();
    const body = clipped.pages[0]!.elements.find((e) => e.id === ids.body) as Extract<
      Element,
      { type: 'text' }
    >;
    body.style.overflow = 'clip';
    const c = runRenderChecks(input(clipped, { [ids.body]: { textOverflow: true } }));
    expect(c.findings.find((f) => f.elementId === ids.body && f.code.startsWith('text_'))).toMatchObject({
      code: 'text_clipped',
      severity: 'warning',
    });
    expect(c.ok).toBe(true);
  });

  it('a missing font or asset blocks the export', () => {
    const r = runRenderChecks(
      input(fixtureDocument(), {
        [ids.headline]: { missingFont: true },
        [ids.image]: { missingAsset: true },
      }),
    );
    expect(blocking(r).sort()).toEqual(['missing_asset', 'missing_font']);
    expect(r.findings.find((f) => f.code === 'missing_font')?.elementId).toBe(ids.headline);
    expect(r.findings.find((f) => f.code === 'missing_asset')?.elementId).toBe(ids.image);
  });

  it('logo distortion: aspect change above 0.5 % blocks, below passes', () => {
    const natural = 200 / 60;
    const distorted = runRenderChecks(
      input(fixtureDocument(), { [ids.logo]: { naturalAspect: natural, renderedAspect: natural * 1.02 } }),
    );
    expect(blocking(distorted)).toEqual(['logo_distortion']);
    const fine = runRenderChecks(
      input(fixtureDocument(), {
        [ids.logo]: {
          naturalAspect: natural,
          renderedAspect: natural * (1 + LOGO_DISTORTION_TOLERANCE * 0.8),
        },
      }),
    );
    expect(codes(fine)).not.toContain('logo_distortion');
  });

  it('contrast is computed against the colour actually under the text, not only the page background', () => {
    // Body text 'ink' on 'paper' passes; the same text drawn on an 'ink' rectangle fails.
    const doc = fixtureDocument();
    const page = doc.pages[0]!;
    const bodyIndex = page.elements.findIndex((e) => e.id === ids.body);
    const body = page.elements[bodyIndex] as Extract<Element, { type: 'text' }>;
    const panel: Element = {
      id: eid('01HPANEL'),
      name: 'Panel',
      type: 'shape',
      shape: 'rect',
      locked: false,
      visible: true,
      opacity: 1,
      protected: false,
      transform: { x: 60, y: 740, width: 960, height: 120, rotation: 0 },
      fillToken: 'ink',
      strokeWidth: 0,
      cornerRadius: 0,
    };
    page.elements.splice(bodyIndex, 0, panel);
    const r = runRenderChecks(input(doc));
    const contrast = r.findings.find((f) => f.code === 'contrast' && f.elementId === body.id);
    expect(contrast).toMatchObject({ severity: 'blocking' });
    expect(contrast?.message).toContain('#172120');
    expect(minContrastFor('AA', 24)).toBe(3);
    expect(minContrastFor('AA', 18)).toBe(4.5);
    expect(minContrastFor('AAA', 18)).toBe(7);
  });

  it('text over an image reports contrast as unverified (info), never a guessed ratio', () => {
    const doc = fixtureDocument();
    const page = doc.pages[0]!;
    const body = page.elements.find((e) => e.id === ids.body) as Extract<Element, { type: 'text' }>;
    body.transform = { x: 100, y: 300, width: 800, height: 80, rotation: 0 }; // inside the hero image box
    const r = runRenderChecks(input(doc));
    expect(r.findings.find((f) => f.elementId === body.id && f.code.startsWith('contrast'))).toMatchObject({
      code: 'contrast_unverified',
      severity: 'info',
    });
  });

  it('a rotated element whose drawn box leaves the safe area is reported from the measured box', () => {
    const doc = fixtureDocument();
    const page = doc.pages[0]!;
    const cta = page.elements.find((e) => e.id === ids.headline) as Extract<Element, { type: 'text' }>;
    cta.transform = { ...cta.transform, rotation: 20 };
    // Transform-based validation sees x=80..1000 inside; the measured rotated box crosses the left safe edge.
    const r = runRenderChecks(input(doc, { [ids.headline]: { x: 30, width: 1000, y: 60, height: 300 } }));
    expect(r.findings.find((f) => f.code === 'safe_area' && f.elementId === ids.headline)).toMatchObject({
      severity: 'blocking',
    });
    // Reported once even when validateAgainstBrand also flags it.
    expect(r.findings.filter((f) => f.code === 'safe_area' && f.elementId === ids.headline)).toHaveLength(1);
  });

  it('provider limits and a size mismatch block the export', () => {
    const r = runRenderChecks(
      input(fixtureDocument(), {}, { limits: { maxBytes: 100_000, maxWidth: 1000, maxHeight: 2000 } }),
    );
    expect(blocking(r).sort()).toEqual(['dimension_limit', 'file_size_limit']);
    const mismatch = runRenderChecks(
      input(fixtureDocument(), {}, { output: { width: 1080, height: 1350, bytes: 10 } }),
    );
    expect(blocking(mismatch)).toEqual(['format_mismatch']);
    const withinLimits = runRenderChecks(
      input(fixtureDocument(), {}, { limits: { maxBytes: 5_000_000, maxWidth: 1080, maxHeight: 1080 } }),
    );
    expect(withinLimits.ok).toBe(true);
  });

  it('brand rules from validateAgainstBrand are carried over for the page (logo minimum width)', () => {
    const doc = fixtureDocument();
    const logo = doc.pages[0]!.elements.find((e) => e.id === ids.logo)!;
    logo.transform = { ...logo.transform, width: 100 };
    const r = runRenderChecks(input(doc));
    expect(blocking(r)).toContain('logo_min_width');
  });
});
