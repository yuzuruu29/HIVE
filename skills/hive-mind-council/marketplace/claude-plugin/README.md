# Claude Plugin — The Hive Skill

A disciplined multi-agent orchestration skill for Claude Code. Turns one AI agent into a six-role council with structured handoffs, evidence requirements, bounded repair cycles, and explicit stop conditions.

## Features

- **Six roles**: Queen, Scout, Architect, Forger, Sentinel, Scribe
- **Orchestration presets**: Quick, Standard, Deep, Audit
- **Structured handoffs**: Standardized YAML/Markdown handoff schema
- **Evidence-based validation**: No completion without tested proof
- **Safety model**: 6 permission levels with approval requirements
- **Scope enforcement**: Roles cannot modify files outside their assigned scope

## Installation

```bash
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

See the [Claude Code adapter](../../adapters/claude-code/README.md) for details.

## Requirements

- Claude Code CLI with tool access (Read, Write, Edit, Bash, Task)
- Node.js 18+ with `npx` available
