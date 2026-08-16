# Feature Build Example

## Scenario

A user requests adding a "remember me" checkbox to the login form.

## Run Contract

```yaml
run:
  goal: "Add remember-me checkbox to login form with session persistence"
  deliverables:
    - "Checkbox UI element on login form"
    - "Session token persistence when checked"
    - "Tests for new behavior"
  constraints:
    - "Do not modify existing auth token flow"
    - "Use existing session storage mechanism"
  exclusions:
    - "Social login"
    - "Password reset changes"
  success_criteria:
    - "Checkbox is visible and toggleable on login form"
    - "When checked, session persists beyond browser close"
    - "When unchecked, session expires on browser close"
    - "Remembered session does not expose credentials"
    - "All existing tests pass"
  approval_requirements: []
  execution_mode: standard
  maximum_fix_cycles: 2
  status: planning
```

## Council Flow

### 1. Queen
- **Preset:** Standard
- **Roles activated:** Scout → Architect → Forger → Sentinel → Scribe
- **Task classification:** Feature implementation

### 2. Scout
- Maps login component structure and auth flow
- Identifies that auth service uses localStorage vs sessionStorage
- Finds related tests
- **Context bundle** with file paths and existing pattern
- **Handoff:** complete, high confidence

### 3. Architect
- **Plan:** Add checkbox to form, store preference, conditionally use localStorage vs sessionStorage
- **Decision record:** Chose localStorage over cookie for simplicity; no server-side changes needed
- **Risk:** Low
- **Non-goals:** Do not redesign login page, do not change token format
- **Handoff:** complete

### 4. Forger
- Implements checkbox component, storage preference logic
- Updates existing auth service to check preference
- Writes tests for storage behavior
- Runs `npm test` — all pass
- **Handoff:** complete, 3 files changed

### 5. Sentinel
- **Static:** No issues
- **Tests:** 18 passed, 0 failed
- **Behavioral:** Checkbox renders, toggles, storage switches correctly
- **Safety:** No credentials stored by preference flag
- **Verdict:** PASS
- **Handoff:** complete

### 6. Scribe
- Updates README with new feature note
- **Handoff:** complete

### 7. Queen
- **Final status:** Complete
- **Result:** Remember-me checkbox added. Session persistence works correctly. All tests pass.
