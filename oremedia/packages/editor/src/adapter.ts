import type { CreativeDocumentV1, OperationBatch } from '@oremedia/contracts/creative';

/** Spec 11.6: the document model is not coupled to a canvas library. */
export type Unsubscribe = () => void;

export interface EditorAdapter {
  mount(container: HTMLElement, doc: CreativeDocumentV1, opts: { readOnly: boolean }): EditorHandle;
}

export interface EditorHandle {
  /** UI gestures become operations; the application decides when to send them (debounce or explicit save). */
  onIntent(cb: (batch: Omit<OperationBatch, 'baseRevisionId'>) => void): Unsubscribe;
  /** After a server commit (or rebase) the canvas is re-rendered from the committed document. */
  applyRemote(doc: CreativeDocumentV1): void;
  select(elementIds: string[]): void;
  destroy(): void;
}
