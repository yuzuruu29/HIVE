export interface AnalyticsEvent {
  eventName: string;
  tenantId?: string;
  userId?: string;
  properties: Record<string, unknown>;
  sessionId?: string;
}

export class AnalyticsStore {
  readonly #events: AnalyticsEvent[] = [];

  public track(event: AnalyticsEvent): void {
    this.#events.push({
      ...event,
      properties: { ...event.properties, timestamp: new Date().toISOString() },
    });
  }

  public getEvents(filter?: {
    eventName?: string;
    tenantId?: string;
    since?: Date;
    limit?: number;
  }): AnalyticsEvent[] {
    let events = [...this.#events];
    if (filter?.eventName) events = events.filter((e) => e.eventName === filter.eventName);
    if (filter?.tenantId) events = events.filter((e) => e.tenantId === filter.tenantId);
    if (filter?.since) events = events.filter((e) => new Date(e.properties.timestamp as string) >= filter.since!);
    return events.slice(0, filter?.limit ?? 100);
  }

  public funnelBreakdown(): Record<string, number> {
    const counts: Record<string, number> = {};
    const uniqueTenants = new Set<string>();
    
    for (const event of this.#events) {
      if (event.tenantId && !uniqueTenants.has(`${event.eventName}:${event.tenantId}`)) {
        uniqueTenants.add(`${event.eventName}:${event.tenantId}`);
        counts[event.eventName] = (counts[event.eventName] ?? 0) + 1;
      }
    }
    return counts;
  }
}
