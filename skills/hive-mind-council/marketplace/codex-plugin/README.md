# Codex Plugin — The Hive Skill

A disciplined multi-agent orchestration skill for Codex. Turns one AI agent into a six-role council with structured handoffs, evidence requirements, bounded repair cycles, and explicit stop conditions.

## Features

- **Six roles**: Queen, Scout, Architect, Forger, Sentinel, Scribe
- **Orchestration presets**: Quick, Standard, Deep, Audit
- **Structured handoffs**: Standardized YAML/Markdown handoff schema
- **Evidence-based validation**: No completion without tested proof
- **Safety model**: 6 permission levels with approval requirements

## Installation

```bash
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

See the [Codex adapter](../../adapters/codex/README.md) for details.

## Requirements

- Codex CLI with tool access
- Node.js 18+ with `npx` available
