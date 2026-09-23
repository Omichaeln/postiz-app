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
          ...validateText(el, at, colours, typeRoles, approvedFacts, prohibited, bgHex, minContrast),
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

function validateText(
  el: TextElement,
  at: { pageId: string; elementId: string },
  colours: Map<string, { key: string; value: string }>,
  typeRoles: Map<string, { minSizePx: number; fontAssetId: string }>,
  approvedFacts: Set<string>,
  prohibited: string[],
  bgHex: string | undefined,
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
  if (fg && bgHex) {
    const ratio = contrastRatio(fg, bgHex);
    if (ratio !== null && ratio < minContrast(el.style.sizePx))
      out.push({
        code: 'contrast',
        severity: 'blocking',
        message: `Contrast ${ratio.toFixed(2)}:1 is below the ${minContrast(el.style.sizePx)}:1 target`,
        ...at,
      });
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
