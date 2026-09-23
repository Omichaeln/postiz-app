import { z } from 'zod';

export const Completeness = z.enum(['complete', 'partial', 'unavailable']);
export type Completeness = z.infer<typeof Completeness>;

export const MetricSubjectType = z.enum(['publication', 'channel', 'campaign', 'link']);

export const MetricDefinitionInput = z.object({
  key: z.string().max(80),
  providerKey: z.string().max(40).nullable(),
  nativeName: z.string().max(120),
  unit: z.string().max(40),
  aggregation: z.enum(['sum', 'max', 'last', 'avg', 'series']),
  comparableGroup: z.string().max(40),
  definitionVersion: z.number().int().min(1),
  separatesPaidOrganic: z.boolean().default(false),
});

export const MetricsQuery = z.object({
  brandId: z.string(),
  subjectType: MetricSubjectType,
  subjectIds: z.array(z.string()).min(1).max(200),
  metricKeys: z.array(z.string()).min(1).max(50),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const TrackedLinkCreate = z.object({
  brandId: z.string(),
  publicationId: z.string().optional(),
  variantId: z.string().optional(),
  experimentId: z.string().optional(),
  destination: z.string().url().max(2000),
  utm: z.record(z.string().max(200)).default({}),
});

export const ConversionSource = z.enum(['crm', 'pixel', 'form']);
