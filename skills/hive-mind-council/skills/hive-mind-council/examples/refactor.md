# Refactor Example

## Scenario

A user wants to extract a shared utility function duplicated across three components.

## Run Contract

```yaml
run:
  goal: "Extract duplicate date formatting logic into shared utility"
  deliverables:
    - "New utility function in src/utils/formatDate.ts"
    - "Three components updated to import shared utility"
    - "Tests for utility function"
  constraints:
    - "Output format must remain identical"
    - "No new dependencies"
  exclusions:
    - "Other utility functions"
    - "Component redesign"
  success_criteria:
    - "All three components produce identical output"
    - "All existing tests pass"
    - "No duplicate code remains for date formatting"
  approval_requirements: []
  execution_mode: quick
  maximum_fix_cycles: 1
  status: planning
```

## Council Flow

### 1. Queen
- **Preset:** Quick (extraction is well-understood)
- **Roles activated:** Forger → Sentinel → Scribe
- **Rationale:** No architecture decisions needed, no investigation required

### 2. Forger
- Creates `src/utils/formatDate.ts` with the shared logic
- Updates three components to import and use the new function
- Adds unit tests for the utility
- Runs `npm test` — all pass
- **Handoff:** complete, 4 files changed

### 3. Sentinel
- **Static:** No issues
- **Tests:** All pass
- **Behavioral:** Output matches original in all three components
- **Safety:** No secrets, no scope violations
- **Verdict:** PASS
- **Handoff:** complete

### 4. Scribe
- Notes the refactor in changelog
- **Handoff:** complete

### 5. Queen
- **Final status:** Complete
- **Result:** Date formatting extracted to shared utility. Zero behavioral change. All tests pass.
