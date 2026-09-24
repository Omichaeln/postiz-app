import { useState } from 'react';
import type { CreativePage, Element } from '@oremedia/contracts/creative';
import { findElement, type IntentBatch } from '@oremedia/editor';
import { Badge, EmptyState, Input, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { AssetThumb } from '../assets/asset-thumb';
import { useAssetSearch, type AssetRefDto } from '../assets/use-assets';
import { newElementId } from '../../lib/ids';

export interface AssetsPanelProps {
  brandId: string;
  page: CreativePage;
  selection: string[];
  readOnly: boolean;
  onIntent: (batch: IntentBatch) => void;
}

/** A new image element: 40% of the page width, centred, aspect from the asset when known. */
export function imageElementFor(page: CreativePage, asset: AssetRefDto): Element {
  const width = Math.round(page.width * 0.4);
  const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
  const height = Math.max(1, Math.round(width / ratio));
  return {
    id: newElementId(),
    name: asset.altText ?? asset.kind,
    type: asset.kind === 'logo' ? 'logo' : 'image',
    locked: false,
    visible: true,
    opacity: 1,
    protected: asset.kind === 'logo',
    ...(asset.kind === 'logo' ? { semanticRole: 'logo' as const } : {}),
    transform: {
      x: Math.round((page.width - width) / 2),
      y: Math.round((page.height - height) / 2),
      width,
      height,
      rotation: 0,
    },
    ...(asset.kind === 'logo'
      ? { assetVersionId: asset.assetVersionId, variant: 'primary' as const }
      : { assetVersionId: asset.assetVersionId, fit: 'cover' as const }),
  } as Element;
}

/** Spec 9.2/11.4: only eligible assets are offered; the server authorises every referenced version again. */
export function AssetsPanel({ brandId, page, selection, readOnly, onIntent }: AssetsPanelProps) {
  const [query, setQuery] = useState('');
  const search = useAssetSearch(brandId, 'creative', query);
  const selected = selection[0] ? findElement(page, selection[0]) : null;
  const replaceable =
    selected &&
    (selected.type === 'image' || selected.type === 'logo' || selected.type === 'background') &&
    !selected.locked;

  const use = (asset: AssetRefDto) => {
    if (readOnly) return;
    if (replaceable && selected)
      onIntent({
        operations: [
          {
            op: 'replaceAsset',
            pageId: page.id,
            elementId: selected.id,
            assetVersionId: asset.assetVersionId,
          },
        ],
        summary: `Replace asset of ${selected.name}`,
        origin: 'user',
      });
    else {
      const element = imageElementFor(page, asset);
      onIntent({
        operations: [{ op: 'insertElement', pageId: page.id, element }],
        summary: `Insert ${element.name}`,
        origin: 'user',
      });
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <Input
        aria-label="Search eligible assets"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8"
      />
      <p className="text-xs text-muted-foreground">
        {replaceable
          ? `Choosing an asset replaces the asset of ${selected.name}.`
          : 'Choosing an asset inserts it as a new layer.'}
      </p>
      {search.isPending && <Skeleton label="Loading assets" lines={2} />}
      {search.isError && <RequestError error={search.error} onRetry={() => void search.refetch()} />}
      {search.isSuccess && search.data.items.length === 0 && (
        <EmptyState
          title="No eligible assets"
          description="Approved assets with usage rights for creative use appear here."
        />
      )}
      {search.isSuccess && search.data.items.length > 0 && (
        <ul className="grid grid-cols-3 gap-1" aria-label="Eligible assets">
          {search.data.items.map((a) => (
            <li key={a.assetVersionId}>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => use(a)}
                aria-label={`${replaceable ? 'Use' : 'Insert'} ${a.altText ?? a.kind}`}
                className="flex w-full flex-col gap-0.5 rounded-md border border-border p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <AssetThumb
                  assetVersionId={a.assetVersionId}
                  alt={a.altText ?? a.kind}
                  className="aspect-square w-full rounded-sm"
                />
                <Badge glyph={false} className="self-start">
                  {a.kind}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
