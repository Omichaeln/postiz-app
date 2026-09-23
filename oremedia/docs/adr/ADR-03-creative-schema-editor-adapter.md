# ADR-03: Application-owned versioned creative schema behind an editor adapter; Konva default

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Medium.

## Decision

`CreativeDocumentV1` (contracts) is the persisted, layered document. Human and agent edits are `OperationBatch`
values reduced by a pure reducer. The canvas library sits behind `EditorAdapter`; the recommended default is
Konva/react-konva with application state outside the stage. Polotno is context-dependent on written licence
confirmation (D-05); Postiz's Polotno integration (flattened PNG, module-level store) is not ported.

## Consequences

Rendering runs the same scene code in headless Chromium with pinned fonts and a manifest; golden-render tests guard
preview/production fidelity.
