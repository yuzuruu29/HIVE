# Test Generation Example

## Scenario

A user wants to add test coverage for a utility function that currently has no tests.

## Run Contract

```yaml
run:
  goal: "Add unit tests for calculateDiscount utility"
  deliverables:
    - "Test file covering happy path, edge cases, and error conditions"
  constraints:
    - "Do not modify the utility function itself"
    - "Use existing test framework and patterns"
  exclusions:
    - "Integration tests"
    - "Other utility functions"
  success_criteria:
    - "90%+ line coverage on calculateDiscount"
    - "All edge cases covered"
    - "Tests pass"
  approval_requirements: []
  execution_mode: quick
  maximum_fix_cycles: 1
  status: planning
```

## Council Flow

### 1. Queen
- **Preset:** Quick
- **Roles activated:** Scout → Forger → Sentinel → Scribe

### 2. Scout
- Reads the utility function
- Identifies input types, edge cases, and error paths
- Identifies existing test patterns in the project
- **Handoff:** complete

### 3. Forger
- Writes test file following existing patterns
- Covers: valid discounts, zero discount, maximum discount boundary, negative values, non-numeric input, null/undefined
- Runs `npm test` — all pass
- **Handoff:** complete

### 4. Sentinel
- **Tests:** All 12 test cases pass
- **Coverage:** 95% line coverage
- **Quality:** Edge cases covered, meaningful assertions
- **Verdict:** PASS
- **Handoff:** complete

### 5. Scribe
- No documentation changes needed
- **Handoff:** complete

### 6. Queen
- **Final status:** Complete
- **Result:** Full test coverage for calculateDiscount. 12 test cases covering all paths. 95% line coverage.
