# Generic Agents Adapter for The Hive Skill

> This adapter documents how the host runtime maps to the HIVE protocol.
> It is not an executable orchestration engine.

Maps the HIVE council protocol to generic AI agent runtimes.

## Capability Profile

| Aspect | Behavior |
|--------|----------|
| **Subagent model** | Role simulation (no native subagent spawning) |
| **Execution model** | Fully sequential |
| **Structured output** | Markdown-based; falls back to plain text when structured tools unavailable |
| **Approval enforcement** | Host-enforced where available; reports to user as fallback |
| **Unavailable capabilities** | Subagent spawning, parallel execution, native structured output, execution-based validation |

## Capability Detection

Generic agents may lack native subagent spawning, structured output, or file editing capabilities. The adapter provides fallback behavior for each.

| Capability | Default | Fallback |
|-----------|---------|----------|
| Subagent spawning | Not available | Sequential role execution |
| Structured output | Markdown | Plain text handoffs |
| File editing | Via tool access | Instructions for manual edits |
| Command execution | Via tool access | Skip if unavailable |
| Approval prompts | Via tool access | Report to user |

## Adapter Behavior

The council runs as a fully sequential workflow. Each role completes before the next begins. The Queen must choose presets that match the runtime's capabilities.

### Handoff Rendering

Structured handoffs use the format defined in [handoff-schema.md](../../skills/hive-mind-council/references/handoff-schema.md). When structured tools are unavailable, fall back to the Markdown template format.

### Fallback Mode

When the runtime provides limited tool access:
- **Scout** uses only read commands.
- **Forger** provides implementation instructions rather than direct edits.
- **Sentinel** performs code review without execution.
- **Scribe** generates reports based on available evidence.

### Installation

```bash
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

### Safety Notes

- Without execution capability, the Sentinel relies on static analysis.
- Approval enforcement depends on the runtime's native capabilities.
- Contract validation scripts check handoff schema and YAML template compliance.
