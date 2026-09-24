import type { Element } from '@oremedia/contracts/creative';

/**
 * What the scene builder measured while drawing a page (spec 11.5 checks read these). Kept free of DOM types so
 * checks.ts and the render worker can import them without the browser-only scene code.
 */
export interface SceneElementMetrics {
  elementId: string;
  kind: Element['type'];
  /** Axis-aligned bounding box of what was drawn, in page pixels (rotation and overflow included). */
  x: number;
  y: number;
  width: number;
  height: number;
  textOverflow?: boolean;
  missingAsset?: boolean;
  missingFont?: boolean;
  missingColour?: boolean;
  /** Source aspect (width / height) of the drawn image region and the aspect it was drawn at. */
  naturalAspect?: number;
  renderedAspect?: number;
}

export interface SceneMetrics {
  elements: SceneElementMetrics[];
}
