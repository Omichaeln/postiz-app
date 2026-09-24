import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AssetKind, AssetPurpose, type AssetPurpose as AssetPurposeT } from '@oremedia/contracts/assets';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  StatusBanner,
  type Tone,
} from '@oremedia/ui';
import { PageHeading, RequestError } from '../../../../../../components/request-state';
import { Select } from '../../../../../../components/select';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { AssetThumb } from '../../../../../../features/assets/asset-thumb';
import { useAsset, useAssetSearch, type AssetDto } from '../../../../../../features/assets/use-assets';
import { useTRPCClient } from '../../../../../../lib/trpc';
import { newIntentKey, intentContext } from '../../../../../../lib/intent-key';
import { toUiError } from '../../../../../../lib/errors';

/** Spec 21.2 asset library states: processing; restricted; expired rights; missing rights; duplicate; retired. */
export function AssetLibraryRoute() {
  const { brandId } = useBrandContext();
  const [purpose, setPurpose] = useState<AssetPurposeT>('creative');
  const [text, setText] = useState('');
  const [inspectId, setInspectId] = useState<string | null>(null);
  const search = useAssetSearch(brandId, purpose, text);

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <PageHeading
        title="Asset library"
        description="Only assets eligible for the chosen purpose appear in search (approved, rights recorded and in date, kind compatible). Everything else is reachable by id below with the reason it is not eligible."
      />
      <Panel
        title="Eligible assets"
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs">
              <span>Purpose</span>
              <Select
                size="sm"
                value={purpose}
                onValueChange={(v) => setPurpose(AssetPurpose.parse(v))}
                aria-label="Eligibility purpose"
                options={AssetPurpose.options.map((p) => ({ value: p, label: p }))}
              />
            </label>
            <Input
              aria-label="Search assets"
              placeholder="Search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-8 w-40"
            />
          </div>
        }
      >
        {search.isPending && <Skeleton label="Loading assets" lines={3} />}
        {search.isError && (
          <RequestError
            error={search.error}
            onRetry={() => void search.refetch()}
            title="Restricted access"
          />
        )}
        {search.isSuccess && search.data.items.length === 0 && (
          <EmptyState
            title="No eligible assets"
            description={`Nothing approved with rights permitting ${purpose} use. Upload assets below or record their usage rights.`}
          />
        )}
        {search.isSuccess && search.data.items.length > 0 && (
          <ul
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
            aria-label="Eligible assets"
          >
            {search.data.items.map((a) => (
              <li key={a.assetVersionId}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-1 rounded-md border border-border p-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setInspectId(a.assetId)}
                  aria-label={`Inspect ${a.altText ?? a.kind} ${a.assetId}`}
                >
                  <AssetThumb
                    assetVersionId={a.assetVersionId}
                    alt={a.altText ?? a.kind}
                    className="aspect-square w-full rounded-sm"
                  />
                  <span className="flex flex-wrap gap-1 text-xs">
                    <Badge glyph={false}>{a.kind}</Badge>
                    {a.width && a.height && (
                      <span className="text-muted-foreground">
                        {a.width}×{a.height}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className="grid gap-6 md:grid-cols-2">
        <Inspect assetId={inspectId} onChange={setInspectId} />
        <Upload />
      </div>
    </main>
  );
}

interface AssetStatus {
  tone: Tone;
  label: string;
  detail: string;
}

/** Every non-eligible condition named explicitly, with the reason; colour is never the only carrier. */
export function assetStatuses(a: AssetDto, now = Date.now()): AssetStatus[] {
  const out: AssetStatus[] = [];
  if (a.state === 'pending_review')
    out.push({ tone: 'info', label: 'Processing', detail: 'Ingested and awaiting review; not usable yet.' });
  if (a.state === 'rejected')
    out.push({ tone: 'critical', label: 'Rejected', detail: 'Rejected at review.' });
  if (a.state === 'retired')
    out.push({
      tone: 'neutral',
      label: 'Retired',
      detail: 'No longer usable in new work; existing usages are recorded.',
    });
  if (a.state === 'approved') out.push({ tone: 'good', label: 'Approved', detail: 'Reviewed and approved.' });
  if (a.rightsState === 'unknown' || !a.rights)
    out.push({
      tone: 'warning',
      label: 'Missing rights',
      detail: 'No usage rights recorded; ineligible for creative and logo use until they are.',
    });
  else if (a.rights.expiresAt && new Date(a.rights.expiresAt).getTime() < now)
    out.push({
      tone: 'critical',
      label: 'Expired rights',
      detail: `Rights expired on ${new Date(a.rights.expiresAt).toLocaleDateString()}.`,
    });
  else
    out.push({
      tone: 'good',
      label: 'Rights recorded',
      detail: a.rights.expiresAt
        ? `Valid until ${new Date(a.rights.expiresAt).toLocaleDateString()}.`
        : 'No expiry.',
    });
  if (!a.currentVersion)
    out.push({ tone: 'warning', label: 'No version', detail: 'The file has not been ingested.' });
  return out;
}

function Inspect({ assetId, onChange }: { assetId: string | null; onChange: (id: string | null) => void }) {
  const [draft, setDraft] = useState('');
  const asset = useAsset(assetId);
  return (
    <Panel title="Inspect an asset">
      <form
        className="mb-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onChange(draft.trim() || null);
        }}
      >
        <Field label="Asset id" htmlFor="asset-id" className="flex-1" hint="ast_…">
          <Input id="asset-id" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </Field>
        <Button type="submit">Inspect</Button>
      </form>
      {assetId === null && (
        <EmptyState
          title="Nothing selected"
          description="Pick an asset from the grid or enter an id to see its state, rights and versions."
        />
      )}
      {assetId !== null && asset.isPending && <Skeleton label="Loading asset" />}
      {assetId !== null && asset.isError && (
        <RequestError
          error={asset.error}
          onRetry={() => void asset.refetch()}
          title={
            toUiError(asset.error).kind === 'forbidden'
              ? 'Restricted: this asset is not in a brand you can see'
              : undefined
          }
        />
      )}
      {asset.isSuccess && (
        <div className="flex flex-col gap-3 text-sm" aria-live="polite">
          <div className="flex items-center gap-3">
            {asset.data.currentVersion && (
              <AssetThumb
                assetVersionId={asset.data.currentVersion.id}
                alt={asset.data.name}
                className="h-20 w-20 rounded-md"
              />
            )}
            <div>
              <p className="font-medium">{asset.data.name}</p>
              <p className="text-muted-foreground">
                {asset.data.kind}
                {asset.data.semanticRole ? ` · ${asset.data.semanticRole}` : ''}
              </p>
            </div>
          </div>
          <ul className="flex flex-col gap-1">
            {assetStatuses(asset.data).map((s) => (
              <li key={s.label} className="flex items-start gap-2">
                <Badge tone={s.tone}>{s.label}</Badge>
                <span className="text-muted-foreground">{s.detail}</span>
              </li>
            ))}
          </ul>
          {asset.data.currentVersion && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{asset.data.currentVersion.number}</dd>
              <dt className="text-muted-foreground">Hash</dt>
              <dd>
                <code>{asset.data.currentVersion.contentHash.slice(0, 16)}…</code>
              </dd>
              <dt className="text-muted-foreground">Provenance</dt>
              <dd>{asset.data.currentVersion.provenance.kind}</dd>
            </dl>
          )}
        </div>
      )}
    </Panel>
  );
}

type UploadStep =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string }
  | { kind: 'queued'; intentId: string }
  | { kind: 'failed'; message: string; details: string[] };

/** Spec 9.1: intent → PUT to the signed URL → complete; processing continues in the ingest workflow. */
function Upload() {
  const { brandId } = useBrandContext();
  const client = useTRPCClient();
  const [kind, setKind] = useState<string>('photo');
  const [step, setStep] = useState<UploadStep>({ kind: 'idle' });
  const start = useMutation({
    mutationFn: async (file: File) => {
      const intent = await client.assets.uploads.createIntent.mutate(
        {
          brandId,
          kind: AssetKind.parse(kind),
          declaredMime: file.type,
          declaredBytes: file.size,
          originalFilename: file.name,
        },
        intentContext(newIntentKey()),
      );
      const put = await fetch(intent.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type },
      });
      if (!put.ok) throw new Error(`Upload failed with HTTP ${put.status}`);
      return client.assets.uploads.complete.mutate(
        { intentId: intent.intentId },
        intentContext(newIntentKey()),
      );
    },
    onMutate: (file) => setStep({ kind: 'uploading', name: file.name }),
    onSuccess: (res) => setStep({ kind: 'queued', intentId: res.intentId }),
    onError: (err) => {
      const ui = toUiError(err);
      setStep({
        kind: 'failed',
        message: ui.message,
        details: ui.details.map((d) => `${d.path ?? ''} ${d.issue}`.trim()),
      });
    },
  });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) start.mutate(file);
    e.target.value = '';
  };
  return (
    <Panel title="Upload">
      <div className="flex flex-col gap-3">
        <Field label="Kind" htmlFor="upload-kind">
          <Select
            id="upload-kind"
            value={kind}
            onValueChange={setKind}
            options={AssetKind.options.map((k) => ({ value: k, label: k }))}
          />
        </Field>
        <Field
          label="File"
          htmlFor="upload-file"
          hint="Images, SVG, fonts and PDF; archives are rejected. Video and audio processing arrives in Release 2."
        >
          <input
            id="upload-file"
            type="file"
            onChange={onFile}
            disabled={start.isPending}
            className="text-sm"
          />
        </Field>
        {step.kind === 'uploading' && <StatusBanner tone="info" busy title={`Uploading ${step.name}`} />}
        {step.kind === 'queued' && (
          <StatusBanner
            tone="info"
            title="Processing"
            description={`Upload accepted (intent ${step.intentId}). Scanning, sanitising, hashing and derivatives run in the ingest workflow; a duplicate of an existing asset is rejected with the existing asset id.`}
          />
        )}
        {step.kind === 'failed' && (
          <StatusBanner
            tone="critical"
            title="Upload not accepted"
            description={
              <>
                {step.message}
                {step.details.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {step.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </>
            }
          />
        )}
      </div>
    </Panel>
  );
}
