/** worker-render: isolated rendering and media ingestion (spec 4.4, 11.5). The process entry is ./main.ts (configuration gate) → ./worker.ts. */
export {
  createChromiumRenderer,
  resolveRendererBundlePath,
  type ChromiumRenderer,
} from './chromium-renderer';
export { creativeRenderJobStore } from './creative-store';
