// Creative studio (spec 11): documents, revisions, the operation engine, renders, comments and templates.
export {
  creativeService,
  registerAssetAuthoriser,
  resetAssetAuthoriser,
  registerRevisionChangeHook,
  type ActorOptions,
  type AssetAuthoriser,
  type AssetRef,
  type CreativeAssetPurpose,
  type RevisionChangeHook,
} from './service';
export {
  CreativeDocumentRepository,
  CreativeRevisionRepository,
  RenderJobRepository,
  RenderedExportRepository,
  ElementCommentRepository,
  TemplateRepository,
  TemplateVersionRepository,
} from './repositories';
export { registerCreativeOutboxRoutes, RENDER_TASK_QUEUE } from './outbox-routes';
/** Spec 13.4 brand_review_clean: the review module re-runs the studio's deterministic brand validation on pinned revisions. */
export { validateAgainstBrand } from '@oremedia/editor/validate';
