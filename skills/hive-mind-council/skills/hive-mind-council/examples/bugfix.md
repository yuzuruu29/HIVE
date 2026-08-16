# Bugfix Example

## Scenario

A user reports that a login form does not show error messages when invalid credentials are submitted.

## Run Contract

```yaml
run:
  goal: "Fix login form error message display"
  deliverables:
    - "Error messages visible on invalid credentials"
    - "Tests for error display behavior"
  constraints:
    - "Do not change authentication logic"
    - "Do not modify API endpoints"
  exclusions:
    - "Password reset flow"
    - "Registration form"
  success_criteria:
    - "Invalid credentials show error message in the form"
    - "Error message disappears on new input"
    - "Existing login tests still pass"
  approval_requirements: []
  execution_mode: standard
  maximum_fix_cycles: 2
  status: planning
```

## Council Flow

### 1. Queen
- **Preset:** Standard
- **Roles activated:** Scout → Architect → Forger → Sentinel → Scribe
- **Context bundle:** Pass to Scout

### 2. Scout
- Examines login component, checks error state handling
- Identifies that error state exists but is not rendered in the JSX
- Finds related test file with partial coverage
- **Handoff:** complete, high confidence

### 3. Architect
- **Plan:** Add error message JSX block to login form component, update test assertions
- **Risk:** Low (UI-only change, no auth logic touched)
- **File scope:** `src/components/LoginForm.tsx`, `src/components/LoginForm.test.tsx`
- **Non-goals:** Do not restyle the form, do not touch validation logic
- **Handoff:** complete

### 4. Forger
- Adds error message rendering with conditional visibility
- Adds test for error display and dismissal
- Runs `npm test -- LoginForm` — all pass
- **Handoff:** complete, 2 files changed

### 5. Sentinel
- **Static:** No lint or type errors
- **Tests:** `npm test` — 15 passed, 0 failed
- **Behavioral:** Renders error, dismisses on input, no regression in existing behavior
- **Safety:** No secrets, no scope violations
- **Verdict:** PASS
- **Handoff:** complete

### 6. Scribe
- Documents the fix
- Confirms no README or changelog update needed
- **Handoff:** complete

### 7. Queen
- **Final status:** Complete
- **Result:** Login form now displays error messages. Two files modified. All tests pass.
