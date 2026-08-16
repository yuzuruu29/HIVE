export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  anthropicVersion?: string;
}

export interface AnthropicRequestParams {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  tools?: unknown[];
}

export interface NormalizedEvent {
  content: string;
  finishReason?: string;
}

export interface AnthropicUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
}

export class AnthropicAdapter {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #anthropicVersion: string;

  constructor(options: AnthropicAdapterOptions) {
    if (!options.apiKey) throw new Error("Anthropic API key is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.#anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  }

  public buildRequest(params: AnthropicRequestParams): Record<string, unknown> {
    const systemMessage = params.messages.find((m) => m.role === "system");
    const nonSystemMessages = params.messages.filter((m) => m.role !== "system");

    const systemContent = systemMessage
      ? (typeof systemMessage.content === "string" ? systemMessage.content : JSON.stringify(systemMessage.content))
      : undefined;

    return {
      model: params.model,
      max_tokens: params.max_tokens ?? 4096,
      ...(systemContent ? { system: systemContent } : {}),
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
      })),
      ...(params.stream !== undefined ? { stream: params.stream } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.tools?.length ? { tools: params.tools } : {}),
    };
  }

  public buildHeaders(): Record<string, string> {
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": this.#anthropicVersion,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "HIVE-Cloud/0.1",
    };
  }

  public getEndpoint(): string {
    return `${this.#baseUrl}/messages`;
  }

  public normalizeEvent(event: Record<string, unknown>): NormalizedEvent {
    const type = event["type"] as string;

    switch (type) {
      case "content_block_delta": {
        const delta = (event["delta"] as Record<string, unknown>) ?? {};
        return {
          content: delta["type"] === "text_delta" ? ((delta["text"] as string) ?? "") : "",
        };
      }
      case "message_stop":
        return { content: "", finishReason: "end_turn" };
      case "content_block_stop":
      case "message_start":
      case "content_block_start":
      case "ping":
        return { content: "" };
      default:
        return { content: "" };
    }
  }

  public extractUsage(event: Record<string, unknown>): AnthropicUsage {
    const message = event["message"] as Record<string, unknown> | undefined;
    const usage = ((event["usage"] ?? message?.["usage"]) as Record<string, unknown>) ?? {};
    return {
      promptTokens: (usage["input_tokens"] as number) ?? 0,
      completionTokens: (usage["output_tokens"] as number) ?? 0,
      ...(usage["cache_read_input_tokens"] != null
        ? { cacheHitTokens: usage["cache_read_input_tokens"] as number }
        : {}),
      ...(usage["cache_creation_input_tokens"] != null
        ? { cacheWriteTokens: usage["cache_creation_input_tokens"] as number }
        : {}),
    };
  }

  public async toOpenAIResponse(upstream: Response, stream: boolean, model: string): Promise<Response> {
    const headers = new Headers(upstream.headers);
    headers.set("content-type", stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
    if (!stream) {
      const payload = await upstream.json() as Record<string, unknown>;
      const content = Array.isArray(payload["content"])
        ? (payload["content"] as Array<Record<string, unknown>>).flatMap((part) => part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("")
        : "";
      const usage = this.extractUsage(payload);
      return Response.json({
        id: typeof payload["id"] === "string" ? payload["id"] : "anthropic-response",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: payload["stop_reason"] ?? "stop" }],
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens },
      }, { status: upstream.status, headers });
    }

    if (!upstream.body) throw new Error("Anthropic returned no stream body");
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    const thisAdapter = this;
    const normalized = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 1_048_576) throw new Error("Anthropic stream event exceeded the safety limit");
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
            if (!data) continue;
            const event = JSON.parse(data) as Record<string, unknown>;
            const usage = thisAdapter.extractUsage(event);
            if (usage.promptTokens > 0) promptTokens = usage.promptTokens;
            if (usage.completionTokens > 0) completionTokens = usage.completionTokens;
            const delta = thisAdapter.normalizeEvent(event);
            if (!delta.content && !delta.finishReason && usage.promptTokens === 0 && usage.completionTokens === 0) continue;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: "anthropic-stream",
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: delta.content ? { content: delta.content } : {}, finish_reason: delta.finishReason ?? null }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            })}\n\n`));
          }
        } catch (error) {
          controller.error(error);
          await reader.cancel(error).catch(() => undefined);
        }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => undefined); },
    });
    return new Response(normalized, { status: upstream.status, headers });
  }

  public normalizeError(errorBody: Record<string, unknown>, statusCode: number): {
    code: string;
    message: string;
    statusCode: number;
  } {
    const error = (errorBody["error"] as Record<string, unknown>) ?? {};
    const message = (error["message"] as string) ?? "Unknown Anthropic error";

    let code = "provider_error";
    if (statusCode === 401 || statusCode === 403) code = "provider_auth_failed";
    else if (statusCode === 429) code = "provider_rate_limited";
    else if (statusCode >= 500) code = "provider_unavailable";

    return { code, message, statusCode };
  }
}
