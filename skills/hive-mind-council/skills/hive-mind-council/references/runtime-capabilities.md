# Runtime Capabilities Reference

Deterministic adaptation rules for runtime capability negotiation and adapter conformance levels.

## Capability Flags

Each runtime declares a set of boolean capability flags. The following table documents how the council must adapt its behavior when a capability is `false` or unknown.

## Decision Table

| Capability | When `false` | When unknown |
|---|---|---|
| `file_editing` | Force **Audit** or read-only behavior. Forgers may inspect but not modify files. | Treat as unsupported. Default to read-only. |
| `command_execution` | Sentinel performs **static validation only**. No commands can be run during verification. | Treat as unsupported. Skip all command-based checks. |
| `native_subagents` | Fall back to **sequential role simulation**. One host agent performs all roles serially. | Treat as unsupported. Use sequential simulation. |
| `parallel_execution` | Use **serial task graph** execution. Tasks run one at a time in dependency order. | Treat as unsupported. Default to serial execution. |
| `approval_prompts` | Block **GIT_MUTATE** and **DESTRUCTIVE** operations entirely. Cannot request user approval at runtime. | Treat as unsupported. Block all mutation operations. |
| `structured_output` | Use **canonical Markdown fallback** for all structured data (handoffs, evidence, reviews). No JSON schema guarantees. | Treat as unsupported. Fall back to Markdown. |
| `persistent_sessions` | Do **not** promise resumability across sessions. The run terminates when the session ends. | Treat as unsupported. Do not promise resumability. |
| `network_access` | Do **not** assign network-dependent tasks (API calls, web fetches, package downloads). | Treat as unsupported. Avoid network tasks. |
| `isolated_subagents` | Subagents share the host agent's context. No sandboxing or isolation guarantees. | Treat as unsupported. No isolation. |
| `git_operations` | Do not perform Git commit, push, rebase, or branch operations. Inspection (status, log) may still be possible. | Treat as unsupported. Avoid Git mutations. |
| `cancellation` | Cannot cancel in-flight operations. Plan accordingly to avoid long-running tasks with no abort. | Treat as unsupported. Design for no-cancellation. |

## Conformance Levels

Adapters declare a `declared_conformance_level` from 0 to 4. Each level defines the integration depth between the adapter and the HIVE Protocol.

| Level | Name | Description |
|---|---|---|
| **0** | Documentation mapping | Adapter only explains how a host agent could follow the protocol. No automated enforcement or validation. |
| **1** | Sequential role simulation | One host agent performs all council roles serially. Role handoffs and evidence are tracked but executed by a single agent context. |
| **2** | Structured protocol integration | Validated structured handoffs, approvals, and evidence. Uses JSON schemas for artifact validation. Supports approval prompts and structured output. |
| **3** | Native isolated subagents | Distinct subagent contexts or sessions for each role. Subagents operate in isolated environments with separate state. |
| **4** | Parallel scoped execution | Concurrent scoped tasks with independent evidence tracking. Full parallelism with coordination via the council protocol. |

### Assignment Rules

- Levels **0**, **1**, and **2** may be assigned from structural/documentation analysis alone.
- Levels **3** and **4** **require live runtime evidence** (test results, session recordings, or CI pipeline output) demonstrating the capability. They cannot be assigned from documentation alone.

### Capability Requirements by Level

| Level | Required Capabilities |
|---|---|
| 0 | None |
| 1 | `native_subagents: false` (sequential simulation is the mechanism), `structured_output: false` (Markdown fallback is acceptable) |
| 2 | `structured_output: true`, `approval_prompts: true`, `file_editing: true`, `command_execution: true` |
| 3 | `native_subagents: true`, `isolated_subagents: true` |
| 4 | `parallel_execution: true`, `native_subagents: true`, `isolated_subagents: true`, plus live evidence of concurrent scoped task execution |
