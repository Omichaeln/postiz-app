/** Spec 14.1: stable dedupe identity of one intended publication. Deliberate repeats carry a new occurrence. */
export const occurrenceKey = (
  contentRevisionId: string,
  channelConnectionId: string,
  occurrence?: string | null,
): string => `${contentRevisionId}:${channelConnectionId}:${occurrence ?? 'once'}`;
