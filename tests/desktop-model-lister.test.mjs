import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { DesktopModelLister } from "../dist/desktop/model-lister.js";

function provider(overrides = {}) {
  return {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    authType: "api-key",
    approved: true,
    configured: true,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function assertSorted(models) {
  const ids = models.map((model) => model.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
}

test("lists OpenAI-compatible models from /models and sorts them", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "zeta-9", context_length: 32_000, owned_by: "zeta" },
        { id: "alpha-1", context_length: 128_000, name: "Alpha" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ baseUrl: "https://api.example.com/v1" }),
    { providerId: "openai", kind: "api-key", secret: "sk-test" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.ok(calls[0].init.signal);
  assert.deepEqual(models.map((model) => model.id), ["alpha-1", "zeta-9"]);
  assert.equal(models[0].name, "Alpha");
  assert.equal(models[0].contextWindow, 128_000);
  assert.equal(models[1].contextWindow, 32_000);
});

test("OpenAI-compatible discovery preserves HTTPS default-provider endpoints", async () => {
  for (const [overrides, endpoint] of [
    [{ kind: "openai", id: "openai" }, "https://api.openai.com/v1/models"],
    [{ kind: "openrouter", id: "openrouter" }, "https://openrouter.ai/api/v1/models"],
    [{ kind: "openai-compatible", id: "openai" }, "https://api.openai.com/v1/models"],
    [{ kind: "openai-compatible", id: "openrouter" }, "https://openrouter.ai/api/v1/models"],
    [{ baseUrl: "https://api.example.test/custom/v1///" }, "https://api.example.test/custom/v1/models"],
  ]) {
    const calls = [];
    const models = await DesktopModelLister.list(
      provider(overrides),
      { providerId: overrides.id ?? "openai", kind: "api-key", secret: "discovery-test-credential" },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ data: [{ id: "https-model" }] });
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, endpoint);
    assert.equal(calls[0].init.headers.Authorization, "Bearer discovery-test-credential");
    assert.deepEqual(models.map((model) => model.id), ["https-model"]);
  }
});

test("OpenAI-compatible discovery preserves authenticated HTTP loopback endpoints", async () => {
  for (const baseUrl of [
    "http://localhost:8080/v1/",
    "http://127.0.0.1:11434/v1",
    "http://127.42.1.9:8080/v1",
    "http://[::1]:8080/v1",
  ]) {
    const calls = [];
    const models = await DesktopModelLister.list(
      provider({ id: "loopback", kind: "openai-compatible", baseUrl }),
      { providerId: "loopback", kind: "bearer", secret: "discovery-test-credential" },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ data: [{ id: "loopback-model" }] });
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${baseUrl.replace(/\/+$/, "")}/models`);
    assert.equal(calls[0].init.headers.Authorization, "Bearer discovery-test-credential");
    assert.deepEqual(models.map((model) => model.id), ["loopback-model"]);
  }
});

for (const [label, baseUrl] of [
  ["public HTTP hostname", "http://public-host/v1/private-url-value"],
  ["public HTTP IPv4", "http://203.0.113.8/v1"],
  ["LAN HTTP IPv4", "http://192.168.1.2:8080/v1"],
  ["public HTTP IPv6", "http://[2001:db8::2]:8080/v1"],
  ["unspecified HTTP IPv4", "http://0.0.0.0:8080/v1"],
  ["unspecified HTTP IPv6", "http://[::]:8080/v1"],
  ["localhost hostname suffix", "http://localhost.example.test/v1"],
  ["loopback IPv4 hostname suffix", "http://127.0.0.1.example.test/v1"],
  ["userinfo disguising a public host", "http://localhost@public-host/v1"],
  ["HTTPS userinfo", "https://user:private-url-value@api.example.test/v1"],
  ["query string", "https://api.example.test/v1?key=private-url-value"],
  ["fragment", "https://api.example.test/v1#private-url-value"],
  ["backslash", "http://localhost\\@public-host/v1"],
  ["leading whitespace", " https://api.example.test/v1"],
  ["trailing newline", "https://api.example.test/v1\n"],
  ["embedded tab", "http://local\thost:8080/v1"],
  ["terminal control character", "https://api.example.test/v1/\u001b"],
  ["bidirectional control character", "https://api.example.test/v1/\u202e"],
  ["non-HTTP protocol", "ftp://127.0.0.1/v1"],
  ["relative URL", "//localhost:8080/v1"],
  ["malformed URL", "https://[private-url-value"],
  ["oversized URL", `https://api.example.test/${"x".repeat(2048)}`],
]) {
  test(`OpenAI-compatible discovery rejects ${label} before fetching`, async () => {
    let fetchCalls = 0;
    let credentialReads = 0;
    let failure;
    try {
      await DesktopModelLister.list(
        provider({ id: "unsafe", kind: "openai-compatible", baseUrl, defaultModel: "must-not-mask-rejection" }),
        {
          providerId: "unsafe",
          kind: "bearer",
          get secret() {
            credentialReads += 1;
            return "discovery-test-credential";
          },
        },
        async () => {
          fetchCalls += 1;
          return jsonResponse({ data: [{ id: "must-not-be-requested" }] });
        },
      );
    } catch (error) {
      failure = error;
    }

    assert.equal(fetchCalls, 0, "Unsafe endpoints must be rejected before fetch");
    assert.equal(credentialReads, 0, "Unsafe endpoints must be rejected before reading credentials");
    assert.ok(failure instanceof Error, "Unsafe endpoints must fail rather than return a default model");
    assert.match(failure.message, /base URL/i);
    assert.equal(String(failure).includes(baseUrl), false);
    assert.equal(String(failure).includes("private-url-value"), false);
    assert.equal(String(failure).includes("discovery-test-credential"), false);
    assert.equal(failure.cause, undefined);
  });
}

test("non-loopback HTTP overrides are rejected for every OpenAI-compatible provider kind even without credentials", async () => {
  for (const kind of ["openai", "openrouter", "openai-compatible", "custom"]) {
    let fetchCalls = 0;
    const listing = DesktopModelLister.list(
      provider({ id: kind, kind, authType: "none", baseUrl: "http://public-host/v1" }),
      null,
      async () => {
        fetchCalls += 1;
        return jsonResponse({ data: [] });
      },
    );

    try {
      await assert.rejects(listing, /HTTPS.*loopback HTTP/);
    } finally {
      assert.equal(fetchCalls, 0, "Unsafe overrides must not reach fetch");
    }
  }
});

test("OpenAI-compatible discovery disables HTTPS redirects to prevent credential downgrade", async () => {
  const calls = [];
  await DesktopModelLister.list(
    provider({ baseUrl: "https://api.example.test/v1" }),
    { providerId: "openai", kind: "api-key", secret: "discovery-test-credential" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: [] });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "error");
});

test("redirects never forward discovery credentials to another endpoint", { timeout: 5_000 }, async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === "/v1/models") {
      response.writeHead(302, { location: "/redirected" });
      response.end();
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "redirected-model" }] }));
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const models = await DesktopModelLister.list(
    provider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: "configured-model" }),
    { providerId: "openai", kind: "api-key", secret: "discovery-test-credential" },
  );

  assert.deepEqual(requests, [{ url: "/v1/models", authorization: "Bearer discovery-test-credential" }]);
  assert.deepEqual(models.map((model) => model.id), ["configured-model"]);
});

test("lists DeepSeek models from its default baseUrl", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "deepseek-chat", name: "DeepSeek V4 Flash", context_length: 128_000, owned_by: "DeepSeek" },
        { id: "deepseek-reasoner", name: "DeepSeek V4 Pro", context_length: 128_000, owned_by: "DeepSeek" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "deepseek", name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" }),
    { providerId: "deepseek", kind: "api-key", secret: "sk-deepseek" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/models");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek");
  assert.deepEqual(models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(models[0].name, "DeepSeek V4 Flash");
});

test("lists Ollama tags from /api/tags", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return jsonResponse({
      models: [
        { name: "qwen2.5-coder:32b" },
        { model: "llama3.3:latest" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "ollama", name: "Ollama", kind: "ollama", authType: "none", baseUrl: "http://127.0.0.1:11434" }),
    null,
    fetchFn,
  );

  assert.deepEqual(calls, ["http://127.0.0.1:11434/api/tags"]);
  assert.deepEqual(models.map((model) => model.id), ["llama3.3:latest", "qwen2.5-coder:32b"]);
});

test("lists Anthropic live models when credential secret is present", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "claude-sonnet-4-6-20260515", display_name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-7-20260601", display_name: "Claude Opus 4.7" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "sk-ant-test" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-ant-test");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-7-20260601", "claude-sonnet-4-6-20260515"]);
  assert.equal(models[0].name, "Claude Opus 4.7");
  assert.equal(models[1].name, "Claude Sonnet 4.6");
  assert.equal(models[0].ownedBy, "Anthropic");
});

test("Anthropic falls back to static catalog on 401 or network error", async () => {
  const models401 = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "bad-key" },
    async () => jsonResponse({ error: "invalid_api_key" }, 401),
  );

  assert.ok(models401.some((model) => model.id.includes("claude")));
  assert.ok(models401.some((model) => model.name === "Claude Sonnet 4.6" || model.id === "claude-sonnet-4.6"));
  assertSorted(models401);

  const modelsError = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "key" },
    async () => { throw new Error("fetch aborted"); },
  );
  assert.ok(modelsError.some((model) => model.id.includes("claude")));
});

test("Anthropic with no secret returns static catalog without calling fetch", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    null,
    async () => {
      called = true;
      throw new Error("network should not be used");
    },
  );

  assert.equal(called, false);
  assert.ok(models.some((model) => model.id.includes("claude")));
  assertSorted(models);
});

test("lists Google live models when credential secret is present and filters embeddings", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      models: [
        { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent", "countTokens"] },
        { name: "models/text-embedding-004", displayName: "Text Embedding 004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent"] },
        { name: "models/aqa", displayName: "AQA Model", supportedGenerationMethods: ["generateAnswer"] },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    { providerId: "google", kind: "api-key", secret: "AIzaSyTest" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("key=AIzaSyTest"));
  assert.deepEqual(models.map((m) => m.id), ["gemini-2.5-pro", "gemini-3-flash"]);
  assert.equal(models[0].name, "Gemini 2.5 Pro");
  assert.equal(models[1].name, "Gemini 3 Flash");
  assert.equal(models[0].ownedBy, "Google");
});

for (const kind of ["anthropic", "google"]) {
  const credential = { providerId: kind, kind: "api-key", secret: "catalog-fixture-credential" };
  const first = kind === "anthropic" ? { id: "alpha", display_name: "Alpha" }
    : { name: "models/alpha", displayName: "Alpha", supportedGenerationMethods: ["generateContent"] };
  const last = kind === "anthropic" ? { id: "zeta", display_name: "Zeta" }
    : { name: "models/zeta", displayName: "Zeta", supportedGenerationMethods: ["generateContent"] };
  const page = (models, cursor) => kind === "anthropic"
    ? { data: models, has_more: Boolean(cursor), last_id: cursor }
    : { models, ...(cursor ? { nextPageToken: cursor } : {}) };

  test(`${kind} discovery follows every page, encodes cursors, and deduplicates models`, async () => {
    const calls = [];
    const cursor = "next+ /?&page";
    const models = await DesktopModelLister.list(provider({ id: kind, name: kind, kind }), credential, async (url, init) => {
      calls.push({ url: new URL(url), init });
      assert.ok(calls.length <= 2, "pagination must terminate");
      return jsonResponse(calls.length === 1 ? page([last], cursor) : page([first, last]));
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.searchParams.get(kind === "anthropic" ? "after_id" : "pageToken"), cursor);
    assert.equal(calls[0].url.origin, calls[1].url.origin);
    assert.equal(calls[0].init.signal, calls[1].init.signal);
    for (const call of calls) {
      assert.equal(call.init.redirect, "error");
      if (kind === "anthropic") assert.equal(call.init.headers["x-api-key"], credential.secret);
      else assert.equal(call.url.searchParams.get("key"), credential.secret);
    }
    assert.deepEqual(models.map((model) => model.id), ["alpha", "zeta"]);
  });

  test(`${kind} discovery stops on repeated cursors and retains the live catalog`, async () => {
    let calls = 0;
    const models = await DesktopModelLister.list(provider({ id: kind, kind }), credential, async () => {
      assert.ok(++calls <= 3, "a repeated cursor must not loop");
      return jsonResponse(page([first], "repeated"));
    });
    assert.equal(calls, 2);
    assert.deepEqual(models.map((model) => model.id), ["alpha"]);
  });

  test(`${kind} discovery preserves successful pages if a later request fails`, async () => {
    let calls = 0;
    const models = await DesktopModelLister.list(provider({ id: kind, kind }), credential, async () => {
      if (++calls === 1) return jsonResponse(page([first], "next"));
      throw new Error("later page unavailable");
    });
    assert.equal(calls, 2);
    assert.deepEqual(models.map((model) => model.id), ["alpha"]);
  });
}

test("Google discovery offers only models advertising generateContent", async () => {
  const models = await DesktopModelLister.list(provider({ id: "google", kind: "google" }),
    { providerId: "google", kind: "api-key", secret: "catalog-fixture-credential" }, async () => jsonResponse({ models: [
      { name: "models/image-predictor", supportedGenerationMethods: ["predict"] },
      { name: "models/unknown" }, { name: "models/empty", supportedGenerationMethods: [] },
      { name: "models/malformed", supportedGenerationMethods: "generateContent" },
      { name: "models/embedder", supportedGenerationMethods: ["embedContent"] },
      { name: "models/chat-model", supportedGenerationMethods: ["countTokens", "generateContent"] },
    ] }));
  assert.deepEqual(models.map((model) => model.id), ["chat-model"]);
});

test("Google discovery continues past incompatible pages and preserves an empty compatible catalog", async () => {
  const selected = provider({ id: "google", kind: "google" });
  const credential = { providerId: "google", kind: "api-key", secret: "catalog-fixture-credential" };
  let calls = 0;
  const models = await DesktopModelLister.list(selected, credential, async () => jsonResponse(++calls === 1
    ? { models: [{ name: "models/predictor", supportedGenerationMethods: ["predict"] }], nextPageToken: "next" }
    : { models: [{ name: "models/generative", supportedGenerationMethods: ["generateContent"] }] }));
  assert.equal(calls, 2);
  assert.deepEqual(models.map((model) => model.id), ["generative"]);
  const empty = await DesktopModelLister.list(selected, credential, async () => jsonResponse({ models: [
    { name: "models/predictor", supportedGenerationMethods: ["predict"] },
  ] }));
  assert.deepEqual(empty, []);
});

test("Google falls back to static catalog on failure", async () => {
  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    { providerId: "google", kind: "api-key", secret: "bad-key" },
    async () => jsonResponse({ error: "permission denied" }, 403),
  );

  assert.ok(models.some((model) => model.id.includes("gemini")));
  assertSorted(models);
});

test("Google with no secret returns static catalog without calling fetch", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    null,
    async () => {
      called = true;
      throw new Error("network should not be used");
    },
  );

  assert.equal(called, false);
  assert.ok(models.some((model) => model.id.includes("gemini")));
  assertSorted(models);
});

test("local providers return the default model without calling the network", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "local", name: "Local model", kind: "local", authType: "none", defaultModel: "hive-local" }),
    null,
    async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  );

  assert.equal(called, false);
  assert.deepEqual(models, [{ id: "hive-local", name: "hive-local", ownedBy: "Local model" }]);
});

test("openai-compatible providers without a base URL do not send secrets to OpenAI", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({
      id: "hive-cloud",
      name: "HIVE 0.1",
      kind: "openai-compatible",
      defaultModel: "hive-0.1",
      baseUrl: undefined,
    }),
    { providerId: "hive-cloud", kind: "bearer", secret: "hive-token" },
    async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  );

  assert.equal(called, false);
  assert.deepEqual(models.map((model) => model.id), ["hive-0.1"]);
});

test("failed OpenAI-compatible fetches fall back to the configured default model", async () => {
  const models = await DesktopModelLister.list(
    provider({ defaultModel: "gpt-4o-mini" }),
    null,
    async () => jsonResponse({ error: "nope" }, 401),
  );

  assert.deepEqual(models.map((model) => model.id), ["gpt-4o-mini"]);
});
