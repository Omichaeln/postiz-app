import { z } from 'zod';

export const BudgetReservationState = z.enum(['held', 'settled', 'released']);
export const SubscriptionState = z.enum(['trial', 'active', 'past_due', 'grace', 'cancelled']);
export const UsageKind = z.enum([
  'model_tokens',
  'tool_call',
  'image_generation',
  'render_minutes',
  'storage_bytes',
]);

export const PlanLimits = z.object({
  brands: z.number().int(),
  seats: z.number().int(),
  channels: z.number().int(),
  generationBudgetMicrosMonth: z.number().int(),
  renderMinutesMonth: z.number().int(),
  analystFrequency: z.enum(['weekly', 'daily', 'none']),
  experiments: z.boolean(),
  inboxSeats: z.number().int(),
  managedAutopublish: z.boolean(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

export const SpendLimitSet = z.object({
  brandId: z.string().optional(),
  period: z.enum(['day', 'month']),
  limitMicros: z.number().int().min(0),
});
