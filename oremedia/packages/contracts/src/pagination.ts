import { z } from 'zod';

/** Spec 7.4: cursor pagination everywhere a list can grow. Default 50, maximum 200. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
export const ID_LIST_MAX = 200;

export const PageRequest = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
});
export type PageRequest = z.infer<typeof PageRequest>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const IdList = z.array(z.string()).min(1).max(ID_LIST_MAX);
