/**
 * Shared streaming helpers for provider adapters: SSE event parsing and
 * NDJSON line parsing over a fetch response body, per the subset of the
 * `text/event-stream` grammar that LLM APIs actually emit (`event:` lines,
 * `data:` lines, blank-line separators, `:` comments/keep-alives).
 */

export interface SseEvent {
  /** `event:` field, when the server sets one (Anthropic, Google). */
  event?: string;
  /** `data:` payload with multi-line data joined by newlines. */
  data: string;
}

/** Reads a response body to completion, invoking `onEvent` per SSE event. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  const dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0 && eventName === undefined) return;
    onEvent({ event: eventName, data: dataLines.join("\n") });
    eventName = undefined;
    dataLines.length = 0;
  };

  const processLine = (raw: string): void => {
    if (raw === "") {
      flush();
      return;
    }
    if (raw.startsWith(":")) return;
    if (raw.startsWith("event:")) {
      eventName = raw.slice(6).trim();
      return;
    }
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).replace(/^ /, ""));
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") processLine(buffer.replace(/\r$/, ""));
    flush();
  } finally {
    reader.releaseLock();
  }
}

/** Reads a response body of newline-delimited JSON, invoking `onLine` per line. */
export async function readLineStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== "") onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.replace(/\r$/, "");
    if (trailing !== "") onLine(trailing);
  } finally {
    reader.releaseLock();
  }
}
