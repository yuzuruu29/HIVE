import test from "node:test";
import assert from "node:assert/strict";

test("hive code options - defaults and positional objective", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  assert.deepEqual(parseCodeCommandArgs(["fix", "the", "scheduler"]), {
    objective: "fix the scheduler",
    mode: "auto",
    maxAgents: 4,
    maxRetries: 2,
    provider: undefined,
    model: undefined,
    approval: "changes",
    resume: undefined,
    noTui: false,
    json: false,
    noMotion: false,
    roleBindings: {},
  });
});

test("hive code options - accepts every workflow flag", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs([
    "implement",
    "the feature",
    "--mode",
    "review",
    "--max-agents",
    "16",
    "--max-retries",
    "0",
    "--provider",
    "openrouter",
    "--model",
    "vendor/model-v2",
    "--approval",
    "always",
    "--no-tui",
    "--no-motion",
  ]);
  assert.equal(parsed.objective, "implement the feature");
  assert.equal(parsed.mode, "review");
  assert.equal(parsed.maxAgents, 16);
  assert.equal(parsed.maxRetries, 0);
  assert.equal(parsed.provider, "openrouter");
  assert.equal(parsed.model, "vendor/model-v2");
  assert.equal(parsed.approval, "always");
  assert.equal(parsed.noTui, true);
  assert.equal(parsed.noMotion, true);
  assert.equal(parsed.json, false);
});

test("hive code options - supports equals syntax and option interleaving", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs([
    "inspect",
    "--mode=plan",
    "provider",
    "routing",
    "--max-agents=03",
    "--max-retries=10",
    "--approval=safe",
  ]);
  assert.equal(parsed.objective, "inspect provider routing");
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.maxAgents, 3);
  assert.equal(parsed.maxRetries, 10);
  assert.equal(parsed.approval, "safe");
});

test("hive code options - resume permits a missing objective", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs(["--resume", "session-123"]);
  assert.equal(parsed.objective, undefined);
  assert.equal(parsed.resume, "session-123");
});

test("hive code options - json is non-interactive NDJSON mode", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs(["inspect repository", "--json"]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.noTui, true);
  assert.equal(parsed.noMotion, true);
});

test("hive code options - parses every role binding and preserves model slashes", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs([
    "route roles",
    "--queen", "openrouter:org/high-reasoning/model",
    "--planner", "openai:o3/model",
    "--scout", "ollama:qwen2.5-coder/latest",
    "--builder", "local:coder/model-v2",
    "--validator", "ollama:validator/latest",
    "--reviewer", "openrouter:review/model",
    "--fixer", "compatible:fix/model",
  ]);
  assert.deepEqual(parsed.roleBindings, {
    queen: { providerId: "openrouter", model: "org/high-reasoning/model" },
    planner: { providerId: "openai", model: "o3/model" },
    scout: { providerId: "ollama", model: "qwen2.5-coder/latest" },
    builder: { providerId: "local", model: "coder/model-v2" },
    validator: { providerId: "ollama", model: "validator/latest" },
    reviewer: { providerId: "openrouter", model: "review/model" },
    fixer: { providerId: "compatible", model: "fix/model" },
  });
});

test("hive code options - splits a role binding only at its first colon", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs([
    "use local model",
    "--builder",
    "ollama:llama3.2:latest",
  ]);
  assert.deepEqual(parsed.roleBindings.builder, {
    providerId: "ollama",
    model: "llama3.2:latest",
  });
});

test("hive code options - option terminator permits flag-like objective text", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  const parsed = parseCodeCommandArgs(["document", "--", "--custom-flag", "behavior"]);
  assert.equal(parsed.objective, "document --custom-flag behavior");
});

test("hive code options - rejects missing objective without resume", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  assert.throws(
    () => parseCodeCommandArgs([]),
    /objective is required unless --resume/i,
  );
  assert.throws(
    () => parseCodeCommandArgs(["", "  "]),
    /objective is required unless --resume/i,
  );
});

test("hive code options - rejects unknown, duplicate, and valued boolean flags", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  assert.throws(
    () => parseCodeCommandArgs(["task", "--mystery"]),
    /Unknown hive code option: --mystery/,
  );
  assert.throws(
    () => parseCodeCommandArgs(["task", "-x"]),
    /Unknown hive code option: -x/,
  );
  assert.throws(
    () => parseCodeCommandArgs(["task", "--json", "--json"]),
    /Duplicate hive code option: --json/,
  );
  assert.throws(
    () => parseCodeCommandArgs(["task", "--json=true"]),
    /--json does not accept a value/,
  );
});

test("hive code options - rejects missing and empty values", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  for (const flag of [
    "--mode",
    "--max-agents",
    "--max-retries",
    "--provider",
    "--model",
    "--approval",
    "--resume",
    "--builder",
  ]) {
    assert.throws(
      () => parseCodeCommandArgs(["task", flag]),
      new RegExp(`${flag} requires a value`),
    );
    assert.throws(
      () => parseCodeCommandArgs(["task", `${flag}=`]),
      new RegExp(`${flag} requires a value`),
    );
  }
  assert.throws(
    () => parseCodeCommandArgs(["task", "--resume", "--json"]),
    /--resume requires a value/,
  );
});

test("hive code options - rejects invalid modes and approval policies", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  assert.throws(
    () => parseCodeCommandArgs(["task", "--mode", "automatic"]),
    /--mode must be one of: auto, plan, review/,
  );
  assert.throws(
    () => parseCodeCommandArgs(["task", "--approval", "never"]),
    /--approval must be one of: safe, changes, always/,
  );
});

test("hive code options - enforces numeric integer ranges", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  for (const value of ["0", "17", "1.5", "1e1", "-1", "abc"]) {
    assert.throws(
      () => parseCodeCommandArgs(["task", "--max-agents", value]),
      /--max-agents must be an integer from 1 to 16/,
    );
  }
  for (const value of ["11", "1.5", "1e1", "-1", "abc"]) {
    assert.throws(
      () => parseCodeCommandArgs(["task", "--max-retries", value]),
      /--max-retries must be an integer from 0 to 10/,
    );
  }
});

test("hive code options - requires provider and model together", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  assert.throws(
    () => parseCodeCommandArgs(["task", "--provider", "openrouter"]),
    /--provider and --model must be provided together/,
  );
  assert.throws(
    () => parseCodeCommandArgs(["task", "--model", "org/model"]),
    /--provider and --model must be provided together/,
  );
});

test("hive code options - rejects malformed role bindings", async () => {
  const { parseCodeCommandArgs } = await import("../dist/coding/cli-options.js");
  for (const binding of ["openrouter", ":model", "provider:", ":"] ) {
    assert.throws(
      () => parseCodeCommandArgs(["task", "--planner", binding]),
      /--planner must use provider:model format/,
    );
  }
});

test("hive code help - documents defaults, safety semantics, roles, and NDJSON", async () => {
  const { CODE_COMMAND_HELP } = await import("../dist/coding/cli-options.js");
  assert.ok(CODE_COMMAND_HELP.startsWith("Usage:\n  hive code"));
  assert.ok(CODE_COMMAND_HELP.includes("--mode auto|plan|review"));
  assert.ok(CODE_COMMAND_HELP.includes("default: 4"));
  assert.ok(CODE_COMMAND_HELP.includes("default: 2"));
  assert.ok(CODE_COMMAND_HELP.includes("safe asks before repository changes"));
  assert.ok(CODE_COMMAND_HELP.includes("--queen <provider:model>"));
  assert.ok(CODE_COMMAND_HELP.includes("--fixer <provider:model>"));
  assert.ok(CODE_COMMAND_HELP.includes("newline-delimited JSON (NDJSON) events only on stdout"));
  assert.ok(CODE_COMMAND_HELP.includes("implies --no-tui and --no-motion"));
  assert.ok(!CODE_COMMAND_HELP.includes("\x1b["));
  for (const char of CODE_COMMAND_HELP) {
    assert.ok(char === "\n" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126));
  }
});
