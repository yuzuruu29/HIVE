import {
  CODING_SESSION_SCHEMA_VERSION,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeEventListener,
  type RuntimeEventType,
} from "./types.js";

const runtimeEventTypes: Record<RuntimeEventType, true> = {
  "session.created": true,
  "session.started": true,
  "session.paused": true,
  "session.resumed": true,
  "session.cancelled": true,
  "session.completed": true,
  "plan.created": true,
  "task.created": true,
  "task.ready": true,
  "task.started": true,
  "task.progress": true,
  "task.blocked": true,
  "task.retrying": true,
  "task.completed": true,
  "task.failed": true,
  "task.cancelled": true,
  "task.skipped": true,
  "subagent.created": true,
  "subagent.queued": true,
  "subagent.started": true,
  "subagent.progress": true,
  "subagent.tool_call": true,
  "subagent.file_changed": true,
  "subagent.blocked": true,
  "subagent.retrying": true,
  "subagent.validating": true,
  "subagent.completed": true,
  "subagent.failed": true,
  "subagent.cancelled": true,
  "subagent.skipped": true,
  "subagent.status_changed": true,
  "file.changed": true,
  "command.started": true,
  "command.output": true,
  "command.completed": true,
  "validation.started": true,
  "validation.completed": true,
  "review.completed": true,
  "verdict.computed": true,
  "failure.recorded": true,
  "integration.completed": true,
  "evidence.invalidated": true,
  "session.reconciled": true,
};

export const RUNTIME_EVENT_TYPES = Object.freeze(
  Object.keys(runtimeEventTypes) as RuntimeEventType[],
);

export interface RuntimeEventReplayOptions {
  fromSequence?: number;
  sessionId?: string;
}

export interface RuntimeEventSubscriptionOptions
  extends RuntimeEventReplayOptions {
  replay?: boolean;
}

export interface RuntimeEventBusOptions {
  clock?: () => string;
  idFactory?: (sequence: number) => string;
  initialEvents?: readonly RuntimeEvent[];
  onListenerError?: (error: unknown, event: RuntimeEvent) => void;
}

function defaultEventId(sequence: number): string {
  return `evt-${String(sequence).padStart(6, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeEventType(value: unknown): value is RuntimeEventType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(runtimeEventTypes, value)
  );
}

function hasRuntimeEventShape(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return false;
  }
  return (
    value.schemaVersion === CODING_SESSION_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.timestamp === "string" &&
    value.timestamp.length > 0 &&
    isRuntimeEventType(value.type)
  );
}

function assertMonotonicHistory(events: readonly RuntimeEvent[]): void {
  let previous = 0;
  for (const event of events) {
    if (!hasRuntimeEventShape(event)) {
      throw new Error("Initial event history contains an invalid runtime event");
    }
    if (event.sequence <= previous) {
      throw new Error("Initial event history must have monotonic sequence numbers");
    }
    previous = event.sequence;
  }
}

export class RuntimeEventBus {
  readonly #clock: () => string;
  readonly #idFactory: (sequence: number) => string;
  readonly #onListenerError?: (error: unknown, event: RuntimeEvent) => void;
  readonly #events: RuntimeEvent[];
  readonly #listeners = new Set<RuntimeEventListener>();
  #nextSequence: number;

  public constructor(options: RuntimeEventBusOptions = {}) {
    const initialEvents = options.initialEvents ?? [];
    assertMonotonicHistory(initialEvents);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? defaultEventId;
    this.#onListenerError = options.onListenerError;
    this.#events = [...initialEvents];
    this.#nextSequence =
      (initialEvents.at(-1)?.sequence ?? 0) + 1;
  }

  public emit<TType extends RuntimeEventType>(
    input: RuntimeEventInput<TType>,
  ): RuntimeEvent<TType>;
  public emit(input: RuntimeEventInput): RuntimeEvent {
    const sequence = this.#nextSequence++;
    const event = {
      schemaVersion: CODING_SESSION_SCHEMA_VERSION,
      id: input.id ?? this.#idFactory(sequence),
      sequence,
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? this.#clock(),
      type: input.type,
      payload: input.payload,
    } as RuntimeEvent;

    this.#events.push(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#onListenerError?.(error, event);
      }
    }
    return event;
  }

  public subscribe(
    listener: RuntimeEventListener,
    options: RuntimeEventSubscriptionOptions = {},
  ): () => void {
    if (options.replay) {
      for (const event of this.replay(options)) {
        listener(event);
      }
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public replay(options: RuntimeEventReplayOptions = {}): RuntimeEvent[] {
    const fromSequence = options.fromSequence ?? 1;
    return this.#events.filter(
      (event) =>
        event.sequence >= fromSequence &&
        (options.sessionId === undefined ||
          event.sessionId === options.sessionId),
    );
  }

  public get size(): number {
    return this.#events.length;
  }

  public get nextSequence(): number {
    return this.#nextSequence;
  }
}

export function serializeRuntimeEvent(event: RuntimeEvent): string {
  const serialized = JSON.stringify({
    schemaVersion: event.schemaVersion,
    id: event.id,
    sequence: event.sequence,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    type: event.type,
    payload: event.payload,
  });
  if (serialized === undefined) {
    throw new TypeError("Runtime event could not be serialized");
  }
  return serialized;
}

export function serializeRuntimeEvents(
  events: readonly RuntimeEvent[],
): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map(serializeRuntimeEvent).join("\n")}\n`;
}

export function deserializeRuntimeEvent(serialized: string): RuntimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid runtime event JSON${detail}`);
  }
  if (!hasRuntimeEventShape(parsed)) {
    throw new Error("Invalid runtime event shape");
  }
  return parsed as RuntimeEvent;
}

export function deserializeRuntimeEvents(serialized: string): RuntimeEvent[] {
  return serialized
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map(deserializeRuntimeEvent);
}
