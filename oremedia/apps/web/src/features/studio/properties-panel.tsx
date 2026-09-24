import { useEffect, useRef, useState } from 'react';
import type { CreativePage, Element } from '@oremedia/contracts/creative';
import { findElement, type IntentBatch } from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, Input, Textarea } from '@oremedia/ui';
import { Select } from '../../components/select';
import { elementTypeLabel } from './document-helpers';

export interface PropertiesPanelProps {
  page: CreativePage;
  elementId: string | null;
  readOnly: boolean;
  colourTokens: Array<{ key: string; value: string }>;
  onIntent: (batch: IntentBatch) => void;
  /** Set to focus the text field (double-click on the canvas, Enter in the layers panel). */
  focusTextRequest: number;
}

/** A numeric field that commits on blur or Enter (arrow keys change the value by 1, Shift by 10). */
function NumberField({
  id,
  label,
  value,
  min,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={1}
        min={min}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
            e.preventDefault();
            const n = Number(draft) + (e.key === 'ArrowUp' ? 10 : -10);
            setDraft(String(n));
            if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n);
          }
        }}
      />
    </Field>
  );
}

/** Spec 21.3: numeric position/size fields and text editing in a side field; every property is labelled. */
export function PropertiesPanel({
  page,
  elementId,
  readOnly,
  colourTokens,
  onIntent,
  focusTextRequest,
}: PropertiesPanelProps) {
  const el = elementId ? findElement(page, elementId) : null;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusTextRequest > 0) (textRef.current ?? headingRef.current)?.focus();
  }, [focusTextRequest, elementId]);

  if (!el)
    return (
      <EmptyState
        title="Nothing selected"
        description="Select an element on the canvas or in the layers panel to edit its position, size, text and style."
      />
    );

  const locked = el.locked || readOnly;
  const one = (op: IntentBatch['operations'][number], summary: string) =>
    onIntent({ operations: [op], summary, origin: 'user' });
  const style = (patch: Record<string, unknown>, summary: string) =>
    one({ op: 'setStyle', pageId: page.id, elementId: el.id, patch }, summary);
  const t = el.transform;
  const topIndex = page.elements.findIndex((e) => e.id === el.id); // z-order = array order (spec 11.2)

  return (
    <div className="flex flex-col gap-3" aria-live="polite" data-testid="properties">
      <div
        ref={headingRef}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium">{el.name}</span>
        <Badge glyph={false}>{elementTypeLabel[el.type]}</Badge>
        {el.protected && <Badge tone="info">Protected from agents</Badge>}
        {el.locked && <Badge tone="neutral">Locked</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          id="prop-x"
          label="X"
          value={t.x}
          disabled={locked}
          onCommit={(x) =>
            one({ op: 'moveElement', pageId: page.id, elementId: el.id, x, y: t.y }, `Move ${el.name}`)
          }
        />
        <NumberField
          id="prop-y"
          label="Y"
          value={t.y}
          disabled={locked}
          onCommit={(y) =>
            one({ op: 'moveElement', pageId: page.id, elementId: el.id, x: t.x, y }, `Move ${el.name}`)
          }
        />
        <NumberField
          id="prop-w"
          label="Width"
          value={t.width}
          min={1}
          disabled={locked}
          onCommit={(width) =>
            one(
              {
                op: 'resizeElement',
                pageId: page.id,
                elementId: el.id,
                width,
                height:
                  el.type === 'logo'
                    ? Math.max(1, Math.round((width / (t.width / t.height)) * 100) / 100)
                    : t.height,
              },
              `Resize ${el.name}`,
            )
          }
        />
        <NumberField
          id="prop-h"
          label="Height"
          value={t.height}
          min={1}
          disabled={locked || el.type === 'logo'}
          onCommit={(height) =>
            one(
              { op: 'resizeElement', pageId: page.id, elementId: el.id, width: t.width, height },
              `Resize ${el.name}`,
            )
          }
        />
      </div>
      {el.type === 'logo' && (
        <p className="text-xs text-muted-foreground">Logos keep their aspect ratio; change the width.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Rotation {t.rotation}° (set by the template; no rotate operation in this release)
      </p>

      {el.type === 'text' && (
        <>
          <Field
            label="Text"
            htmlFor="prop-text"
            hint="Edits show on the canvas immediately and save after a short pause."
          >
            <Textarea
              ref={textRef}
              id="prop-text"
              value={el.text}
              disabled={locked}
              maxLength={5000}
              rows={3}
              onChange={(e) =>
                one(
                  { op: 'setText', pageId: page.id, elementId: el.id, text: e.target.value },
                  `Edit ${el.name}`,
                )
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              id="prop-size"
              label="Size (px)"
              value={el.style.sizePx}
              min={1}
              disabled={locked}
              onCommit={(sizePx) => style({ sizePx }, `Resize text ${el.name}`)}
            />
            <NumberField
              id="prop-weight"
              label="Weight"
              value={el.style.weight}
              min={100}
              disabled={locked}
              onCommit={(weight) => style({ weight }, `Restyle ${el.name}`)}
            />
            <NumberField
              id="prop-lh"
              label="Line height"
              value={el.style.lineHeight}
              min={0.5}
              disabled={locked}
              onCommit={(lineHeight) => style({ lineHeight }, `Restyle ${el.name}`)}
            />
            <Field label="Align" htmlFor="prop-align">
              <Select
                id="prop-align"
                value={el.style.align}
                disabled={locked}
                onValueChange={(align) => style({ align }, `Align ${el.name}`)}
                options={['left', 'center', 'right', 'justify'].map((v) => ({ value: v, label: v }))}
              />
            </Field>
            <Field label="Colour token" htmlFor="prop-colour" className="col-span-2">
              <Select
                id="prop-colour"
                value={el.style.colourToken ?? '__none'}
                disabled={locked}
                onValueChange={(v) =>
                  style({ colourToken: v === '__none' ? undefined : v }, `Recolour ${el.name}`)
                }
                options={[
                  { value: '__none', label: el.style.colourValue ? `raw ${el.style.colourValue}` : 'none' },
                  ...colourTokens.map((c) => ({ value: c.key, label: `${c.key} (${c.value})` })),
                ]}
              />
            </Field>
            <Field label="Overflow" htmlFor="prop-overflow" className="col-span-2">
              <Select
                id="prop-overflow"
                value={el.style.overflow}
                disabled={locked}
                onValueChange={(overflow) => style({ overflow }, `Restyle ${el.name}`)}
                options={[
                  { value: 'error', label: 'Report overflow (error)' },
                  { value: 'shrink_to_fit', label: 'Shrink to fit' },
                  { value: 'clip', label: 'Clip' },
                ]}
              />
            </Field>
          </div>
        </>
      )}
      {el.type === 'image' && (
        <Field label="Fit" htmlFor="prop-fit">
          <Select
            id="prop-fit"
            value={el.fit}
            disabled={locked}
            onValueChange={(fit) => style({ fit }, `Refit ${el.name}`)}
            options={['cover', 'contain', 'fill'].map((v) => ({ value: v, label: v }))}
          />
        </Field>
      )}
      {(el.type === 'shape' || el.type === 'background') && (
        <Field label="Fill token" htmlFor="prop-fill">
          <Select
            id="prop-fill"
            value={el.fillToken ?? '__none'}
            disabled={locked}
            onValueChange={(v) => style({ fillToken: v === '__none' ? undefined : v }, `Recolour ${el.name}`)}
            options={[
              { value: '__none', label: 'none' },
              ...colourTokens.map((c) => ({ value: c.key, label: `${c.key} (${c.value})` })),
            ]}
          />
        </Field>
      )}
      {el.type !== 'text' && (
        <NumberField
          id="prop-opacity"
          label="Opacity (0–1)"
          value={el.opacity}
          min={0}
          disabled={locked}
          onCommit={(opacity) => style({ opacity: Math.min(1, opacity) }, `Fade ${el.name}`)}
        />
      )}
      {el.type === 'logo' && (
        <p className="text-xs text-muted-foreground">
          Variant {el.variant}. Logos are placed from approved assets; replace the asset from the assets tab.
        </p>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {topIndex >= 0 && (
            <>
              <Button
                size="sm"
                disabled={topIndex >= page.elements.length - 1}
                onClick={() =>
                  one(
                    { op: 'reorderElement', pageId: page.id, elementId: el.id, toIndex: topIndex + 1 },
                    `Bring ${el.name} forward`,
                  )
                }
              >
                Bring forward
              </Button>
              <Button
                size="sm"
                disabled={topIndex <= 0}
                onClick={() =>
                  one(
                    { op: 'reorderElement', pageId: page.id, elementId: el.id, toIndex: topIndex - 1 },
                    `Send ${el.name} backward`,
                  )
                }
              >
                Send backward
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() =>
              one(
                { op: 'setLock', pageId: page.id, elementId: el.id, locked: !el.locked },
                `${el.locked ? 'Unlock' : 'Lock'} ${el.name}`,
              )
            }
          >
            {el.locked ? 'Unlock' : 'Lock'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={el.locked}
            onClick={() =>
              one({ op: 'removeElement', pageId: page.id, elementId: el.id }, `Remove ${el.name}`)
            }
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

export const isTextElement = (el: Element | null): boolean => el?.type === 'text';
