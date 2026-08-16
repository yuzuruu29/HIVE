# OpenCode Installation

## Prerequisites
- OpenCode / OpenCode Go CLI installed and authenticated
- Node.js 18+ with `npx` available

## Install

```bash
# Install globally (available across projects)
npx skills add https://github.com/yuzuruu29/the-hive-skill.git --yes --global

# Or install for current project only
npx skills add https://github.com/yuzuruu29/the-hive-skill.git

# SSH alternative
npx skills add git@github.com:yuzuruu29/the-hive-skill.git --yes --global
```

## Verify

```bash
# Confirm the skill is available
ls ~/.config/opencode/skills/hive-mind-council/
```

## Usage

Invoke the skill by describing a task. The skill will automatically classify, plan, and execute the council workflow.

## Uninstall

```bash
rm -rf ~/.config/opencode/skills/hive-mind-council/
```
