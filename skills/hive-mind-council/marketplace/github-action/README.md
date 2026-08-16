# GitHub Action — The Hive Skill

Installs The Hive Skill into any agentic coding environment as part of a CI/CD pipeline or automated setup workflow.

## Usage

```yaml
jobs:
  install-skill:
    runs-on: ubuntu-latest
    steps:
      - uses: yuzuruu29/the-hive-skill@v0.3.0
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `install-path` | `.agents/skills/hive-mind-council` | Target installation path |

## What it does

1. Creates the target directory
2. Copies all skill files (SKILL.md, agents, references, templates, examples)
3. Validates that SKILL.md exists
4. Validates that SKILL.md contains the correct skill name
5. Confirms installation

## Notes

- The GitHub Action copies the skill files only. Runtime configuration depends on the target agent.
- Use this action in dev container setups, template repositories, or CI/CD provisioning.
- See the main [README](https://github.com/yuzuruu29/the-hive-skill) for runtime-specific installation instructions.
