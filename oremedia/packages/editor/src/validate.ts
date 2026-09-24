import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Finding,
  TextElement,
} from '@oremedia/contracts/creative';
import { formatFor } from './formats';

/** Relative luminance and WCAG contrast ratio for #rrggbb values. */
export function contrastRatio(a: string, b: string): number | null {
  const lum = (hex: string): number | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1] as string, 16);
    const ch = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  };
  const la = lum(a);
  const lb = lum(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const overlap = (a: Element, b: Element, margin: number): boolean => {
  const A = a.transform;
  const B = b.transform;
  return !(
    B.x > A.x + A.width + margin ||
    B.x + B.width < A.x - margin ||
    B.y > A.y + A.height + margin ||
    B.y + B.height < A.y - margin
  );
};

function flat(els: Element[]): Element[] {
  const out: Element[] = [];
  for (const el of els) {
    out.push(el);
    if (el.type === 'group') out.push(...flat(el.children));
  }
  return out;
}

/**
 * Spec 11.4: deterministic validation against the brand snapshot: tokens, logo rules, minimum sizes, contrast,
 * approved facts, prohibited phrases, safe areas. Agent proposals must have no blocking findings; humans see
 * warnings. Render-time checks (spec 11.5) run again on the actual pixels.
 */
export function validateAgainstBrand(doc: CreativeDocumentV1, snapshot: BrandSnapshot): Finding[] {
  const findings: Finding[] = [];
  const colours = new Map(snapshot.document.tokens.colours.map((c) => [c.key, c]));
  const typeRoles = new Map(snapshot.document.tokens.typeRoles.map((t) => [t.role, t]));
  const approvedFacts = new Set(snapshot.facts.map((f) => f.id));
  const prohibited = snapshot.document.voice.prohibitedPhrases.map((p) => p.toLowerCase()).filter(Boolean);
  const target = snapshot.document.tokens.contrastTarget;
  const minContrast = (sizePx: number) =>
    target === 'AAA' ? (sizePx >= 24 ? 4.5 : 7) : sizePx >= 24 ? 3 : 4.5;

  for (const page of doc.pages) {
    const format = formatFor(page.formatKey);
    const all = flat(page.elements);
    const background = page.elements.find(
      (e): e is Extract<Element, { type: 'background' }> => e.type === 'background',
    );
    const bgHex = background?.fillToken ? colours.get(background.fillToken)?.value : undefined;

    for (const el of all) {
      const at = { pageId: page.id, elementId: el.id };
      if (format) {
        const t = el.transform;
        const inside =
          t.x >= format.safeArea.left &&
          t.y >= format.safeArea.top &&
          t.x + t.width <= format.width - format.safeArea.right &&
          t.y + t.height <= format.height - format.safeArea.bottom;
        if (!inside && el.type !== 'background' && el.semanticRole !== 'decoration')
          findings.push({
            code: 'safe_area',
            severity:
              el.semanticRole === 'legal' || el.type === 'logo' || el.type === 'text'
                ? 'blocking'
                : 'warning',
            message: `${el.name} leaves the safe area of ${format.label}`,
            ...at,
          });
      }
      if (el.type === 'text')
        findings.push(
          ...validateText(
            el,
            at,
            colours,
            typeRoles,
            approvedFacts,
            prohibited,
            backdropsFor(el, all, bgHex, background, colours),
            minContrast,
          ),
        );
      if (el.type === 'shape') {
        if (el.fillToken && !colours.has(el.fillToken))
          findings.push({
            code: 'unknown_colour_token',
            severity: 'blocking',
            message: `Unknown colour token ${el.fillToken}`,
            ...at,
          });
      }
      if (el.type === 'background' && el.fillToken && !colours.has(el.fillToken))
        findings.push({
          code: 'unknown_colour_token',
          severity: 'blocking',
          message: `Unknown colour token ${el.fillToken}`,
          ...at,
        });
      if (el.type === 'logo') findings.push(...validateLogo(el, page, all, background, snapshot, at));
    }
  }
  return findings;
}

type Rect = { x: number; y: number; width: number; height: number };
const area = (r: Rect) => r.width * r.height;
const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x;
  const h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
};
/** a minus b as up to four rectangles. */
const subtract = (a: Rect, b: Rect): Rect[] => {
  const i = intersect(a, b);
  if (!i) return [a];
  const out: Rect[] = [];
  if (i.y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: i.y - a.y });
  if (i.y + i.height < a.y + a.height)
    out.push({ x: a.x, y: i.y + i.height, width: a.width, height: a.y + a.height - (i.y + i.height) });
  if (i.x > a.x) out.push({ x: a.x, y: i.y, width: i.x - a.x, height: i.height });
  if (i.x + i.width < a.x + a.width)
    out.push({ x: i.x + i.width, y: i.y, width: a.x + a.width - (i.x + i.width), height: i.height });
  return out;
};

/** A solid colour under a text element: the share of the text box it shows through, and how much of that is clear. */
export interface Backdrop {
  hex: string;
  share: number;
  /** The part of `share` not overlapped by anything above it without a static colour (translucent or tilted). */
  clearShare: number;
}

/** The axis-aligned box enclosing a rotated element (rotation about its box centre). */
const footprint = (t: Element['transform']): Rect => {
  if (t.rotation === 0) return t;
  const rad = (t.rotation * Math.PI) / 180;
  const w = Math.abs(t.width * Math.cos(rad)) + Math.abs(t.height * Math.sin(rad));
  const h = Math.abs(t.width * Math.sin(rad)) + Math.abs(t.height * Math.cos(rad));
  return { x: t.x + t.width / 2 - w / 2, y: t.y + t.height / 2 - h / 2, width: w, height: h };
};

/**
 * The solid colours a text element sits on, for the static contrast check, each with the share of the text box it
 * shows through. Walks down the paint order (array order of the flattened page; group children carry page-absolute
 * transforms) from just under the text, tracking which part of the text box is still uncovered:
 *  - a visible, opaque, filled rect or rounded rect (corners treated as square) in the text's frame (unrotated, or
 *    rotated by the same angle about the same centre) takes the uncovered area it overlaps, with its colour;
 *  - an ellipse shows its colour where it overlaps but is not assumed to hide what is beneath (its corners do not);
 *  - an opaque, unmasked, cover/fill image takes the area it overlaps with no static colour: the render-time check
 *    (spec 11.5) measures those pixels;
 *  - translucent fills and shapes in another frame have no static colour and hide nothing, but where their footprint
 *    lies over the text the colours beneath are not clear (the render check measures the blend there);
 *  - lines are ignored;
 *  - the page background takes whatever is left (an image background has no static colour).
 * Shares of the same colour from separate shapes add up.
 */
function backdropsFor(
  text: TextElement,
  all: Element[],
  bgHex: string | undefined,
  background: Element | undefined,
  colours: Map<string, { key: string; value: string }>,
): Backdrop[] {
  const box = text.transform;
  const total = area(box);
  const sameFrame = (t: Element['transform']) =>
    t.rotation === box.rotation &&
    (t.rotation === 0 ||
      (Math.abs(t.x + t.width / 2 - (box.x + box.width / 2)) < 0.5 &&
        Math.abs(t.y + t.height / 2 - (box.y + box.height / 2)) < 0.5));
  let uncovered: Rect[] = [box];
  const obscurers: Rect[] = [];
  const shares = new Map<string, { share: number; clearShare: number }>();
  const clearArea = (r: Rect) =>
    obscurers
      .reduce<Rect[]>((pieces, o) => pieces.flatMap((p) => subtract(p, o)), [r])
      .reduce((sum, p) => sum + area(p), 0);
  const note = (hex: string, pieces: Rect[]) => {
    const prev = shares.get(hex) ?? { share: 0, clearShare: 0 };
    shares.set(hex, {
      share: prev.share + pieces.reduce((sum, p) => sum + area(p), 0) / total,
      clearShare: prev.clearShare + pieces.reduce((sum, p) => sum + clearArea(p), 0) / total,
    });
  };
  const take = (r: Rect, hex: string | undefined, hides: boolean) => {
    const pieces: Rect[] = [];
    const next: Rect[] = [];
    for (const u of uncovered) {
      const i = intersect(u, r);
      if (i) pieces.push(i);
      next.push(...(hides ? subtract(u, r) : [u]));
    }
    if (hex && pieces.length) note(hex, pieces);
    uncovered = next;
  };
  for (const under of all.slice(0, Math.max(0, all.indexOf(text))).reverse()) {
    if (!uncovered.length) break;
    if (under === background || under.type === 'group' || !under.visible) continue;
    if (under.type === 'shape' && under.shape === 'line') continue;
    if (under.opacity !== 1 || !sameFrame(under.transform)) {
      obscurers.push(footprint(under.transform));
      continue;
    }
    if (under.type === 'image') {
      if (!under.mask && under.fit !== 'contain') take(under.transform, undefined, true);
      continue;
    }
    if (under.type !== 'shape' || !under.fillToken) continue;
    const hex = colours.get(under.fillToken)?.value;
    if (hex) take(under.transform, hex, under.shape === 'rect');
  }
  if (bgHex && uncovered.length) note(bgHex, uncovered);
  return [...shares].map(([hex, v]) => ({ hex, ...v }));
}

/** A failing colour under less than this share of the text box is a warning; the render check measures pixels. */
const BLOCKING_SHARE = 0.1;

function validateText(
  el: TextElement,
  at: { pageId: string; elementId: string },
  colours: Map<string, { key: string; value: string }>,
  typeRoles: Map<string, { minSizePx: number; fontAssetId: string }>,
  approvedFacts: Set<string>,
  prohibited: string[],
  backdrops: Backdrop[],
  minContrast: (sizePx: number) => number,
): Finding[] {
  const out: Finding[] = [];
  const role = typeRoles.get(el.style.typeRole);
  if (role && el.style.sizePx < role.minSizePx)
    out.push({
      code: 'min_size',
      severity: 'blocking',
      message: `${el.style.typeRole} text below the brand minimum of ${role.minSizePx}px`,
      ...at,
    });
  if (el.style.colourToken && !colours.has(el.style.colourToken))
    out.push({
      code: 'unknown_colour_token',
      severity: 'blocking',
      message: `Unknown colour token ${el.style.colourToken}`,
      ...at,
    });
  if (!el.style.colourToken && el.style.colourValue)
    out.push({
      code: 'raw_colour',
      severity: 'warning',
      message: 'Raw colour value used instead of a brand token',
      ...at,
    });
  const fg = el.style.colourToken ? colours.get(el.style.colourToken)?.value : el.style.colourValue;
  if (fg) {
    const target = minContrast(el.style.sizePx);
    const failing = backdrops
      .map((b) => ({ ...b, ratio: contrastRatio(fg, b.hex) }))
      .filter((b): b is Backdrop & { ratio: number } => b.ratio !== null && b.ratio < target);
    if (failing.length) {
      const worst = failing.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      const major = failing.some((b) => b.clearShare >= BLOCKING_SHARE);
      out.push({
        code: 'contrast',
        severity: major ? 'blocking' : 'warning',
        message: major
          ? `Contrast ${worst.ratio.toFixed(2)}:1 is below the ${target}:1 target`
          : `Contrast ${worst.ratio.toFixed(2)}:1 against a backdrop that is partly hidden or only a sliver of the text box; the render check measures the pixels`,
        ...at,
      });
    }
  }
  for (const f of el.factRefs)
    if (!approvedFacts.has(f))
      out.push({
        code: 'unknown_fact',
        severity: 'blocking',
        message: `Text asserts fact ${f} which is not approved`,
        factId: f,
        ...at,
      });
  const lower = el.text.toLowerCase();
  for (const p of prohibited)
    if (lower.includes(p))
      out.push({
        code: 'prohibited_phrase',
        severity: 'blocking',
        message: `Prohibited phrase "${p}"`,
        ...at,
      });
  // Approximate overflow: average glyph width 0.55em; the render check is authoritative (spec 11.5).
  const approxLineChars = Math.max(1, Math.floor(el.transform.width / (0.55 * el.style.sizePx)));
  const approxLines = Math.ceil(el.text.length / approxLineChars);
  if (
    el.style.overflow === 'error' &&
    approxLines * el.style.sizePx * el.style.lineHeight > el.transform.height * 1.1
  )
    out.push({ code: 'possible_overflow', severity: 'warning', message: 'Text may overflow its box', ...at });
  return out;
}

function validateLogo(
  el: Extract<Element, { type: 'logo' }>,
  page: CreativePage,
  all: Element[],
  background: Element | undefined,
  snapshot: BrandSnapshot,
  at: { pageId: string; elementId: string },
): Finding[] {
  const out: Finding[] = [];
  const rule = snapshot.document.logoRules.find((r) => r.variant === el.variant);
  if (!rule)
    return [
      {
        code: 'logo_rule_missing',
        severity: 'warning',
        message: `No logo rule for variant ${el.variant}`,
        ...at,
      },
    ];
  if (el.transform.width < rule.minWidthPx)
    out.push({
      code: 'logo_min_width',
      severity: 'blocking',
      message: `Logo narrower than the minimum ${rule.minWidthPx}px`,
      ...at,
    });
  if (
    background &&
    background.type === 'background' &&
    background.fillToken &&
    !rule.allowedBackgroundColourKeys.includes(background.fillToken)
  )
    out.push({
      code: 'logo_background',
      severity: 'blocking',
      message: `Logo variant ${el.variant} is not allowed on background ${background.fillToken}`,
      ...at,
    });
  const clear = rule.clearSpaceRatio * el.transform.height;
  for (const other of all) {
    if (other.id === el.id || other.type === 'background' || other.semanticRole === 'decoration') continue;
    if (overlap(el, other, clear))
      out.push({
        code: 'logo_clear_space',
        severity: 'blocking',
        message: `${other.name} intrudes on the logo clear space`,
        ...at,
      });
  }
  if (el.transform.rotation !== 0)
    out.push({ code: 'logo_rotated', severity: 'blocking', message: 'Logos are never rotated', ...at });
  void page;
  return out;
}
