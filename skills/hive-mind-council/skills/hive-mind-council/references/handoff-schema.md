# Handoff Schema

Standard handoff schema used by every role when transferring control.

## Role Handoff

```yaml
handoff:
  role: queen | scout | architect | forger | sentinel | scribe
  status: complete | blocked | failed | needs_approval
  summary: string
  findings:
    - statement: string
      evidence: string
      confidence: high | medium | low
  files_examined:
    - path: string
      purpose: string
  files_changed:
    - path: string
      purpose: string
  commands_run:
    - command: string
      result: passed | failed | partial
      output_summary: string
  risks:
    - description: string
      severity: low | medium | high
  unresolved_questions:
    - question: string
      why_unresolved: string
  recommended_next_action: string
```

## Schema Rules

1. **status** must be one of the defined values. No custom statuses.
2. **findings** must include at least one entry. Each must include statement, evidence, and confidence.
3. **files_examined** may be empty only when the role did not examine any files (e.g., Queen synthesizing).
4. **files_changed** must be non-empty when status is `complete` and the role modifies files.
5. **commands_run** must note failure or partial results with output context.
6. **risks** should flag any concern that could affect downstream roles.
7. **unresolved_questions** must explain why each question could not be answered.
8. **recommended_next_action** must be a concrete, actionable instruction.

## Adapter Note

Hosts without structured output support must render the handoff as Markdown preserving all fields:

```markdown
## Handoff: <role>
**Status:** <status>
**Summary:** <summary>

### Findings
- <statement> (Evidence: <evidence>, Confidence: <confidence>)

### Files Examined
- <path> — <purpose>

### Files Changed
- <path> — <purpose>

### Commands Run
- `<command>` → <result>

### Risks
- <description> (Severity: <severity>)

### Unresolved Questions
- <question> — <why_unresolved>

### Recommended Next Action
<action>
```
