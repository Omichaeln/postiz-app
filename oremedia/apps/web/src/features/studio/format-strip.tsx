import { useState } from 'react';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { FORMAT_DEFINITIONS, type IntentBatch } from '@oremedia/editor';
import { Button, cn } from '@oremedia/ui';
import { Select } from '../../components/select';

export interface FormatStripProps {
  doc: CreativeDocumentV1;
  pageId: string;
  readOnly: boolean;
  onSelectPage: (id: string) => void;
  onIntent: (batch: IntentBatch) => void;
}

/** Spec 11.1 page and format strip; spec 11.3 createFormatVariant reflows via constraints (never scales blindly). */
export function FormatStrip({ doc, pageId, readOnly, onSelectPage, onIntent }: FormatStripProps) {
  const [formatKey, setFormatKey] = useState('ig_story_9x16');
  const formats = Object.values(FORMAT_DEFINITIONS);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = doc.pages.findIndex((p) => p.id === pageId);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = doc.pages[(i + (e.key === 'ArrowRight' ? 1 : doc.pages.length - 1)) % doc.pages.length];
      if (next) onSelectPage(next.id);
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
      <div
        role="tablist"
        aria-label="Pages and formats"
        className="flex flex-wrap gap-1"
        onKeyDown={onKeyDown}
        data-testid="format-strip"
      >
        {doc.pages.map((p) => {
          const active = p.id === pageId;
          return (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelectPage(p.id)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-accent bg-secondary font-medium'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {p.name}
              <span className="ml-1 text-muted-foreground">
                {p.width}×{p.height}
              </span>
            </button>
          );
        })}
      </div>
      {!readOnly && (
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="variant-format" className="text-xs text-muted-foreground">
            Add format variant
          </label>
          <Select
            id="variant-format"
            size="sm"
            value={formatKey}
            onValueChange={setFormatKey}
            className="w-52"
            options={formats.map((f) => ({ value: f.key, label: `${f.label} (${f.width}×${f.height})` }))}
          />
          <Button
            size="sm"
            disabled={doc.pages.length >= 20}
            onClick={() =>
              onIntent({
                operations: [{ op: 'createFormatVariant', sourcePageId: pageId, formatKey }],
                summary: `Create ${FORMAT_DEFINITIONS[formatKey]?.label ?? formatKey} variant`,
                origin: 'user',
              })
            }
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
