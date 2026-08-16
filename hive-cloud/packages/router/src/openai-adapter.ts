export interface OpenAIAdapterOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface NormalizedChunk {
  content: string;
  finishReason?: string;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
}

export interface NormalizedError {
  code: string;
  message: string;
  statusCode: number;
}

export class OpenAIAdapter {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(options: OpenAIAdapterOptions) {
    if (!options.apiKey) throw new Error("OpenAI API key is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  public buildRequest(params: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
  }): Record<string, unknown> {
    return {
      model: params.model,
      messages: params.messages,
      ...(params.stream !== undefined ? { stream: params.stream } : {}),
      ...(params.stream ? { stream_options: { include_usage: true } } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
      ...(params.tools?.length ? { tools: params.tools } : {}),
    };
  }

  public buildHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "HIVE-Cloud/0.1",
    };
  }

  public getEndpoint(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  public normalizeChunk(chunk: Record<string, unknown>): NormalizedChunk {
    const choices = (chunk["choices"] as Array<Record<string, unknown>>) ?? [];
    const choice = choices[0];
    if (!choice) return { content: "" };

    const delta = (choice["delta"] as Record<string, unknown>) ?? {};
    const content = typeof delta["content"] === "string" ? delta["content"] : "";
    const finishReason = typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : undefined;

    return { content, ...(finishReason !== undefined ? { finishReason } : {}) };
  }

  public extractUsage(chunk: Record<string, unknown>): NormalizedUsage {
    const usage = (chunk["usage"] as Record<string, unknown>) ?? {};
    const details = (usage["prompt_tokens_details"] as Record<string, unknown>) ?? {};

    return {
      promptTokens: (usage["prompt_tokens"] as number) ?? 0,
      completionTokens: (usage["completion_tokens"] as number) ?? 0,
      totalTokens: (usage["total_tokens"] as number) ?? 0,
      ...(details["cached_tokens"] != null ? { cacheHitTokens: details["cached_tokens"] as number } : {}),
    };
  }

  public normalizeError(errorBody: Record<string, unknown>, statusCode: number): NormalizedError {
    const error = (errorBody["error"] as Record<string, unknown>) ?? {};
    const message = (error["message"] as string) ?? "Unknown OpenAI error";

    let code = "provider_error";
    if (statusCode === 401 || statusCode === 403) code = "provider_auth_failed";
    else if (statusCode === 429) code = "provider_rate_limited";
    else if (statusCode >= 500) code = "provider_unavailable";

    return { code, message, statusCode };
  }
}
