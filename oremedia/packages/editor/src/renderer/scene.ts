import Konva from 'konva';
import type {
  BackgroundElement,
  CreativePage,
  Element,
  FormatDefinition,
  GroupElement,
  ImageElement,
  LogoElement,
  ShapeElement,
  TextElement,
} from '@oremedia/contracts/creative';
import type { SceneElementMetrics, SceneMetrics } from './metrics';

/**
 * Spec 11.5: the ONE Konva scene builder. The studio canvas (apps/web) and the render worker (through the
 * render-only bundle in ./entry.ts) both call buildScene, so preview and export are the same code path. Pure with
 * respect to the DOM: it only creates Konva nodes inside the layer it is given and reads fonts/assets through the
 * context. Coordinates are page pixels (the caller scales the stage for preview; the worker renders 1:1).
 *
 * Semantics fixed here (the golden renders in spec 19.5 pin them):
 *  - z-order is array order; group children carry page-absolute transforms (as packages/editor reflow does);
 *  - rotation is about the element's centre; opacity applies to the whole element;
 *  - text wraps by word inside its box; overflow = measured height > box height ('error' renders the overflow,
 *    'clip' clips to the box, 'shrink_to_fit' reduces the size in 1px steps until it fits or reaches 6px);
 *  - tracking is in em (so reflow's size scaling keeps it proportional); line height is a multiplier;
 *  - text with a strong right-to-left first character is laid out right-to-left;
 *  - images: an explicit crop selects the source region, then `fit` places it (cover keeps aspect and crops towards
 *    the focal point; contain letterboxes; fill stretches). Logos are drawn into their box as-is (stretched if the
 *    box aspect differs) so the logo-distortion check can see what a designer did.
 *  - a missing asset draws a neutral placeholder and reports missingAsset; a font family that is not loaded
 *    renders with the fallback and reports missingFont; an unknown colour token draws black and reports missingColour.
 */
export interface SceneContext {
  format: FormatDefinition;
  /** A URL (data:, blob: or signed https) for an image or logo asset version; null when it cannot be provided. */
  resolveAssetUrl(assetVersionId: string): string | null;
  /** Maps a document font ref (style.fontAssetVersionId) to the CSS font family it was loaded under. */
  fontFamilyFor(fontRef: string): string | null;
  /**
   * Maps a brand colour token key to its #rrggbb value (from the brand snapshot's tokens). Without it every token
   * draws as the fallback colour and is reported as missingColour, so a studio must supply it.
   */
  colourFor?(token: string): string | null;
}

export type { SceneElementMetrics, SceneMetrics } from './metrics';

export interface SceneHandle {
  /**
   * Element id → the element's top-level node: a group at the element's unrotated box (x, y, width, height are
   * the transform's, so a studio can drag/resize it) whose child rotates the content about the box centre.
   */
  nodes: Map<string, Konva.Node>;
  /** Resolves once every image has loaded (or failed) and image nodes are laid out; then draw the layer. */
  ready(): Promise<void>;
  metrics(): SceneMetrics;
  destroy(): void;
}

const PLACEHOLDER_FILL = '#D0D0D0';
const PLACEHOLDER_STROKE = '#9A9A9A';
const FALLBACK_FONT = 'sans-serif';
const FALLBACK_COLOUR = '#000000';
const MIN_SHRINK_PX = 6;
const OVERFLOW_EPSILON = 0.5;

// Strong RTL ranges: Hebrew, Arabic, Syriac, Thaana, NKo, Arabic supplement/extended/presentation forms.
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const STRONG_CHAR = /[\p{L}\p{N}]/u;

/** Direction from the first strong character (the UAX #9 paragraph rule, enough for a caption or headline). */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return true;
    if (STRONG_CHAR.test(ch)) return false;
  }
  return false;
}

/** True when a FontFace with this family is loaded in the document; true when the check is unavailable. */
export function isFontLoaded(family: string): boolean {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts || typeof fonts[Symbol.iterator] !== 'function') return true;
  const wanted = family.replace(/^["']|["']$/g, '');
  for (const face of fonts) {
    if (face.family.replace(/^["']|["']$/g, '') === wanted && face.status === 'loaded') return true;
  }
  return false;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The container every element is drawn into: an outer group at the element's box (x, y, width, height as in the
 * transform, so a studio reads and drags them directly) and an inner group that rotates the content about the box
 * centre; content is drawn in local 0..w × 0..h of the inner group.
 */
function frame(el: Element): { outer: Konva.Group; inner: Konva.Group } {
  const t = el.transform;
  const outer = new Konva.Group({
    id: el.id,
    name: el.type,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    opacity: el.opacity,
    listening: false,
  });
  const inner = new Konva.Group({
    x: t.width / 2,
    y: t.height / 2,
    offsetX: t.width / 2,
    offsetY: t.height / 2,
    rotation: t.rotation,
    listening: false,
  });
  outer.add(inner);
  return { outer, inner };
}

function maskClip(group: Konva.Group, mask: ImageElement['mask'], box: Box): void {
  if (!mask || mask.kind === 'rect') return;
  if (mask.kind === 'circle') {
    group.clipFunc((ctx) => {
      ctx.beginPath();
      ctx.ellipse(box.width / 2, box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2, false);
      ctx.closePath();
    });
    return;
  }
  const r = Math.max(0, Math.min(mask.radius ?? 0, box.width / 2, box.height / 2));
  group.clipFunc((ctx) => {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(box.width - r, 0);
    ctx.arcTo(box.width, 0, box.width, r, r);
    ctx.lineTo(box.width, box.height - r);
    ctx.arcTo(box.width, box.height, box.width - r, box.height, r);
    ctx.lineTo(r, box.height);
    ctx.arcTo(0, box.height, 0, box.height - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
  });
}

function placeholder(box: Box): Konva.Shape[] {
  return [
    new Konva.Rect({ x: 0, y: 0, width: box.width, height: box.height, fill: PLACEHOLDER_FILL }),
    new Konva.Line({
      points: [0, 0, box.width, box.height],
      stroke: PLACEHOLDER_STROKE,
      strokeWidth: 2,
    }),
    new Konva.Line({
      points: [box.width, 0, 0, box.height],
      stroke: PLACEHOLDER_STROKE,
      strokeWidth: 2,
    }),
  ];
}

interface ImagePlacement {
  crop: Box;
  dest: Box;
}

/**
 * Where the source region lands in the box. Pure and shared by the studio and the worker, so a crop or focal point
 * edit previews exactly as it exports.
 */
export function placeImage(
  natural: { width: number; height: number },
  box: Box,
  opts: {
    fit: ImageElement['fit'] | 'stretch';
    crop?: ImageElement['crop'];
    focalPoint?: ImageElement['focalPoint'];
  },
): ImagePlacement {
  const src: Box = opts.crop
    ? {
        x: clamp(opts.crop.x, 0, natural.width),
        y: clamp(opts.crop.y, 0, natural.height),
        width: Math.max(1, Math.min(opts.crop.width, natural.width - clamp(opts.crop.x, 0, natural.width))),
        height: Math.max(
          1,
          Math.min(opts.crop.height, natural.height - clamp(opts.crop.y, 0, natural.height)),
        ),
      }
    : { x: 0, y: 0, width: natural.width, height: natural.height };
  if (opts.fit === 'fill' || opts.fit === 'stretch') return { crop: src, dest: { x: 0, y: 0, ...size(box) } };
  const scaleCover = Math.max(box.width / src.width, box.height / src.height);
  const scaleContain = Math.min(box.width / src.width, box.height / src.height);
  if (opts.fit === 'contain') {
    const w = src.width * scaleContain;
    const h = src.height * scaleContain;
    return { crop: src, dest: { x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h } };
  }
  // cover: the visible source region has the box's aspect; its position follows the focal point.
  const visW = box.width / scaleCover;
  const visH = box.height / scaleCover;
  const fx = opts.focalPoint?.x ?? 0.5;
  const fy = opts.focalPoint?.y ?? 0.5;
  const cx = clamp(src.x + src.width * fx - visW / 2, src.x, src.x + src.width - visW);
  const cy = clamp(src.y + src.height * fy - visH / 2, src.y, src.y + src.height - visH);
  return { crop: { x: cx, y: cy, width: visW, height: visH }, dest: { x: 0, y: 0, ...size(box) } };
}

const size = (b: Box) => ({ width: b.width, height: b.height });
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function buildScene(layer: Konva.Layer, page: CreativePage, ctx: SceneContext): SceneHandle {
  const nodes = new Map<string, Konva.Node>();
  const flags = new Map<string, Partial<SceneElementMetrics>>();
  const pending: Promise<void>[] = [];
  const order: Element[] = [];

  const flag = (id: string, patch: Partial<SceneElementMetrics>) =>
    flags.set(id, { ...(flags.get(id) ?? {}), ...patch });

  const colour = (el: Element, token: string | undefined, raw?: string): string | undefined => {
    if (token) {
      const v = ctx.colourFor?.(token);
      if (v) return v;
      flag(el.id, { missingColour: true });
      return FALLBACK_COLOUR;
    }
    return raw;
  };

  const image = (
    el: ImageElement | LogoElement | BackgroundElement,
    assetVersionId: string,
    box: Box,
    opts: Parameters<typeof placeImage>[2],
    into: Konva.Group,
  ) => {
    const url = ctx.resolveAssetUrl(assetVersionId);
    if (!url) {
      flag(el.id, { missingAsset: true });
      into.add(...placeholder(box));
      return;
    }
    pending.push(
      loadImage(url).then((img) => {
        if (!img || !img.naturalWidth || !img.naturalHeight) {
          flag(el.id, { missingAsset: true });
          into.add(...placeholder(box));
          return;
        }
        const natural = { width: img.naturalWidth, height: img.naturalHeight };
        const p = placeImage(natural, box, opts);
        into.add(
          new Konva.Image({
            image: img,
            x: p.dest.x,
            y: p.dest.y,
            width: p.dest.width,
            height: p.dest.height,
            crop: p.crop,
          }),
        );
        flag(el.id, {
          naturalAspect: p.crop.width / p.crop.height,
          renderedAspect: p.dest.width / p.dest.height,
        });
      }),
    );
  };

  const text = (el: TextElement, into: Konva.Group) => {
    const box = size(el.transform);
    const family = ctx.fontFamilyFor(el.style.fontAssetVersionId);
    if (!family || !isFontLoaded(family)) flag(el.id, { missingFont: true });
    const node = new Konva.Text({
      x: 0,
      y: 0,
      width: box.width,
      text: el.text,
      fontFamily: family || FALLBACK_FONT,
      fontSize: el.style.sizePx,
      fontStyle: String(el.style.weight),
      lineHeight: el.style.lineHeight,
      letterSpacing: el.style.tracking * el.style.sizePx,
      align: el.style.align,
      direction: isRtlText(el.text) ? 'rtl' : 'inherit',
      wrap: 'word',
      fill: colour(el, el.style.colourToken, el.style.colourValue) ?? FALLBACK_COLOUR,
      listening: false,
    });
    const overflows = () => node.height() > box.height + OVERFLOW_EPSILON;
    if (el.style.overflow === 'shrink_to_fit') {
      let px = el.style.sizePx;
      while (overflows() && px > MIN_SHRINK_PX) {
        px -= 1;
        node.fontSize(px);
        node.letterSpacing(el.style.tracking * px);
      }
    }
    if (overflows()) flag(el.id, { textOverflow: true });
    if (el.style.overflow === 'clip') into.clip({ x: 0, y: 0, width: box.width, height: box.height });
    into.add(node);
  };

  const shape = (el: ShapeElement, into: Konva.Group) => {
    const { width, height } = size(el.transform);
    const fill = colour(el, el.fillToken);
    const stroke = colour(el, el.strokeToken);
    const common = {
      ...(fill ? { fill } : {}),
      ...(stroke && el.strokeWidth > 0 ? { stroke, strokeWidth: el.strokeWidth } : {}),
      listening: false,
    };
    if (el.shape === 'rect')
      into.add(new Konva.Rect({ x: 0, y: 0, width, height, cornerRadius: el.cornerRadius, ...common }));
    else if (el.shape === 'ellipse')
      into.add(
        new Konva.Ellipse({
          x: width / 2,
          y: height / 2,
          radiusX: width / 2,
          radiusY: height / 2,
          ...common,
        }),
      );
    else
      into.add(
        new Konva.Line({
          points: [0, height / 2, width, height / 2],
          stroke: stroke ?? fill ?? FALLBACK_COLOUR,
          strokeWidth: el.strokeWidth > 0 ? el.strokeWidth : height,
          listening: false,
        }),
      );
  };

  const background = (el: BackgroundElement, into: Konva.Group) => {
    const box = size(el.transform);
    const fill = colour(el, el.fillToken);
    if (fill) into.add(new Konva.Rect({ x: 0, y: 0, ...box, fill, listening: false }));
    if (el.assetVersionId) image(el, el.assetVersionId, { x: 0, y: 0, ...box }, { fit: 'cover' }, into);
  };

  const add = (el: Element, parent: Konva.Container) => {
    if (!el.visible) return;
    order.push(el);
    if (el.type === 'group') {
      const g = new Konva.Group({ id: el.id, name: 'group', opacity: el.opacity, listening: false });
      parent.add(g);
      nodes.set(el.id, g);
      for (const child of (el as GroupElement).children) add(child, g);
      return;
    }
    const { outer, inner: f } = frame(el);
    parent.add(outer);
    nodes.set(el.id, outer);
    const box = { x: 0, y: 0, ...size(el.transform) };
    switch (el.type) {
      case 'text':
        text(el, f);
        break;
      case 'image':
        maskClip(f, el.mask, box);
        image(
          el,
          el.assetVersionId,
          box,
          {
            fit: el.fit,
            ...(el.crop ? { crop: el.crop } : {}),
            ...(el.focalPoint ? { focalPoint: el.focalPoint } : {}),
          },
          f,
        );
        break;
      case 'logo':
        image(el, el.assetVersionId, box, { fit: 'stretch' }, f);
        break;
      case 'shape':
        shape(el, f);
        break;
      case 'background':
        background(el, f);
        break;
    }
  };

  for (const el of page.elements) add(el, layer);

  return {
    nodes,
    ready: async () => {
      // Images that load images (none today) would extend `pending` while awaiting; drain until stable.
      let done = 0;
      while (done < pending.length) {
        const batch = pending.slice(done);
        done = pending.length;
        await Promise.all(batch);
      }
    },
    metrics: () => ({
      elements: order.map((el) => {
        const node = nodes.get(el.id);
        const rect = node
          ? node.getClientRect({ relativeTo: layer, skipShadow: true })
          : { x: el.transform.x, y: el.transform.y, width: el.transform.width, height: el.transform.height };
        return {
          elementId: el.id,
          kind: el.type,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ...(flags.get(el.id) ?? {}),
        };
      }),
    }),
    destroy: () => {
      for (const el of order) {
        const node = nodes.get(el.id);
        if (node && node.getParent()) node.destroy();
      }
      nodes.clear();
      flags.clear();
      order.length = 0;
    },
  };
}
