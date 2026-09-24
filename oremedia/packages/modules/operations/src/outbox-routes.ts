import type { EventType } from '@oremedia/contracts/events';

/** One outbox row as the dispatcher sees it (platform-level: it spans tenants). */
export interface OutboxEventRecord {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
}

/** What a route asks the worker to start. The database row, not Temporal, is the dedupe authority (spec 14.2). */
export interface WorkflowStartRequest {
  workflowType: string;
  taskQueue: string;
  /** Stable per aggregate occurrence, e.g. `ingest:<uploadIntentId>`; started with USE_EXISTING conflict policy. */
  workflowId: string;
  args: unknown[];
}

/** A route turns an event into a workflow start, or `null` when the event is informational (nothing to start). */
export type OutboxRoute = (evt: OutboxEventRecord) => WorkflowStartRequest | null;

const routes = new Map<EventType, OutboxRoute>();

/**
 * Modules register their own routes (composition root calls them); the dispatcher stays generic and never names a
 * module's workflow. Registering twice replaces the route, matching the other composition hooks.
 */
export function registerOutboxRoute(eventType: EventType, route: OutboxRoute): void {
  routes.set(eventType, route);
}

export function outboxRouteFor(eventType: string): OutboxRoute | undefined {
  return routes.get(eventType as EventType);
}

/** Test seam. */
export function clearOutboxRoutes(): void {
  routes.clear();
}
