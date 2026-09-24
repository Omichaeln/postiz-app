import { useParams } from 'react-router';
import { Skeleton } from '@oremedia/ui';
import { RequestError } from '../../../../../../../components/request-state';
import { Studio } from '../../../../../../../features/studio/studio';
import { useDocument } from '../../../../../../../features/studio/use-document';

/** `studio/$doc`: loads the document (save/reopen) and hands the committed revision to the studio. */
export function StudioRoute() {
  const { doc = '' } = useParams();
  const document = useDocument(doc);
  if (document.isPending)
    return (
      <main id="main" className="p-6">
        <Skeleton label="Loading document" lines={4} />
      </main>
    );
  if (document.isError)
    return (
      <main id="main" className="p-6">
        <RequestError error={document.error} onRetry={() => void document.refetch()} />
      </main>
    );
  // Keyed by document so navigating between documents resets the local studio state.
  return <Studio key={doc} documentId={doc} initial={document.data} />;
}
