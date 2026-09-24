import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Finding,
  FormatDefinition,
  RenderValidationResult,
  TextElement,
} from '@oremedia/contracts/creative';
import type { SceneElementMetrics, SceneMetrics } from './renderer/metrics';
import { contrastRatio, validateAgainstBrand } from './validate';

/**
 * Spec 11.5: the deterministic checks run on every export, as pure functions over the document, the format, the
 * scene metrics the renderer measured and the brand snapshot. Brand rules (logo clear space and minimum size,
 * background/variant rules, minimum type sizes, tokens, facts) come from validateAgainstBrand (spec 11.4) so they
 * exist once; this module adds what only a render can know (measured text overflow, missing fonts and assets,
 * logo distortion, the background actually under a text, rotated bounding boxes) and the provider limits. The AI
 * brand review supplements these findings and never replaces them.
 */
export interface RenderLimits {
  /** Provider capability limits supplied at dispatch (spec 14.6); absent = no limit. */
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface RenderCheckInput {
  doc: CreativeDocumentV1;
  page: CreativePage;
  format: FormatDefinition;
  metrics: SceneMetrics;
  snapshot: BrandSnapshot;
  output: { width: number; height: number; bytes: number };
  limits?: RenderLimits;
}

/** Aspect-ratio change above which a logo counts as distorted (spec 11.5: 0.5 %). */
export const LOGO_DISTORTION_TOLERANCE = 0.005;

/** WCAG minimum contrast for the brand's target and the text size (large text ≥ 24px). */
export const minContrastFor = (
  target: BrandSnapshot['document']['tokens']['contrastTarget'],
  sizePx: number,
) => (target === 'AAA' ? (sizePx >= 24 ? 4.5 : 7) : sizePx >= 24 ? 3 : 4.5);

/** Findings that the render-time measurement replaces (validateAgainstBrand's estimates of the same rule). */
const REPLACED_BY_RENDER = new Set(['possible_overflow', 'contrast']);

function flat(els: Element[]): Element[] {
  const out: Element[] = [];
  for (const el of els) {
    out.push(el);
    if (el.type === 'group') out.push(...flat(el.children));
  }
  return out;
}

type Rect = Pick<SceneElementMetrics, 'x' | 'y' | 'width' | 'height'>;

const contains = (outer: Rect, inner: Rect, slack = 0.5): boolean =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

const intersects = (a: Rect, b: Rect): boolean =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const insideSafeArea = (r: Rect, format: FormatDefinition): boolean =>
  contains(
    {
      x: format.safeArea.left,
      y: format.safeArea.top,
      width: format.width - format.safeArea.left - format.safeArea.right,
      height: format.height - format.safeArea.top - format.safeArea.bottom,
    },
    r,
  );

/** Same severity rule as validateAgainstBrand's safe-area finding: copy and logos block, decoration never does. */
const safeAreaSeverity = (el: Element): Finding['severity'] =>
  el.semanticRole === 'legal' || el.type === 'logo' || el.type === 'text' ? 'blocking' : 'warning';

/**
 * The colour drawn under a text: the topmost element below it in z-order whose box contains the text box and that
 * has a flat, opaque colour. An image, logo, photo background or translucent fill under the text makes the
 * background unknowable without pixels: reported as unverified rather than guessed.
 */
function computedBackground(
  text: TextElement,
  ordered: Element[],
  rects: Map<string, Rect>,
  colours: Map<string, string>,
): { hex: string } | { unknown: string } | null {
  const textRect = rects.get(text.id);
  if (!textRect) return null;
  let found: { hex: string } | { unknown: string } | null = null;
  for (const el of ordered) {
    if (el.id === text.id) break;
    if (el.type === 'group' || !el.visible) continue;
    const rect = rects.get(el.id);
    if (!rect || !intersects(rect, textRect)) continue;
    if (el.type === 'image' || el.type === 'logo') {
      found = { unknown: `${el.name} (${el.type})` };
      continue;
    }
    if (el.type === 'background' && el.assetVersionId) {
      found = { unknown: `${el.name} (photo background)` };
      continue;
    }
    if (el.type !== 'shape' && el.type !== 'background') continue;
    if (el.type === 'shape' && el.shape === 'line') continue;
    const hex = el.fillToken ? colours.get(el.fillToken) : undefined;
    if (!hex) continue;
    if (el.opacity < 1 || (el.type === 'shape' && el.shape === 'ellipse') || !contains(rect, textRect)) {
      found = { unknown: `${el.name} (partial or translucent fill)` };
      continue;
    }
    found = { hex };
  }
  return found;
}

export function runRenderChecks(input: RenderCheckInput): RenderValidationResult {
  const { doc, page, format, metrics, snapshot, output, limits } = input;
  const findings: Finding[] = validateAgainstBrand(doc, snapshot).filter(
    (f) => f.pageId === page.id && !REPLACED_BY_RENDER.has(f.code),
  );
  const has = (elementId: string, code: string) =>
    findings.some((f) => f.elementId === elementId && f.code === code);
  const colours = new Map(snapshot.document.tokens.colours.map((c) => [c.key, c.value]));
  const ordered = flat(page.elements);
  const byId = new Map(ordered.map((el) => [el.id, el]));
  const rects = new Map<string, Rect>(metrics.elements.map((m) => [m.elementId, m]));
  const target = snapshot.document.tokens.contrastTarget;

  for (const m of metrics.elements) {
    const el = byId.get(m.elementId);
    if (!el) continue;
    const at = { pageId: page.id, elementId: el.id };
    if (m.textOverflow && el.type === 'text')
      findings.push(
        el.style.overflow === 'clip'
          ? { code: 'text_clipped', severity: 'warning', message: `${el.name} is clipped by its box`, ...at }
          : {
              code: 'text_overflow',
              severity: 'blocking',
              message: `${el.name} overflows its box (${Math.round(m.height)}px of ${el.transform.height}px)`,
              ...at,
            },
      );
    if (m.missingFont)
      findings.push({
        code: 'missing_font',
        severity: 'blocking',
        message: `${el.name} rendered without its pinned font`,
        ...at,
      });
    if (m.missingAsset)
      findings.push({
        code: 'missing_asset',
        severity: 'blocking',
        message: `${el.name} rendered with a placeholder: asset unavailable`,
        ...at,
      });
    if (m.missingColour && !has(el.id, 'unknown_colour_token'))
      findings.push({
        code: 'unknown_colour_token',
        severity: 'blocking',
        message: `${el.name} uses a colour token the brand does not define`,
        ...at,
      });
    if (el.type === 'logo' && m.naturalAspect && m.renderedAspect) {
      const change = Math.abs(m.renderedAspect / m.naturalAspect - 1);
      if (change > LOGO_DISTORTION_TOLERANCE)
        findings.push({
          code: 'logo_distortion',
          severity: 'blocking',
          message: `Logo aspect ratio changed by ${(change * 100).toFixed(1)}% (limit 0.5%)`,
          ...at,
        });
    }
    if (
      el.type !== 'background' &&
      el.type !== 'group' &&
      el.semanticRole !== 'decoration' &&
      !insideSafeArea(m, format) &&
      !has(el.id, 'safe_area')
    )
      findings.push({
        code: 'safe_area',
        severity: safeAreaSeverity(el),
        message: `${el.name} is drawn outside the safe area of ${format.label}`,
        ...at,
      });
    if (el.type === 'text') {
      const fg = el.style.colourToken ? colours.get(el.style.colourToken) : el.style.colourValue;
      const bg = computedBackground(el, ordered, rects, colours);
      if (fg && bg && 'hex' in bg) {
        const ratio = contrastRatio(fg, bg.hex);
        const min = minContrastFor(target, el.style.sizePx);
        if (ratio !== null && ratio < min)
          findings.push({
            code: 'contrast',
            severity: 'blocking',
            message: `Contrast ${ratio.toFixed(2)}:1 against ${bg.hex} is below the ${min}:1 ${target} target`,
            ...at,
          });
      } else if (fg && bg && 'unknown' in bg)
        findings.push({
          code: 'contrast_unverified',
          severity: 'info',
          message: `${el.name} sits on ${bg.unknown}; contrast needs visual review`,
          ...at,
        });
    }
  }

  if (output.width !== format.width || output.height !== format.height)
    findings.push({
      code: 'format_mismatch',
      severity: 'blocking',
      message: `Export is ${output.width}×${output.height}, format ${format.label} is ${format.width}×${format.height}`,
      pageId: page.id,
    });
  if (limits?.maxWidth !== undefined && output.width > limits.maxWidth)
    findings.push({
      code: 'dimension_limit',
      severity: 'blocking',
      message: `Width ${output.width}px exceeds the channel limit of ${limits.maxWidth}px`,
      pageId: page.id,
    });
  if (limits?.maxHeight !== undefined && output.height > limits.maxHeight)
    findings.push({
      code: 'dimension_limit',
      severity: 'blocking',
      message: `Height ${output.height}px exceeds the channel limit of ${limits.maxHeight}px`,
      pageId: page.id,
    });
  if (limits?.maxBytes !== undefined && output.bytes > limits.maxBytes)
    findings.push({
      code: 'file_size_limit',
      severity: 'blocking',
      message: `File is ${output.bytes} bytes, above the channel limit of ${limits.maxBytes}`,
      pageId: page.id,
    });

  return { ok: !findings.some((f) => f.severity === 'blocking'), findings };
}
