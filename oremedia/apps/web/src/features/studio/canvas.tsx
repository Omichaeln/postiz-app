import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import {
  KonvaEditorAdapter,
  fitScale,
  nudgeIntent,
  type IntentBatch,
  type KonvaEditorHandle,
} from '@oremedia/editor';
import { cn } from '@oremedia/ui';
import type { ElementDiff } from './diff';

export interface CanvasProps {
  doc: CreativeDocumentV1;
  page: CreativePage;
  selection: string[];
  readOnly: boolean;
  onSelect: (ids: string[]) => void;
  onIntent: (batch: IntentBatch) => void;
  onEditText: (elementId: string) => void;
  onDeleteSelected: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  resolveAssetUrl: (assetVersionId: string) => string | null;
  fontFamilyFor: (ref: string) => string | null;
  colourFor: (token: string) => string | null;
  /** Changes when a resolver's answers change so the scene rebuilds (URLs arrive, fonts load, colours resolve). */
  resolverVersion: string;
  overlay: ElementDiff[] | null;
}

const OVERLAY_TONE: Record<ElementDiff['kind'], { className: string; label: string; dash: string }> = {
  added: { className: 'stroke-status-good', label: 'Added', dash: '0' },
  changed: { className: 'stroke-status-warning', label: 'Changed', dash: '6 3' },
  removed: { className: 'stroke-status-critical', label: 'Removed', dash: '2 3' },
};

/**
 * The Konva mount. State lives outside the stage (spec 11.6): the adapter draws `doc` and emits intents; every
 * canvas action also has a keyboard path here (spec 21.3): arrows nudge, Delete removes, Escape clears, Ctrl+Z/Y.
 */
export function Canvas(props: CanvasProps) {
  const {
    doc,
    page,
    selection,
    readOnly,
    onSelect,
    onIntent,
    onEditText,
    onDeleteSelected,
    onUndo,
    onRedo,
    onSave,
    resolveAssetUrl,
    fontFamilyFor,
    colourFor,
    resolverVersion,
    overlay,
  } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<KonvaEditorHandle | null>(null);
  const [scale, setScale] = useState(1);
  const latest = useRef({
    doc,
    page,
    onSelect,
    onIntent,
    onEditText,
    resolveAssetUrl,
    fontFamilyFor,
    colourFor,
  });
  latest.current = { doc, page, onSelect, onIntent, onEditText, resolveAssetUrl, fontFamilyFor, colourFor };

  // Mount once per document; callbacks and resolvers are read through the ref so their identity never remounts.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const adapter = new KonvaEditorAdapter({
      resolveAssetUrl: (id) => latest.current.resolveAssetUrl(id),
      fontFamilyFor: (ref) => latest.current.fontFamilyFor(ref),
      colourFor: (token) => latest.current.colourFor(token),
      pageId: latest.current.page.id,
    });
    const handle = adapter.mount(container, latest.current.doc, { readOnly });
    handleRef.current = handle;
    const offSelect = handle.onSelectionChange((ids) => latest.current.onSelect(ids));
    const offIntent = handle.onIntent((batch) => latest.current.onIntent(batch));
    const offEdit = handle.onEditText((id) => latest.current.onEditText(id));
    return () => {
      offSelect();
      offIntent();
      offEdit();
      handle.destroy();
      handleRef.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    handleRef.current?.applyRemote(doc);
  }, [doc, resolverVersion]);

  useEffect(() => {
    handleRef.current?.setPage(page.id);
  }, [page.id]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const current = handle.getSelection();
    if (current.length !== selection.length || current.some((id, i) => id !== selection[i]))
      handle.select(selection);
  }, [selection]);

  // Fit on resize; the overlay uses the same fitScale as the adapter so it lines up with the stage.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => {
      handleRef.current?.fit();
      setScale(fitScale(page, { width: wrapper.clientWidth, height: wrapper.clientHeight }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [page]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      onRedo();
      return;
    }
    if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === 'Escape') {
      onSelect([]);
      return;
    }
    if (readOnly) return;
    const selected = selection[0];
    if (!selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDeleteSelected();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onEditText(selected);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const intent = nudgeIntent(page, selected, d[0], d[1]);
    if (intent) onIntent(intent);
  };

  const w = Math.round(page.width * scale);
  const h = Math.round(page.height * scale);
  const overlayItems = overlay?.filter((d) => d.pageId === page.id) ?? [];

  return (
    <div
      ref={wrapperRef}
      role="application"
      tabIndex={0}
      aria-label={`Canvas: ${page.name}, ${page.width} by ${page.height} pixels. Select elements in the layers panel; arrow keys nudge the selected element by one pixel, ten with Shift; Enter edits text in the properties panel; Delete removes.`}
      aria-describedby="canvas-help"
      onKeyDown={onKeyDown}
      data-testid="canvas"
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-border bg-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <p id="canvas-help" className="sr-only">
        Every canvas action is also available from the layers and properties panels.
      </p>
      <div ref={containerRef} className="absolute inset-0 flex items-center justify-center" />
      {overlayItems.length > 0 && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          width={w}
          height={h}
          viewBox={`0 0 ${page.width} ${page.height}`}
          data-testid="proposal-overlay"
        >
          {overlayItems.map((d) => {
            const t = d.element.transform;
            const tone = OVERLAY_TONE[d.kind];
            return (
              <g key={`${d.kind}-${d.element.id}`} className={tone.className}>
                <rect
                  x={t.x}
                  y={t.y}
                  width={t.width}
                  height={t.height}
                  fill="none"
                  strokeWidth={4 / scale}
                  strokeDasharray={tone.dash}
                />
                <text
                  x={t.x + 6 / scale}
                  y={Math.max(t.y - 8 / scale, 16 / scale)}
                  fontSize={14 / scale}
                  className="fill-foreground"
                  stroke="none"
                >
                  {tone.label}: {d.element.name}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
