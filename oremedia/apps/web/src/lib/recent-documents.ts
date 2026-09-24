/**
 * The creative router has no documents.list procedure in Phase 3 (documents are reached from campaigns in Phase 4),
 * so the brand home offers the documents opened on THIS device as a convenience. It is a per-browser list, never
 * presented as the brand's document library.
 */
const KEY = 'oremedia.recent_documents';
const MAX = 12;

export interface RecentDocument {
  companyId: string;
  brandId: string;
  documentId: string;
  title: string;
  openedAt: string;
}

export function readRecentDocuments(companyId: string, brandId: string): RecentDocument[] {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as RecentDocument[]) : [];
    return all.filter((d) => d.companyId === companyId && d.brandId === brandId);
  } catch {
    return [];
  }
}

export function rememberDocument(doc: Omit<RecentDocument, 'openedAt'>): void {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as RecentDocument[]) : [];
    const next = [
      { ...doc, openedAt: new Date().toISOString() },
      ...all.filter((d) => d.documentId !== doc.documentId),
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage blocked: nothing to remember
  }
}
