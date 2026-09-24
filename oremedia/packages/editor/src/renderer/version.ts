/**
 * Spec 11.5: every export records the renderer version it was produced with (rendered_exports.renderer_version and
 * the manifest). Bump rules:
 *  - PATCH: a change that cannot alter any pixel of any existing document (logging, refactors, new metrics fields).
 *  - MINOR: a change that alters pixels for some documents (text layout, fit/crop maths, placeholder drawing,
 *    new element features). Golden renders are regenerated and reviewed in the same change.
 *  - MAJOR: a change to the scene contract (SceneContext/SceneHandle) or to what a document means.
 * A web app and a render worker on different MINOR/MAJOR versions produce different pixels; the manifest makes the
 * skew visible (runbook recover-rendering).
 */
export const RENDERER_VERSION = '1.0.0';
