import type { z } from 'zod';
import { CreativeAttributesV1, type CopyDocumentV1 } from '@oremedia/contracts/content';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import { CreativeAttributesCorrect, CreativeAttributesGet } from '@oremedia/contracts/measurement';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { CreativeAttributeRepository, type AttributeCaptureInput } from '@oremedia/module-content';
import { CreativeRevisionRepository } from '@oremedia/module-creative';
import { audit } from '@oremedia/module-operations';

/**
 * Spec 16.2: creative attributes are captured at creation from the structured inputs (the copy document and the
 * creative documents' element semantics), never reconstructed from flattened images. Humans may correct any
 * attribute; `source` then reads human_corrected.
 */
const attributesRepo = new CreativeAttributeRepository();
const creativeRevisionsRepo = new CreativeRevisionRepository();

const CTA_PATTERN =
  /\b(shop|buy|learn more|sign up|register|book|download|subscribe|get started|try|discover|visit|order|join|apply|call|contact|claim|explore|read more|see more|watch)\b/i;

/** Copy features from the master text: hook type, topic, message, offer fact and call to action. */
export function copyFeatures(copy: CopyDocumentV1): CreativeAttributesV1 {
  const text = copy.master.text.trim();
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = sentences[0] ?? text;
  const hookType = !first
    ? undefined
    : first.endsWith('?')
      ? 'question'
      : /^\d/.test(first)
        ? 'number'
        : /!$/.test(first)
          ? 'exclamation'
          : /^(you|your)\b/i.test(first)
            ? 'direct_address'
            : 'statement';
  const hashtag = text.match(/#([\p{L}\p{N}_]+)/u)?.[1];
  const topic = hashtag ?? first.split(/\s+/).slice(0, 6).join(' ');
  const ctaSentence = [...sentences].reverse().find((s) => CTA_PATTERN.test(s));
  const out: CreativeAttributesV1 = {};
  if (hookType) out.hookType = hookType;
  if (topic) out.topic = topic.slice(0, 120);
  if (first) out.message = first.slice(0, 300);
  if (copy.master.factRefs[0]) out.offerFactId = copy.master.factRefs[0];
  if (ctaSentence) out.cta = ctaSentence.slice(0, 120);
  return out;
}

type Element = CreativeDocumentV1['pages'][number]['elements'][number];

function flatten(elements: Element[]): Element[] {
  const out: Element[] = [];
  for (const e of elements) {
    out.push(e);
    if (e.type === 'group') out.push(...flatten(e.children as Element[]));
  }
  return out;
}

/** Layout features from a creative document's element semantic roles and kinds (spec 16.2, 11.2). */
export function layoutFeatures(doc: CreativeDocumentV1): CreativeAttributesV1 {
  const elements = flatten(doc.pages.flatMap((p) => p.elements as Element[]));
  const roles = [
    ...new Set(elements.flatMap((e) => (e.semanticRole ? [String(e.semanticRole)] : []))),
  ].sort();
  const texts = elements.filter((e): e is Extract<Element, { type: 'text' }> => e.type === 'text');
  const typographyRoles = [...new Set(texts.map((t) => t.style.typeRole))].sort();
  const tokenised = texts.filter((t) => t.style.colourToken).length;
  const raw = texts.filter((t) => !t.style.colourToken && t.style.colourValue).length;
  const images = elements.filter((e) => e.type === 'image');
  const imageryKind =
    images.length === 0
      ? 'none'
      : images.some((e) => e.semanticRole === 'product')
        ? 'product'
        : /illustration/i.test(images.map((e) => e.name).join(' '))
          ? 'illustration'
          : /people|person|team|portrait/i.test(images.map((e) => e.name).join(' '))
            ? 'people'
            : 'photography';
  const out: CreativeAttributesV1 = {
    layoutKey: roles.length ? roles.join('+') : 'unlabelled',
    colourTreatment: texts.length === 0 ? 'none' : raw === 0 ? 'tokens' : tokenised === 0 ? 'raw' : 'mixed',
    typographyRoles,
    imageryKind,
  };
  if (doc.templateVersionId) out.templateVersionId = doc.templateVersionId;
  return out;
}

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

export const toAttributesDto = (a: Awaited<ReturnType<CreativeAttributeRepository['getById']>>) => ({
  id: a.id,
  brandId: a.brandId,
  contentRevisionId: a.contentRevisionId,
  channelVariantId: a.channelVariantId,
  attributes: a.attributes,
  source: a.source,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
  version: a.version,
});

export const attributeService = {
  /**
   * The content module's AttributeCapturer (registered by the composition root): runs inside the revision's
   * transaction. Copy features come from the copy document, layout features from the first pinned creative
   * revision's snapshot; `distribution` records who authored the revision (user editor or agent skill).
   */
  async capture(input: AttributeCaptureInput, tx: Tx): Promise<string> {
    let attributes: CreativeAttributesV1 = { ...copyFeatures(input.copy), distribution: input.authorKind };
    const firstCreative = input.creativeRevisionIds[0];
    if (firstCreative) {
      const revision = await creativeRevisionsRepo.getById(firstCreative, tx);
      attributes = { ...attributes, ...layoutFeatures(revision.snapshot) };
    }
    const id = newId('creativeAttributes');
    await attributesRepo.create(
      {
        id,
        brandId: input.brandId,
        contentRevisionId: input.contentRevisionId,
        channelVariantId: null,
        attributes: CreativeAttributesV1.parse(attributes),
        source: 'captured',
      },
      tx,
    );
    return id;
  },

  /** insight.read on the brand of the attributes row; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, input: z.infer<typeof CreativeAttributesGet>, tx?: Tx) {
    const parsed = CreativeAttributesGet.parse(input);
    const row = parsed.attributeId
      ? await attributesRepo.getById(parsed.attributeId, tx)
      : parsed.contentRevisionId
        ? await attributesRepo.findForRevision(parsed.contentRevisionId, tx)
        : parsed.channelVariantId
          ? await attributesRepo.findForVariant(parsed.channelVariantId, tx)
          : null;
    if (!parsed.attributeId && !parsed.contentRevisionId && !parsed.channelVariantId)
      throw new ValidationFailedError([
        { path: 'attributeId', issue: 'one_of_attributeId_contentRevisionId_channelVariantId' },
      ]);
    if (!row)
      throw new NotFoundError(
        'CreativeAttributes',
        parsed.attributeId ?? parsed.contentRevisionId ?? parsed.channelVariantId ?? '',
      );
    await policy.assert(actor, 'insight.read', brandResource(row.brandId), {}, tx);
    return toAttributesDto(row);
  },

  /** content.edit on the brand: merges the correction and records the human source (spec 16.2). */
  async correct(actor: ResolvedActor, input: z.infer<typeof CreativeAttributesCorrect>, tx: Tx) {
    const parsed = CreativeAttributesCorrect.parse(input);
    const row = await attributesRepo.getById(parsed.attributeId, tx);
    await policy.assert(actor, 'content.edit', brandResource(row.brandId), {}, tx);
    const attributes = CreativeAttributesV1.parse({ ...row.attributes, ...parsed.attributes });
    await attributesRepo.update(
      row.id,
      parsed.expectedVersion,
      { attributes, source: 'human_corrected' },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'measurement.attributes.correct',
      { type: 'creative_attributes', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fields: Object.keys(parsed.attributes) },
    );
    return toAttributesDto(await attributesRepo.getById(row.id, tx));
  },
};
