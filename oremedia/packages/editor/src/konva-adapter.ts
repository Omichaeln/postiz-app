import Konva from 'konva';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  FormatDefinition,
  Operation,
  OperationBatch,
} from '@oremedia/contracts/creative';
import type { EditorAdapter, EditorHandle, Unsubscribe } from './adapter';
import { formatFor } from './formats';
import { findElement } from './reduce';
import { buildScene, type SceneContext, type SceneHandle } from './renderer/scene';

/** A batch without its base revision: the application owns the committed document and decides when to send it. */
export type IntentBatch = Omit<OperationBatch, 'baseRevisionId'>;

// ---------------------------------------------------------------------------------------------------------------
// Gesture → operation mapping. Pure, unit-tested without a DOM: the stage only reports positions and sizes.
// ---------------------------------------------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Locked, hidden and background elements are not draggable in the UI; the server guard is the real policy. Groups
 * are selectable only: their children carry page-absolute transforms (scene.ts), so a group drag has no operation.
 */
export function isInteractive(el: Element, readOnly: boolean): boolean {
  return !readOnly && el.visible && !el.locked && el.type !== 'background' && el.type !== 'group';
}

export function moveIntent(page: CreativePage, elementId: string, x: number, y: number): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el || el.locked) return null;
  const nx = round2(x);
  const ny = round2(y);
  if (nx === el.transform.x && ny === el.transform.y) return null;
  return {
    operations: [{ op: 'moveElement', pageId: page.id, elementId, x: nx, y: ny }],
    summary: `Move ${el.name}`,
    origin: 'user',
  };
}

/** Keyboard path (spec 21.3): arrow keys nudge by 1px, 10px with shift; the app decides the step. */
export function nudgeIntent(
  page: CreativePage,
  elementId: string,
  dx: number,
  dy: number,
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el) return null;
  return moveIntent(page, elementId, el.transform.x + dx, el.transform.y + dy);
}

/** Logos keep their aspect ratio whatever the gesture (spec 11.5: logo distortion is a blocking check). */
export function resizeIntent(
  page: CreativePage,
  elementId: string,
  width: number,
  height: number,
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el || el.locked) return null;
  let w = Math.max(1, round2(width));
  let h = Math.max(1, round2(height));
  if (el.type === 'logo') {
    const ratio = el.transform.width / el.transform.height;
    h = round2(w / ratio);
    if (h < 1) {
      h = 1;
      w = round2(ratio);
    }
  }
  if (w === el.transform.width && h === el.transform.height) return null;
  return {
    operations: [{ op: 'resizeElement', pageId: page.id, elementId, width: w, height: h }],
    summary: `Resize ${el.name}`,
    origin: 'user',
  };
}

/** A transform gesture can move and resize at once; only the operations that change something are emitted. */
export function transformIntent(
  page: CreativePage,
  elementId: string,
  box: { x: number; y: number; width: number; height: number },
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el) return null;
  const operations: Operation[] = [];
  const move = moveIntent(page, elementId, box.x, box.y);
  const resize = resizeIntent(page, elementId, box.width, box.height);
  if (move) operations.push(...move.operations);
  if (resize) operations.push(...resize.operations);
  if (operations.length === 0) return null;
  return { operations, summary: resize ? `Resize ${el.name}` : `Move ${el.name}`, origin: 'user' };
}

/** The scene needs a format for safe areas; a page whose format key is unknown falls back to its own dimensions. */
export function formatForPage(page: CreativePage): FormatDefinition {
  return (
    formatFor(page.formatKey) ?? {
      key: page.formatKey,
      label: page.formatKey,
      width: page.width,
      height: page.height,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      providerKeys: [],
    }
  );
}

/** Scale that fits a page into a viewport, never enlarging beyond 1:1. */
export function fitScale(
  page: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / page.width, viewport.height / page.height);
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter. State lives OUTSIDE the stage: the app owns the committed document plus its pending batch and
// passes the document it wants shown through mount/applyRemote; the stage only renders and translates gestures.
// ---------------------------------------------------------------------------------------------------------------

export interface KonvaAdapterOptions {
  /** Spec 9.3: the app resolves signed URLs; the adapter never fetches. */
  resolveAssetUrl?: (assetVersionId: string) => string | null;
  /** The CSS family a document font ref was loaded under; null renders the fallback and reports missingFont. */
  fontFamilyFor?: (fontRef: string) => string | null;
  /** Brand colour token → #rrggbb (from the brand snapshot the document is designed against). */
  colourFor?: (token: string) => string | null;
  /** The page to show first; defaults to the first page. */
  pageId?: string;
}

export interface KonvaEditorHandle extends EditorHandle {
  /** Spec 11.1 page/format strip: switch the page the stage shows. */
  setPage(pageId: string): void;
  /** Re-fit the page into the container (after a layout change). */
  fit(): void;
  getSelection(): string[];
  getPageId(): string;
  onSelectionChange(cb: (elementIds: string[]) => void): Unsubscribe;
  /** Double-click on a text element: the app focuses the side text field (spec 21.3 keyboard path). */
  onEditText(cb: (elementId: string) => void): Unsubscribe;
}

export class KonvaEditorAdapter implements EditorAdapter {
  private readonly options: KonvaAdapterOptions;

  constructor(options: KonvaAdapterOptions = {}) {
    this.options = options;
  }

  mount(container: HTMLElement, doc: CreativeDocumentV1, opts: { readOnly: boolean }): KonvaEditorHandle {
    return new MountedStage(container, doc, opts.readOnly, this.options);
  }
}

class MountedStage implements KonvaEditorHandle {
  private doc: CreativeDocumentV1;
  private pageId: string;
  private readonly readOnly: boolean;
  private readonly container: HTMLElement;
  private readonly options: KonvaAdapterOptions;
  private readonly stage: Konva.Stage;
  private readonly layer: Konva.Layer;
  private readonly overlay: Konva.Layer;
  private readonly transformer: Konva.Transformer;
  private scene: SceneHandle | null = null;
  private selection: string[] = [];
  private readonly intentSubscribers = new Set<(batch: IntentBatch) => void>();
  private readonly selectionSubscribers = new Set<(ids: string[]) => void>();
  private readonly editTextSubscribers = new Set<(id: string) => void>();
  private destroyed = false;

  constructor(
    container: HTMLElement,
    doc: CreativeDocumentV1,
    readOnly: boolean,
    options: KonvaAdapterOptions,
  ) {
    this.container = container;
    this.doc = doc;
    this.readOnly = readOnly;
    this.options = options;
    this.pageId =
      options.pageId && doc.pages.some((p) => p.id === options.pageId)
        ? options.pageId
        : (doc.pages[0]?.id ?? '');
    this.stage = new Konva.Stage({
      container: container as HTMLDivElement,
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });
    this.layer = new Konva.Layer();
    this.overlay = new Konva.Layer();
    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      ignoreStroke: true,
      borderStrokeWidth: 1,
      anchorSize: 8,
    });
    this.overlay.add(this.transformer);
    this.stage.add(this.layer);
    this.stage.add(this.overlay);
    this.stage.on('click tap', (e) => {
      if (e.target === this.stage) this.setSelection([]);
    });
    this.rebuild();
  }

  private page(): CreativePage | undefined {
    return this.doc.pages.find((p) => p.id === this.pageId) ?? this.doc.pages[0];
  }

  private sceneContext(page: CreativePage): SceneContext {
    return {
      format: formatForPage(page),
      resolveAssetUrl: this.options.resolveAssetUrl ?? (() => null),
      fontFamilyFor: this.options.fontFamilyFor ?? (() => null),
      colourFor: this.options.colourFor ?? (() => null),
    };
  }

  private rebuild(): void {
    if (this.destroyed) return;
    this.transformer.nodes([]);
    this.scene?.destroy();
    this.scene = null;
    this.layer.destroyChildren();
    const page = this.page();
    if (!page) {
      this.layer.batchDraw();
      return;
    }
    const scene = buildScene(this.layer, page, this.sceneContext(page));
    this.scene = scene;
    for (const [id, node] of scene.nodes) this.wire(page, id, node);
    this.fit();
    this.applySelection();
    // Images arrive asynchronously; the scene asks for a draw once they are laid out.
    void scene.ready().then(() => {
      if (this.scene === scene && !this.destroyed) this.layer.batchDraw();
    });
  }

  private wire(page: CreativePage, id: string, node: Konva.Node): void {
    const el = findElement(page, id);
    if (!el) return;
    const interactive = isInteractive(el, this.readOnly);
    // The scene builds every node non-listening (the worker never needs hit graphs); the studio switches them on.
    const listening = el.visible && el.type !== 'background';
    node.listening(listening);
    if (node instanceof Konva.Container)
      for (const child of node.find(() => true)) child.listening(listening);
    node.draggable(interactive);
    node.on('click tap', (e) => {
      e.cancelBubble = true;
      this.setSelection(interactive ? [id] : []);
    });
    if (!interactive) return;
    node.on('dragstart', () => this.setSelection([id]));
    node.on('dragend', () => this.emit(moveIntent(this.currentPage(), id, node.x(), node.y())));
    node.on('transformend', () => {
      const box = {
        x: node.x(),
        y: node.y(),
        width: node.width() * node.scaleX(),
        height: node.height() * node.scaleY(),
      };
      node.scale({ x: 1, y: 1 });
      this.emit(transformIntent(this.currentPage(), id, box));
    });
    if (el.type === 'text')
      node.on('dblclick dbltap', () => {
        for (const cb of this.editTextSubscribers) cb(id);
      });
    node.on('mouseenter', () => this.stage.container().style.setProperty('cursor', 'move'));
    node.on('mouseleave', () => this.stage.container().style.removeProperty('cursor'));
  }

  private currentPage(): CreativePage {
    const page = this.page();
    if (!page) throw new Error('editor has no page');
    return page;
  }

  private emit(batch: IntentBatch | null): void {
    if (!batch) return;
    for (const cb of this.intentSubscribers) cb(batch);
  }

  private setSelection(ids: string[]): void {
    const same = ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i]);
    this.selection = ids;
    this.applySelection();
    if (!same) for (const cb of this.selectionSubscribers) cb([...ids]);
  }

  private applySelection(): void {
    const page = this.page();
    const nodes: Konva.Node[] = [];
    let keepRatio = false;
    if (page && this.scene)
      for (const id of this.selection) {
        const el = findElement(page, id);
        const node = this.scene.nodes.get(id);
        if (el && node && isInteractive(el, this.readOnly)) {
          nodes.push(node);
          if (el.type === 'logo') keepRatio = true;
        }
      }
    this.transformer.keepRatio(keepRatio);
    this.transformer.enabledAnchors(
      keepRatio
        ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
        : [
            'top-left',
            'top-center',
            'top-right',
            'middle-left',
            'middle-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
          ],
    );
    this.transformer.nodes(nodes);
    this.overlay.batchDraw();
  }

  onIntent(cb: (batch: IntentBatch) => void): Unsubscribe {
    this.intentSubscribers.add(cb);
    return () => this.intentSubscribers.delete(cb);
  }

  onSelectionChange(cb: (elementIds: string[]) => void): Unsubscribe {
    this.selectionSubscribers.add(cb);
    return () => this.selectionSubscribers.delete(cb);
  }

  onEditText(cb: (elementId: string) => void): Unsubscribe {
    this.editTextSubscribers.add(cb);
    return () => this.editTextSubscribers.delete(cb);
  }

  applyRemote(doc: CreativeDocumentV1): void {
    this.doc = doc;
    if (!doc.pages.some((p) => p.id === this.pageId)) this.pageId = doc.pages[0]?.id ?? '';
    this.rebuild();
  }

  select(elementIds: string[]): void {
    this.setSelection([...elementIds]);
  }

  getSelection(): string[] {
    return [...this.selection];
  }

  getPageId(): string {
    return this.pageId;
  }

  setPage(pageId: string): void {
    if (pageId === this.pageId || !this.doc.pages.some((p) => p.id === pageId)) return;
    this.pageId = pageId;
    this.selection = [];
    this.rebuild();
    for (const cb of this.selectionSubscribers) cb([]);
  }

  fit(): void {
    const page = this.page();
    if (!page || this.destroyed) return;
    const scale = fitScale(page, { width: this.container.clientWidth, height: this.container.clientHeight });
    this.stage.scale({ x: scale, y: scale });
    this.stage.size({
      width: Math.max(1, Math.round(page.width * scale)),
      height: Math.max(1, Math.round(page.height * scale)),
    });
    this.stage.batchDraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intentSubscribers.clear();
    this.selectionSubscribers.clear();
    this.editTextSubscribers.clear();
    this.scene?.destroy();
    this.scene = null;
    this.stage.destroy();
  }
}
