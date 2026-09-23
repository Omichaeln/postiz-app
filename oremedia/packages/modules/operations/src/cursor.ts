/** Spec 7.4: cursor = opaque base64 of the sort key + id. */
export interface Cursor {
  id: string;
  sort?: string | number;
}

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
