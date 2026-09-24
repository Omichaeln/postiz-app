import { useSignedUrl } from './use-assets';

/** One asset thumbnail with its own signed-URL query (one hook per query, spec 21.1). */
export function AssetThumb({
  assetVersionId,
  alt,
  className,
}: {
  assetVersionId: string;
  alt: string;
  className?: string;
}) {
  const url = useSignedUrl(assetVersionId, 'thumbnail');
  if (url.isError || (url.isSuccess && !url.data.url))
    return (
      <div
        role="img"
        aria-label={`${alt} (preview unavailable)`}
        className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ''}`}
      >
        No preview
      </div>
    );
  if (!url.data) return <div aria-hidden="true" className={`animate-pulse bg-muted ${className ?? ''}`} />;
  return <img src={url.data.url} alt={alt} className={`object-cover ${className ?? ''}`} loading="lazy" />;
}
