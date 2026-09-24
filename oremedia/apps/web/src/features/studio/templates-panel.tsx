import { useState } from 'react';
import type { CreativePage } from '@oremedia/contracts/creative';
import { applyBatch, type IntentBatch, type TemplateDocument } from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, Skeleton, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { Select } from '../../components/select';
import { RequestError } from '../../components/request-state';
import { useTemplates } from './use-document';
import { layerRows } from './document-helpers';
import type { TemplateDto } from './types';

export interface TemplatesPanelProps {
  brandId: string;
  page: CreativePage;
  readOnly: boolean;
  resolveTemplate: (templateId: string, templateVersionId: string) => Promise<TemplateDocument | null>;
  onIntent: (batch: IntentBatch) => void;
  templates: Record<string, TemplateDocument>;
}

/** Spec 11.3 applyTemplate: slot bindings map template slots to the page's existing elements. */
export function TemplatesPanel({
  brandId,
  page,
  readOnly,
  resolveTemplate,
  onIntent,
  templates,
}: TemplatesPanelProps) {
  const list = useTemplates(brandId);
  const [applying, setApplying] = useState<{ template: TemplateDto; doc: TemplateDocument } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const start = async (t: TemplateDto) => {
    if (!t.currentVersionId) return;
    setLoading(t.id);
    const doc = await resolveTemplate(t.id, t.currentVersionId);
    setLoading(null);
    if (doc) setApplying({ template: t, doc });
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      {list.isPending && <Skeleton label="Loading templates" lines={2} />}
      {list.isError && <RequestError error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          title="No templates"
          description="Approved template versions for this brand appear here."
        />
      )}
      {list.isSuccess &&
        list.data.items.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{t.name}</p>
              <Badge tone={t.state === 'active' ? 'good' : t.state === 'retired' ? 'neutral' : 'info'}>
                {t.state}
              </Badge>
            </div>
            <Button
              size="sm"
              disabled={readOnly || loading === t.id}
              disabledReason={
                t.state !== 'active' || !t.currentVersionId
                  ? 'Only templates with an approved version can be applied'
                  : undefined
              }
              onClick={() => void start(t)}
            >
              {loading === t.id ? 'Loading…' : 'Apply'}
            </Button>
          </div>
        ))}
      {applying && (
        <ApplyDialog
          page={page}
          template={applying.template}
          doc={applying.doc}
          templates={templates}
          onClose={() => setApplying(null)}
          onApply={(bindings) => {
            const versionId = applying.template.currentVersionId ?? '';
            onIntent({
              operations: [
                {
                  op: 'applyTemplate',
                  pageId: page.id,
                  templateVersionId: versionId,
                  slotBindings: bindings,
                },
              ],
              summary: `Apply template ${applying.template.name}`,
              origin: 'user',
            });
            setApplying(null);
          }}
        />
      )}
    </div>
  );
}

function ApplyDialog({
  page,
  template,
  doc,
  templates,
  onClose,
  onApply,
}: {
  page: CreativePage;
  template: TemplateDto;
  doc: TemplateDocument;
  templates: Record<string, TemplateDocument>;
  onClose: () => void;
  onApply: (bindings: Record<string, string>) => void;
}) {
  const rows = layerRows(page);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const missing = doc.slots.filter((s) => s.required && !bindings[s.key]);
  let previewError: string | null = null;
  try {
    applyBatch(
      { schemaVersion: 1, brandVersionId: 'preview', pages: [page], variants: [] },
      {
        operations: [
          {
            op: 'applyTemplate',
            pageId: page.id,
            templateVersionId: template.currentVersionId ?? '',
            slotBindings: bindings,
          },
        ],
      },
      { templates: { ...templates, [template.currentVersionId ?? '']: doc } },
    );
  } catch (err) {
    previewError = err instanceof Error ? err.message : String(err);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Apply ${template.name}`}
        description="Bind each template slot to an element on this page; bound elements keep their text or asset. Every other element on the page is replaced by the template's."
      >
        <div className="flex flex-col gap-3">
          {doc.slots.length === 0 && (
            <p className="text-sm text-muted-foreground">This template has no slots.</p>
          )}
          {doc.slots.map((slot) => (
            <Field
              key={slot.key}
              label={`${slot.key} (${slot.kind}${slot.required ? ', required' : ''})`}
              htmlFor={`slot-${slot.key}`}
            >
              <Select
                id={`slot-${slot.key}`}
                value={bindings[slot.key] ?? '__none'}
                onValueChange={(v) =>
                  setBindings((b) => {
                    const next = { ...b };
                    if (v === '__none') delete next[slot.key];
                    else next[slot.key] = v;
                    return next;
                  })
                }
                options={[
                  { value: '__none', label: 'Not bound' },
                  ...rows
                    .filter((r) =>
                      slot.kind === 'text'
                        ? r.element.type === 'text'
                        : slot.kind === 'image'
                          ? r.element.type === 'image' || r.element.type === 'logo'
                          : true,
                    )
                    .map((r) => ({ value: r.element.id, label: r.element.name })),
                ]}
              />
            </Field>
          ))}
          {previewError && missing.length === 0 && (
            <StatusBanner tone="critical" title="The template cannot be applied" description={previewError} />
          )}
        </div>
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={missing.length > 0 || previewError !== null}
            disabledReason={
              missing.length > 0
                ? `Bind the required slots: ${missing.map((m) => m.key).join(', ')}`
                : undefined
            }
            onClick={() => onApply(bindings)}
          >
            Apply template
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
