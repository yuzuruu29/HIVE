# Claude Code Adapter for The Hive Skill

> This adapter documents how the host runtime maps to the HIVE protocol.
> It is not an executable orchestration engine.

Maps the HIVE council protocol to Claude Code's native capabilities.

## Capability Profile

| Aspect | Behavior |
|--------|----------|
| **Subagent model** | Real subagents via Claude Code's Task tool |
| **Execution model** | Sequential by default; parallel when roles have non-overlapping file scopes |
| **Structured output** | Markdown-based (handoff schema rendered as Markdown) |
| **Approval enforcement** | Host-enforced via Claude Code's native approval prompts |
| **Unavailable capabilities** | None — all protocol capabilities supported |

## Capability Detection

| Capability | Supported | Notes |
|-----------|-----------|-------|
| Subagent spawning | Via Task tool | Can run roles in parallel when file scopes do not overlap |
| Structured output | Markdown | Handoff schema rendered as Markdown |
| File editing | Read/Write/Edit tools | Full file manipulation |
| Command execution | Bash tool | Full shell access |
| Approval prompts | Native | Claude Code's built-in approval prompts |

## Adapter Behavior

The council runs as a sequential workflow by default. When independent roles have non-overlapping file scopes, the Queen may dispatch them via parallel Task tool calls.

### Handoff Rendering

Structured handoffs are rendered as Markdown using the format defined in [handoff-schema.md](../../skills/hive-mind-council/references/handoff-schema.md). All semantic fields are preserved.

### Installation

```bash
# Add the skill to Claude Code
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

### Safety Notes

- Claude Code's built-in approval prompts handle GIT_MUTATE and DESTRUCTIVE permission levels.
- The Sentinel runs validation using available tools (Bash, lint, test commands).
- Prompt injection resistance relies on Claude Code's native instruction handling.
