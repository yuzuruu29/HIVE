# Codex Plugin Configuration

## Installation

```bash
# Add the skill to Codex
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

## Codex-Specific Considerations

- **Subagents**: Codex supports Task-based subagent invocation. Roles execute sequentially.
- **Structured output**: Codex renders handoffs as Markdown. The semantic fields are preserved.
- **Approvals**: Use Codex's native approval prompts for GIT_MUTATE and DESTRUCTIVE operations.

## Verification

```bash
ls ~/.codex/skills/hive-mind-council/
```
