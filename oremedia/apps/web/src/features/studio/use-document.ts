import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../lib/trpc';

/** One hook per query (spec 21.1). */
export function useDocument(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.documents.get.queryOptions({ documentId }));
}

export function useRevisions(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.revisions.list.queryOptions({ documentId, page: { limit: 50 } }));
}

export function useComments(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.comments.list.queryOptions({ documentId, page: { limit: 100 } }));
}

export function useTemplates(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.templates.list.queryOptions({ brandId, page: { limit: 50 } }));
}

export function useTemplate(templateId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.templates.get.queryOptions({ templateId: templateId ?? '' }),
    enabled: templateId !== null,
  });
}

/** Polls a render job until it is ready or failed (the worker moves it; the client only watches). */
export function useRenderJob(renderJobId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.renders.get.queryOptions({ renderJobId: renderJobId ?? '' }),
    enabled: renderJobId !== null,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === 'ready' || state === 'failed' ? false : 2000;
    },
  });
}
