/**
 * Spec 11.2: the creative document schema. The definitions live in @oremedia/contracts/creative so that the
 * database package and this package share one source of truth; this module re-exports them under the names
 * the specification uses.
 */
export {
  CreativeDocumentV1,
  CreativePage as Page,
  ElementSchema,
  TextElement,
  ImageElement,
  LogoElement,
  ShapeElement,
  BackgroundElement,
  Operation,
  OperationBatch,
  Finding,
  FindingSeverity,
  FormatDefinition,
  SemanticRole,
  TypeRole,
  LayoutConstraint,
} from '@oremedia/contracts/creative';
export type { Element, LeafElement, GroupElement, CreativePage as PageT } from '@oremedia/contracts/creative';
