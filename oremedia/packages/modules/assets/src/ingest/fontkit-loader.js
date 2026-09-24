// fontkit ships no type declarations and its exports map has no "types" condition, so TypeScript cannot see it.
// This ESM shim re-exports the one function the pipeline uses; fontkit-loader.d.ts types it (steps.ts).
export { create } from 'fontkit';
