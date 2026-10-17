import path from "node:path";
import { promises as fs } from "node:fs";
import { bundlePath, type TreeFile } from "./marketplace-io.js";
import { identifier, keys, MAX_CONFIG_BYTES, object, string } from "./io.js";
import { containsKnownSecret, isCredentialFieldName } from "../security/secrets.js";
import { validateOAuthUrl } from "../security/oauth-network.js";
import type { HookEvent, ProcessSpec } from "./types.js";

const EVENTS = {
  SessionStart: "session_start", UserPromptSubmit: "prompt_submit", PreToolUse: "before_tool",
  PostToolUse: "after_tool", PostToolUseFailure: "after_tool_failure", SessionEnd: "session_end",
  Stop: "stop", StopFailure: "stop_failure", SubagentStart: "subagent_start", SubagentStop: "subagent_stop", PermissionRequest: "permission_request",
} as const satisfies Record<string, HookEvent>;
export type ClaudeHookEvent = keyof typeof EVENTS;
export type ClaudeAdvancedHookHandler =
  | { type: "http"; url: string; headers: Record<string, string>; allowedEnvVars: string[] }
  | { type: "prompt"; prompt: string; model?: string; continueOnBlock?: boolean }
  | { type: "agent"; prompt: string; model?: string }
  | { type: "mcp_tool"; server: string; tool: string; input: Record<string, unknown> };

export interface ClaudeHookEvaluationRequest {
  hookId: string;
  event: ClaudeHookEvent;
  type: "prompt" | "agent";
  prompt: string;
  input: Record<string, unknown>;
  model?: string;
  cwd: string;
  maxTurns: number;
  signal: AbortSignal;
}
export interface ClaudeHookEvaluation { ok: boolean; reason?: string; impossible?: boolean }
/** Embedding capabilities are supplied by the trusted runtime, never by plugin JSON. */
export interface ClaudeHookHost {
  evaluate(request: ClaudeHookEvaluationRequest): Promise<ClaudeHookEvaluation>;
  callMcpTool?(request: { hookId: string; server: string; tool: string; input: Record<string, unknown>; signal: AbortSignal }): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>;
}
export interface ClaudeHookConfiguration {
  event: ClaudeHookEvent;
  matcher?: string;
  shell?: "bash" | "powershell";
  onFailure?: "continue" | "block";
  handler?: ClaudeAdvancedHookHandler;
}

function eventName(value: unknown): ClaudeHookEvent {
  if (value === "SessionStart" || value === "UserPromptSubmit" || value === "PreToolUse" || value === "PostToolUse" || value === "PostToolUseFailure" || value === "SessionEnd" || value === "Stop" || value === "StopFailure" || value === "SubagentStart" || value === "SubagentStop" || value === "PermissionRequest") return value;
  throw new Error(`Unsupported Claude hook event: ${typeof value === "string" ? value : "invalid"}`);
}

/** A deliberately linear matcher subset: exact alternatives and anchored literal/glob expressions. */
function matcherPattern(value: unknown): string | undefined {
  if (value === undefined || value === "" || value === "*") return undefined;
  const pattern = string(value, "Claude hook matcher", 256);
  if (/^[A-Za-z0-9_ ,|-]+$/u.test(pattern)) return pattern;
  // No groups, lookarounds, backreferences, nested quantifiers, classes or arbitrary regex.
  if (!/^\^?(?:[A-Za-z0-9_ :/-]|\\\.|\.\*)+\$?$/u.test(pattern)) throw new Error("Claude hook matcher supports exact alternatives or anchored literal patterns with .*, without arbitrary regular expressions");
  return pattern;
}

export function parseClaudeHookTimeout(value: unknown, type?: ClaudeAdvancedHookHandler["type"]): number {
  if (value === undefined) return type === "agent" ? 60_000 : 30_000;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 100 || value > 120_000) throw new Error("Claude hook timeoutMs must be from 100 to 120000 milliseconds");
  return Math.round(value);
}

function httpHandler(value: Record<string, unknown>): Extract<ClaudeAdvancedHookHandler, { type: "http" }> {
  keys(value, ["type", "url", "headers", "allowedEnvVars"], "Claude HTTP hook");
  const url = string(value.url, "Claude HTTP hook URL", 4096);
  try { validateOAuthUrl(url, { allowLoopbackOAuthHttp: true }); }
  catch { throw new Error("Claude HTTP hooks require HTTPS or literal loopback HTTP, without URL credentials or fragments"); }
  const parsed = new URL(url);
  if ([...parsed.searchParams.keys()].some((key) => /(?:key|token|secret|password|credential|auth)/iu.test(key)) || containsKnownSecret(url)) throw new Error("Claude HTTP hook URLs cannot contain credentials; use header environment references");
  const refs = value.allowedEnvVars ?? [];
  if (!Array.isArray(refs) || refs.length > 32 || refs.some((entry) => typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(entry) || entry.toLowerCase() === "__proto__") || new Set(refs).size !== refs.length) throw new Error("Claude HTTP hook allowedEnvVars must contain at most 32 unique environment variable names");
  const headers: Record<string, string> = {};
  const rawHeaders = value.headers === undefined ? {} : object(value.headers, "Claude HTTP hook headers");
  if (Object.keys(rawHeaders).length > 32) throw new Error("Claude HTTP hooks allow at most 32 headers");
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) || /^(?:host|connection|content-length|content-type|transfer-encoding|proxy-.*|cookie|set-cookie)$/iu.test(key)) throw new Error("Claude HTTP hook contains a forbidden header name");
    if (Object.keys(headers).some((entry) => entry.toLowerCase() === key.toLowerCase())) throw new Error("Claude HTTP hook header names must be unique ignoring case");
    if (typeof raw !== "string" || raw.length > 4096 || /[\r\n\0]/u.test(raw)) throw new Error("Claude HTTP hook headers must be bounded single-line strings");
    const withoutReferences = raw.replace(/\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/gu, "");
    if (containsKnownSecret(withoutReferences) || (isCredentialFieldName(key) || /(?:authorization|api[-_]?key|token|secret|password|credential)/iu.test(key)) && !/^(?:Bearer |Basic |Token )?\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/u.test(raw)) throw new Error("Claude HTTP hook credential headers require environment references, never literal values");
    if (withoutReferences.includes("$") || raw.includes("${user_config.")) throw new Error("Claude HTTP hook headers only support environment variable references");
    headers[key] = raw;
  }
  return { type: "http", url, headers, allowedEnvVars: refs };
}

function advancedHandler(raw: unknown, event: ClaudeHookEvent): ClaudeAdvancedHookHandler {
  const value = object(raw, "Claude hook handler");
  if (value.type === "http") {
    if (event === "SessionStart") throw new Error("SessionStart does not support Claude HTTP hooks");
    return httpHandler(value);
  }
  if (value.type === "prompt" || value.type === "agent") {
    keys(value, value.type === "prompt" ? ["type", "prompt", "model", "continueOnBlock"] : ["type", "prompt", "model"], "Claude model hook");
    if (!["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "SubagentStop", "PermissionRequest"].includes(event) || value.type === "agent" && event === "PermissionRequest") throw new Error(`${event} does not support Claude ${value.type} hooks`);
    const prompt = value.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)) throw new Error("Claude hook prompt must be nonempty bounded text without control characters");
    const model = value.model === undefined ? undefined : string(value.model, "Claude hook model", 256);
    if (containsKnownSecret(prompt) || model && containsKnownSecret(model)) throw new Error("Claude hook prompts and model names cannot contain credentials");
    if (value.type === "prompt") {
      if (value.continueOnBlock !== undefined && typeof value.continueOnBlock !== "boolean") throw new Error("Claude prompt hook continueOnBlock must be a boolean");
      return { type: "prompt", prompt, ...(model ? { model } : {}), ...(value.continueOnBlock === undefined ? {} : { continueOnBlock: value.continueOnBlock }) };
    }
    return { type: "agent", prompt, ...(model ? { model } : {}) };
  }
  if (value.type === "mcp_tool") {
    keys(value, ["type", "server", "tool", "input"], "Claude MCP tool hook");
    if (event === "SessionStart") throw new Error("MCP tool hooks are unavailable during HIVE SessionStart; use a command hook");
    const server = string(value.server, "Claude hook MCP server", 256); const tool = string(value.tool, "Claude hook MCP tool", 256);
    if (!/^(?:plugin:[A-Za-z0-9._-]+:)?[A-Za-z0-9._-]+$/u.test(server) || !/^[A-Za-z0-9_.-]+$/u.test(tool)) throw new Error("Claude MCP hook server or tool name is invalid");
    const input = value.input === undefined ? {} : object(value.input, "Claude MCP hook input");
    if (Buffer.byteLength(JSON.stringify(input)) > 32_768 || containsKnownSecret(JSON.stringify(input))) throw new Error("Claude MCP hook input must be bounded and cannot contain credentials");
    return { type: "mcp_tool", server, tool, input };
  }
  throw new Error("Unsupported Claude hook handler type");
}

export function parseClaudeHookConfiguration(raw: unknown, nativeEvent: HookEvent): ClaudeHookConfiguration {
  const value = object(raw, "Claude hook metadata");
  keys(value, ["event", "matcher", "shell", "onFailure", "handler"], "Claude hook metadata");
  const event = eventName(value.event);
  if (EVENTS[event] !== nativeEvent) throw new Error("Claude hook event does not match its native lifecycle event");
  const matcher = matcherPattern(value.matcher);
  if (["UserPromptSubmit", "Stop"].includes(event) && matcher) throw new Error(`${event} does not support matchers`);
  const shell = value.shell;
  if (shell !== undefined && shell !== "bash" && shell !== "powershell") throw new Error("Claude hook shell must be bash or powershell");
  const onFailure = value.onFailure;
  if (onFailure !== undefined && onFailure !== "continue" && onFailure !== "block") throw new Error("Claude hook onFailure must be continue or block");
  const handler = value.handler === undefined ? undefined : advancedHandler(value.handler, event);
  if (handler && shell) throw new Error("Only command Claude hooks may specify a shell");
  if (handler && handler.type !== "http" && onFailure) throw new Error("Only command and HTTP Claude hooks may specify onFailure");
  return { event, ...(matcher ? { matcher } : {}), ...(shell ? { shell } : {}), ...(onFailure ? { onFailure } : {}), ...(handler ? { handler } : {}) };
}

function readHookFile(files: TreeFile[], source: string): unknown {
  const name = bundlePath(source);
  if (!name.endsWith(".json")) throw new Error("Claude hook configuration paths must name JSON files");
  const file = files.find((candidate) => candidate.name === name);
  if (!file) throw new Error(`Missing Claude hook configuration: ${name}`);
  if (file.bytes.length > MAX_CONFIG_BYTES) throw new Error("Claude hook configuration exceeds 131072 bytes");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
}

/** Import only metadata. No command is resolved, launched or installed during conversion. */
export function importClaudeHooks(files: TreeFile[], destination: string, declarations: unknown[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  let sources = 0;
  const add = (source: unknown): void => {
    if (source === undefined || source === null) return;
    if (++sources > 128) throw new Error("Too many nested Claude hook sources");
    if (Array.isArray(source)) { if (source.length > 32) throw new Error("Too many Claude hook sources"); for (const entry of source) add(entry); return; }
    if (typeof source === "string") {
      const file = bundlePath(source); if (seen.has(file)) return; seen.add(file);
      add(readHookFile(files, file)); return;
    }
    const outer = object(source, "Claude hooks");
    const eventMap = outer.hooks === undefined ? outer : object(outer.hooks, "Claude hooks event map");
    if (outer.hooks !== undefined) keys(outer, ["hooks", "description"], "Claude hook file");
    for (const [rawEvent, rawGroups] of Object.entries(eventMap)) {
      const event = eventName(rawEvent);
      if (!Array.isArray(rawGroups) || rawGroups.length > 32) throw new Error("Claude hook events must contain at most 32 matcher groups");
      for (const rawGroup of rawGroups) {
        const group = object(rawGroup, "Claude hook matcher group"); keys(group, ["matcher", "hooks"], "Claude hook matcher group");
        const handlers = group.hooks;
        if (!Array.isArray(handlers) || handlers.length > 32) throw new Error("Claude hook groups must contain at most 32 handlers");
        for (const rawHandler of handlers) {
          const handler = object(rawHandler, "Claude hook handler");
          const commonFields = ["type", "timeout", "statusMessage"];
          if (handler.type !== "command" && handler.type !== "http" && handler.type !== "prompt" && handler.type !== "agent" && handler.type !== "mcp_tool") throw new Error("Unsupported Claude hook handler type");
          keys(handler, [...commonFields, ...(handler.type === "command" ? ["command", "args", "shell", "onFailure", "async", "asyncRewake"] : handler.type === "http" ? ["url", "headers", "allowedEnvVars", "onFailure"] : handler.type === "mcp_tool" ? ["server", "tool", "input"] : handler.type === "prompt" ? ["prompt", "model", "continueOnBlock"] : ["prompt", "model"])], "Claude hook handler");
          if (handler.async !== undefined && handler.async !== false || handler.asyncRewake !== undefined && handler.asyncRewake !== false) throw new Error("Background Claude hook handlers are not supported");
          if (handler.statusMessage !== undefined) string(handler.statusMessage, "Claude hook statusMessage", 1024);
          const timeout = handler.timeout;
          if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0.1 || timeout > 120)) throw new Error("Claude hook timeout must be from 0.1 to 120 seconds");
          const nativeEvent = EVENTS[event];
          if (Object.keys(result).length >= 32) throw new Error("At most 32 Claude hook handlers may be imported");
          const name = identifier(`claude-${event}-${Object.keys(result).length + 1}`);
          if (handler.type !== "command") {
            const { timeout: _timeout, statusMessage: _statusMessage, onFailure, ...declaration } = handler;
            const claude = parseClaudeHookConfiguration({ event, ...(group.matcher === undefined ? {} : { matcher: group.matcher }), ...(onFailure === undefined ? {} : { onFailure }), handler: declaration }, nativeEvent);
            result[name] = { event: nativeEvent, timeoutMs: parseClaudeHookTimeout(timeout === undefined ? undefined : timeout * 1000, claude.handler?.type), claude };
            continue;
          }
          const command = string(handler.command, "Claude hook command", 16_384);
          const args = handler.args;
          if (args !== undefined && (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 16_384))) throw new Error("Claude hook args must contain at most 64 bounded strings");
          const expand = (value: string): string => {
            if (/\$\{(?:CLAUDE_PLUGIN_DATA|user_config\.)/u.test(value)) throw new Error("Claude hook data and user configuration interpolation is not supported");
            return args === undefined ? value : value.replaceAll("${CLAUDE_PLUGIN_ROOT}", destination);
          };
          const claude = parseClaudeHookConfiguration({ event, ...(group.matcher === undefined ? {} : { matcher: group.matcher }), ...(args === undefined ? { shell: handler.shell ?? "bash" } : {}), ...(handler.onFailure === undefined ? {} : { onFailure: handler.onFailure }) }, nativeEvent);
          result[name] = { event: nativeEvent, command: expand(command), args: args === undefined ? [] : args.map((arg) => expand(String(arg))), cwd: ".", env: { CLAUDE_PLUGIN_ROOT: destination }, timeoutMs: timeout === undefined ? 30_000 : Math.round(timeout * 1000), claude };
        }
      }
    }
  };
  if (files.some((file) => file.name === "hooks/hooks.json")) add("hooks/hooks.json");
  for (const declaration of declarations) add(declaration);
  return result;
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? object(value, "hook input") : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
const TOOL_NAMES: Record<string, string> = { read_file: "Read", list_directory: "LS", search_text: "Grep", search_symbols: "Grep", create_file: "Write", write_file: "Write", edit_file: "Edit", apply_patch: "Edit", run_command: "Bash", run_test: "Bash" };

/** Build event data from caller-provided runtime context; never invent transcript paths. */
export function claudeHookInput(configuration: ClaudeHookConfiguration, input: unknown, cwd: string): Record<string, unknown> {
  const value = record(input);
  const tool = text(value.toolName) ?? text(value.tool) ?? text(value.tool_name);
  const args = record(value.arguments ?? value.input ?? value.tool_input);
  const result = record(value.result);
  const common = {
    hook_event_name: configuration.event, cwd: text(value.workspace) ?? text(value.cwd) ?? cwd,
    session_id: text(value.sessionId) ?? text(value.session_id) ?? "",
    ...(text(value.transcriptPath) ?? text(value.transcript_path) ? { transcript_path: text(value.transcriptPath) ?? text(value.transcript_path) } : {}),
    permission_mode: text(value.permissionMode) ?? text(value.permission_mode) ?? "default",
    ...(text(value.taskId) ? { agent_id: value.taskId } : {}),
  };
  switch (configuration.event) {
    case "SessionStart": return { ...common, source: text(value.source) ?? "startup" };
    case "SessionEnd": return { ...common, reason: text(value.reason) ?? "other" };
    case "UserPromptSubmit": return { ...common, prompt: text(value.prompt) ?? text(value.objective) ?? "" };
    case "Stop": case "SubagentStop": return { ...common, stop_hook_active: value.stop_hook_active === true,
      last_assistant_message: text(value.last_assistant_message) ?? text(value.lastAssistantMessage) ?? "",
      ...(configuration.event === "SubagentStop" ? { agent_id: text(value.agent_id) ?? text(value.taskId) ?? "", agent_type: text(value.agent_type) ?? text(value.role) ?? "" } : {}),
    };
    case "StopFailure": return { ...common, error: text(value.error) ?? "unknown", error_details: text(value.error_details) ?? text(value.errorDetails) ?? "", last_assistant_message: text(value.last_assistant_message) ?? text(value.lastAssistantMessage) ?? "" };
    case "SubagentStart": return { ...common, agent_id: text(value.agent_id) ?? text(value.taskId) ?? "", agent_type: text(value.agent_type) ?? text(value.role) ?? "" };
    case "PreToolUse": case "PostToolUse": case "PostToolUseFailure": case "PermissionRequest": {
      const toolInput = { ...args };
      if (typeof args.path === "string" && toolInput.file_path === undefined) toolInput.file_path = path.resolve(String(common.cwd), args.path);
      if (typeof args.search === "string" && toolInput.old_string === undefined) toolInput.old_string = args.search;
      if (typeof args.replacement === "string" && toolInput.new_string === undefined) toolInput.new_string = args.replacement;
      return { ...common, tool_name: tool ? TOOL_NAMES[tool] ?? tool : "", tool_input: toolInput,
        tool_use_id: text(value.toolUseId) ?? text(value.tool_use_id) ?? "",
        ...(configuration.event === "PermissionRequest" && Array.isArray(value.permission_suggestions) ? { permission_suggestions: value.permission_suggestions } : {}),
        ...(configuration.event === "PostToolUse" ? { tool_response: value.toolResponse ?? value.tool_response ?? result } : {}),
        ...(configuration.event === "PostToolUseFailure" ? { error: text(value.error) ?? text(result.output) ?? "Tool execution failed", is_interrupt: value.is_interrupt === true,
          ...(typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 ? { duration_ms: Math.round(value.duration_ms) } : {}) } : {}),
      };
    }
  }
}

export function matchesClaudeHook(configuration: ClaudeHookConfiguration, input: Record<string, unknown>): boolean {
  const matcher = configuration.matcher;
  if (!matcher) return true;
  const candidate = String(configuration.event === "SessionStart" ? input.source : configuration.event === "SessionEnd" ? input.reason : configuration.event === "StopFailure" ? input.error : configuration.event === "SubagentStart" || configuration.event === "SubagentStop" ? input.agent_type : input.tool_name ?? "").slice(0, 512);
  if (/^[A-Za-z0-9_ ,|-]+$/u.test(matcher)) return matcher.split(/[|,]/u).some((entry) => entry.trim() === candidate);
  const start = matcher.startsWith("^"); const end = matcher.endsWith("$");
  const parts = matcher.slice(start ? 1 : 0, end ? -1 : undefined).split(".*").map((part) => part.replaceAll("\\.", "."));
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const found = index === parts.length - 1 && end ? candidate.length - part.length : candidate.indexOf(part, offset);
    if (found < offset || index === 0 && start && found !== 0 || candidate.slice(found, found + part.length) !== part) return false;
    offset = found + part.length;
  }
  return true;
}

/** Environment substitution occurs after shell parsing, keeping plugin paths out of shell source. */
export async function claudeHookProcess(spec: ProcessSpec, configuration: ClaudeHookConfiguration, cwd: string): Promise<ProcessSpec> {
  const env = { ...spec.env, CLAUDE_PROJECT_DIR: cwd };
  if (!configuration.shell) return { ...spec, command: spec.command.replaceAll("${CLAUDE_PROJECT_DIR}", cwd), args: spec.args.map((arg) => arg.replaceAll("${CLAUDE_PROJECT_DIR}", cwd)), env };
  if (configuration.shell === "bash") {
    let command = "bash";
    if (process.platform === "win32") {
      const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((base): base is string => !!base);
      const candidates = bases.flatMap((base) => [path.join(base, "Git", "bin", "bash.exe"), path.join(base, "Git", "usr", "bin", "bash.exe")]);
      const found: string[] = [];
      for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) found.push(candidate); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } }
      if (!found[0]) throw new Error("Claude Bash hooks require installed Git Bash on Windows; select shell:powershell explicitly or use command with args. WSL is not launched implicitly");
      command = found[0];
    }
    return { ...spec, command, args: ["--noprofile", "--norc", "-c", spec.command], env };
  }
  const source = spec.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${env:CLAUDE_PLUGIN_ROOT}").replaceAll("${CLAUDE_PROJECT_DIR}", "${env:CLAUDE_PROJECT_DIR}");
  // The allowlisted env has no LOCALAPPDATA, so PowerShell has no module-analysis cache and
  // autoloading the JSON cmdlets hooks rely on scans every installed module (30s+ on hosts with
  // large module sets). Importing the built-in module by name skips that scan.
  const prelude = "Import-Module Microsoft.PowerShell.Utility; ";
  return { ...spec, command: process.platform === "win32" ? "powershell.exe" : "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prelude + source], env };
}

export interface ClaudeHookOutcome { blocked: boolean; stop?: boolean; continuation?: string; additionalContext?: string; diagnostics?: string[] }

export function claudeHookOutcome(configuration: ClaudeHookConfiguration, stdout: string, stderr: string, exitCode: number | null): ClaudeHookOutcome {
  if (configuration.event === "SessionEnd" || configuration.event === "StopFailure") return { blocked: false };
  const canBlock = configuration.event === "PreToolUse" || configuration.event === "UserPromptSubmit" || configuration.event === "PermissionRequest";
  const canContinue = configuration.event === "Stop" || configuration.event === "SubagentStop";
  let blocked = canBlock && (exitCode === 2 && configuration.event !== "PermissionRequest" || exitCode !== 0 && configuration.onFailure === "block");
  const diagnostics: string[] = [];
  const value = stdout.trim();
  let context: string | undefined; let stop = false; let continuation: string | undefined;
  if (value.startsWith("{")) {
    const output = object(JSON.parse(value), "Claude hook output");
    keys(output, ["continue", "stopReason", "suppressOutput", "systemMessage", "decision", "reason", "hookSpecificOutput"], "Claude hook output");
    for (const key of ["continue", "suppressOutput"]) if (output[key] !== undefined && typeof output[key] !== "boolean") throw new Error(`Claude hook ${key} must be a boolean`);
    for (const key of ["stopReason", "systemMessage", "reason"]) if (output[key] !== undefined && typeof output[key] !== "string") throw new Error(`Claude hook ${key} must be a string`);
    if (output.systemMessage) diagnostics.push(String(output.systemMessage));
    if (output.decision !== undefined && output.decision !== "block") throw new Error("Claude hooks cannot approve permissions or replace HIVE approval decisions");
    if (output.continue === false || output.decision === "block") { blocked = canBlock; stop = output.continue === false; if (output.reason ?? output.stopReason) diagnostics.push(String(output.reason ?? output.stopReason)); }
    if (canContinue && output.decision === "block" && !stop) continuation = text(output.reason) ?? "The completion hook requested further work";
    if (output.hookSpecificOutput !== undefined) {
      const specific = object(output.hookSpecificOutput, "Claude hookSpecificOutput");
      keys(specific, ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext", "decision"], "Claude hookSpecificOutput");
      if (specific.hookEventName !== configuration.event) throw new Error("Claude hook output event does not match the running hook");
      if (specific.permissionDecision !== undefined) {
        if (configuration.event !== "PreToolUse" || specific.permissionDecision !== "deny") throw new Error("Claude hooks cannot approve or alter permission decisions; use HIVE's fresh approval flow");
        blocked = true;
      }
      if (specific.decision !== undefined) {
        const decision = object(specific.decision, "Claude hook permission decision"); keys(decision, ["behavior", "message", "interrupt"], "Claude hook permission decision");
        if (configuration.event !== "PermissionRequest" || decision.behavior !== "deny") throw new Error("Claude hooks cannot approve permissions or replace HIVE approval decisions");
        if (decision.message !== undefined && typeof decision.message !== "string" || decision.interrupt !== undefined && typeof decision.interrupt !== "boolean") throw new Error("Claude permission denial contains invalid fields");
        blocked = true; stop = decision.interrupt === true;
        if (decision.message) diagnostics.push(String(decision.message));
      }
      for (const key of ["permissionDecisionReason", "additionalContext"]) if (specific[key] !== undefined && typeof specific[key] !== "string") throw new Error(`Claude hook ${key} must be a string`);
      if (specific.permissionDecisionReason) diagnostics.push(String(specific.permissionDecisionReason));
      context = text(specific.additionalContext);
    }
  } else if (exitCode === 0 && (configuration.event === "SessionStart" || configuration.event === "UserPromptSubmit")) context = value;
  if (canContinue && exitCode === 2) continuation = stderr.trim() || "The completion hook requested further work";
  if (blocked && !diagnostics.length) diagnostics.push(stderr.trim() || "Claude hook blocked this action");
  // Runtime redaction precedes truncation so an opaque credential crossing the
  // display boundary cannot leave an unredactable prefix in the context.
  if (canContinue && exitCode === 0 && context && !stop && !continuation) continuation = context;
  if (configuration.event === "SubagentStart") stop = false;
  return { blocked, ...(stop ? { stop: true } : {}), ...(!stop && continuation ? { continuation } : {}), ...(exitCode === 0 && context ? { additionalContext: context } : {}), ...(diagnostics.length ? { diagnostics } : {}) };
}
