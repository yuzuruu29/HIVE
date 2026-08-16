# Codex Agents — The Hive Skill

## Agent Configuration

The Hive Skill works as a single agent that simulates six council roles. No special agent configuration is required beyond installing the skill.

## Role Simulation

When Codex lacks true multi-agent spawning, the council executes sequentially:

1. Queen establishes run contract.
2. Scout (or skipped if not needed) produces context bundle.
3. Architect (or skipped) produces plan.
4. Forger implements.
5. Sentinel validates.
6. Scribe reports.

Each role hands off using the structured handoff format defined in [handoff-schema.md](../../skills/hive-mind-council/references/handoff-schema.md).

## Capability Note

Codex does not support true parallel subagent execution. The council always runs sequentially. The Queen accounts for this by selecting configurations that minimize unnecessary role invocations.
