# Generic Agents — The Hive Skill

## Agent Configuration

The Hive Skill works as a single agent that simulates six council roles. No special agent configuration is required beyond installing the skill.

## Role Simulation

When the runtime lacks multi-agent spawning, the council executes sequentially:

1. Queen establishes run contract.
2. Scout produces context bundle.
3. Architect produces plan.
4. Forger implements (or provides instructions).
5. Sentinel validates (static analysis minimum).
6. Scribe reports.

Each role hands off using the structured handoff format defined in [handoff-schema.md](../../skills/hive-mind-council/references/handoff-schema.md).

## Capability Detection

The adapter detects available capabilities at runtime:

```yaml
runtime_capabilities:
  has_subagent_support: false
  has_file_editing: true | false
  has_command_execution: true | false
  has_structured_output: true | false
  has_approval_prompts: true | false
```

The Queen uses this detection to select presets and skip roles that the runtime cannot execute.
