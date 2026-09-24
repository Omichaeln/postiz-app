import type { z } from 'zod';
import type { MessageClassification as MessageClassificationSchema } from '@oremedia/contracts/intelligence';
import type { Tx } from '@oremedia/db';

type MessageClassification = z.infer<typeof MessageClassificationSchema>;

/**
 * Cross-module hooks and process configuration (same pattern as the publishing module's hooks.ts). The
 * composition root wires what each process needs; defaults are loud where silence would hide a mistake and quiet
 * where the feature is simply not composed (a redirect domain that is not configured means "no tracking").
 */

/** Spec 15.4: LINK_REDIRECT_DOMAIN (Appendix A). Without it, variant text is left untouched. */
export interface LinkTrackingOptions {
  /** e.g. `https://ore.link`; the rewritten URL is `<redirectBaseUrl>/<shortCode>`. */
  redirectBaseUrl: string | null;
}
let linkTracking: LinkTrackingOptions = { redirectBaseUrl: null };
export const configureLinkTracking = (opts: LinkTrackingOptions): void => {
  linkTracking = { redirectBaseUrl: opts.redirectBaseUrl ? opts.redirectBaseUrl.replace(/\/+$/, '') : null };
};
export const linkTrackingOptions = (): LinkTrackingOptions => linkTracking;
export const linkTrackingFromEnv = (env: NodeJS.ProcessEnv = process.env): LinkTrackingOptions => {
  const domain = env['LINK_REDIRECT_DOMAIN'];
  if (!domain) return { redirectBaseUrl: null };
  return { redirectBaseUrl: domain.startsWith('http') ? domain : `https://${domain}` };
};

/**
 * Spec 16.5: author identities are hashed with a per-tenant salt derived from a secret reference
 * (COMMENT_AUTHOR_HASH_SECRET_REF, falling back to LINK_HASH_SECRET_REF so one keyed-hash secret serves both
 * hashing surfaces). Raw ids never reach the hash table.
 */
let authorHashSecret: string | null = null;
export const configureAuthorHashing = (opts: { secret: string }): void => {
  authorHashSecret = opts.secret;
};
export const authorHashSecretInUse = (): string => {
  if (!authorHashSecret)
    throw new Error(
      'author hashing secret not configured (composition root must call configureAuthorHashing)',
    );
  return authorHashSecret;
};
export const authorHashingFromEnv = (env: NodeJS.ProcessEnv = process.env): { secret: string } => {
  const secret = env['COMMENT_AUTHOR_HASH_SECRET_REF'] ?? env['LINK_HASH_SECRET_REF'];
  if (!secret) throw new Error('COMMENT_AUTHOR_HASH_SECRET_REF (or LINK_HASH_SECRET_REF) is required');
  return { secret };
};

/** A comment as the intelligence module (classification, embedding, clustering) receives it: references and text. */
export interface IngestedComment {
  messageId: string;
  conversationId: string;
  brandId: string;
  publicationId: string | null;
  channelConnectionId: string;
  authorHash: string;
  text: string;
  remoteCreatedAt: string;
  /** Set when a classifier is registered: computed before the ingesting transaction opened. */
  classification: MessageClassification | null;
}

/**
 * Spec 16.5: the intelligence module classifies each new comment. The classifier is a model call, so ingestion
 * calls it before its transaction opens (no connection held across the call) and stores the answer on the message
 * and hands it to the sinks; without one, messages stay unclassified and a sink classifies on its own.
 */
export type CommentClassifier = (comment: {
  brandId: string;
  text: string;
}) => Promise<MessageClassification>;
let commentClassifier: CommentClassifier | null = null;
export const registerCommentClassifier = (fn: CommentClassifier | null): void => {
  commentClassifier = fn;
};
export async function classifyComment(comment: {
  brandId: string;
  text: string;
}): Promise<MessageClassification | null> {
  return commentClassifier ? commentClassifier(comment) : null;
}

export type CommentSink = (comments: IngestedComment[], tx: Tx) => Promise<void>;
const commentSinks: CommentSink[] = [];
/**
 * Spec 16.5: the intelligence module subscribes here; sinks run inside the ingesting transaction, so they write
 * only (the classification arrives on the comment; network and model calls belong before the transaction).
 */
export const registerCommentSink = (fn: CommentSink): void => {
  commentSinks.push(fn);
};
/** Test seam. */
export const resetCommentSinks = (): void => {
  commentSinks.length = 0;
};
export async function notifyCommentSinks(comments: IngestedComment[], tx: Tx): Promise<void> {
  if (comments.length === 0) return;
  for (const sink of commentSinks) await sink(comments, tx);
}

/** Brand ids named in inputs are verified through the brand module (spec 4.2), as the publishing module does. */
export interface BrandChecker {
  assertExist(brandIds: string[], tx?: Tx): Promise<void>;
}
let brandChecker: BrandChecker = {
  assertExist: async () => {
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  },
};
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
export const assertBrandExists = (brandId: string, tx?: Tx): Promise<void> =>
  brandChecker.assertExist([brandId], tx);
