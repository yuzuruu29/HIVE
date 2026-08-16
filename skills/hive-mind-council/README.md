# The Hive Skill

The Hive Skill is a portable six-role council protocol for agentic coding hosts. It provides structured handoffs, evidence rules, safety boundaries, orchestration presets, bounded repair cycles, and explicit stop conditions for Claude Code, Codex, OpenCode, and generic agents.

The Hive Skill is built to be invoked once and trusted to continue until the task is completed, validated, or blocked by a clear stop condition.

v0.3.0 provides a disciplined orchestration protocol with structured handoffs, evidence requirements, bounded repair cycles, and explicit stop conditions. Real multi-model execution depends on the runtime.

> **Read first:** [What this is and is not](WHAT_THIS_IS.md) explains the boundary between the portable skill and the full HIVE runtime.

## Demo

[![The Hive Skill demo](assets/demo/the-hive-skill-demo.gif)](assets/demo/the-hive-skill-demo.mp4)

**Watch the cinematic demo video** — a scripted council processes a real bugfix
end-to-end with structured handoffs, confidence labels, and explicit stop
conditions.

The Hive Skill instructs one host coding agent to operate through a six-role council.

## Supported Runtimes
- OpenCode / OpenCode Go
- Claude Code
- Codex
- Generic `.agents` workflows

## Installation

### 🔗 Marketplace

```powershell
/plugin marketplace add yuzuruu29/the-hive-skill
/plugin install hive-mind-council@the-hive-skill
```

### Recommended: HTTPS installation

Use HTTPS for public installs on Windows. The repository is public, so you do not need a GitHub SSH key, and this avoids SSH host-key verification errors.

```powershell
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global
```

Use `--global` when you want the skill available across projects. The Skills CLI installs to your user directory with `--global` and to the current project by default without it.

### Interactive installation

Use this when you want to review the installation prompts before anything is written.

```powershell
npx skills add https://github.com/yuzuruu29/the-hive-skill.git
```

Omit `--yes` when you want to keep the install interactive.

### Local installation

```powershell
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes
```

Use this when you want the skill installed for the current project only. The Skills CLI uses the current project scope by default, while `--global` installs to your user directory for use across projects.

### SSH installation for advanced users

```powershell
npx skills add git@github.com:yuzuruu29/the-hive-skill.git --yes --global
```

SSH requires Git to be installed, a GitHub SSH key to be configured, and GitHub to be present in your local `known_hosts` file.

### Troubleshooting: Host key verification failed

```powershell
ssh-keygen -R github.com
ssh -T git@github.com
```

When `ssh -T` prompts you to trust GitHub's host key, type:

```text
yes
```

Then retry the installation command.

`Host key verification failed` means Git could not trust GitHub's SSH host identity.

`Permission denied (publickey)` means the host is trusted, but your SSH key is missing or not configured correctly.

Public users should use the HTTPS installation command instead of configuring SSH unless they specifically need SSH.

## Protocol Autonomy

Once invoked, The Hive Skill instructs the host agent to continue the council workflow until the goal is completed, partially completed, blocked, or failed.

The host runtime executes every role step. Real subagents, parallelism, model separation, and tool isolation depend on that runtime.

Example:
Use The Hive Skill to fix the failing login flow.
The protocol directs the host agent to:
1. Inspect relevant files.
2. Find the likely cause.
3. Plan the smallest safe fix.
4. Implement the change.
5. Run validation.
6. Fix validation failures.
7. Produce a final report.

## Token Efficient by Design

The Hive Skill avoids unnecessary context usage by default.
It uses:
- Targeted file inspection
- Compact role outputs
- Minimal planning overhead
- Reused findings
- Short state summaries
- Focused validation loops

This makes it practical for long coding sessions and agentic tools with limited context windows.

## Role Table

| Role | Responsibility | Reference |
|---|---|---|---|
| **Queen** | Orchestrates the council, classifies tasks, manages progress, enforces scope, makes final decisions | [Queen.md](skills/hive-mind-council/agents/Queen.md) |
| **Scout** | Maps repository, analyzes change impact, detects contradictions, delivers context bundle | [Scout.md](skills/hive-mind-council/agents/Scout.md) |
| **Architect** | Creates executable plans, makes design decisions, classifies risk, assigns file scope | [Architect.md](skills/hive-mind-council/agents/Architect.md) |
| **Forger** | Implements within assigned scope, runs incremental checks, classifies failures, produces patch manifest | [Forger.md](skills/hive-mind-council/agents/Forger.md) |
| **Sentinel** | Validates across multiple layers, audits claims, runs adversarial scenarios, returns verdict | [Sentinel.md](skills/hive-mind-council/agents/Sentinel.md) |
| **Scribe** | Synchronizes documentation, generates HIVE Review, prepares release evidence | [Scribe.md](skills/hive-mind-council/agents/Scribe.md) |

## Release Status
Current version: v0.3.0

## License
Licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.

## Security Warning
Please review the [SECURITY.md](SECURITY.md) file before using or contributing to this project.
