# What This Is and Is Not

## This repository is

The Hive Skill is a portable multi-agent council protocol packaged as an
agent skill. It instructs a host coding agent to operate through six roles:
Queen, Scout, Architect, Forger, Sentinel, and Scribe.

The protocol defines structured handoffs, evidence requirements, safety
rules, orchestration presets, bounded repair cycles, and explicit stop
conditions.

The host runtime performs the actual file operations, commands, tool calls,
and model execution.

## This repository is not

- A standalone multi-agent runtime
- A background daemon or scheduler
- A provider-routing engine
- A durable session manager
- A guarantee of parallel or multi-model execution
- The HIVE desktop, CLI, or TUI product

## Runtime dependency

Protocol compliance depends on the capabilities and instruction-following
quality of the host runtime.

Claude Code, Codex, OpenCode, and generic agents may expose different levels
of subagent support, command execution, structured output, approvals, and
parallel execution.

## What autonomy means

Autonomy in this repository means that the host agent is instructed to
continue the council workflow until a documented stop condition is reached.

It does not mean that this repository independently executes a persistent
background process.

## Related HIVE runtime

The separate HIVE runtime owns capabilities such as worktree isolation,
provider routing, durable sessions, desktop or terminal interfaces, and
runtime-level multi-agent scheduling.
