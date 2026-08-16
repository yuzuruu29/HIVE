# Council Loop

The council loop is driven by the orchestration presets defined in [orchestration-presets.md](../references/orchestration-presets.md).

## Loop Structure

```
LOOP START
[Queen] — Establish run contract, classify task, select preset
[Scout]* — Gather context bundle
[Architect]* — Produce executable plan with decision records
[Queen] — Review plan, approve or adjust scope
[Forger] — Implement with incremental checks
[Sentinel] — Validate across applicable layers
IF Sentinel fails AND fix cycles remain:
  Return to Forger for targeted repair
  Re-run Sentinel
IF Sentinel passes OR fix cycles exhausted:
  Continue to Scribe
[Scribe] — Generate HIVE Review, synchronize docs
[Queen] — Issue final decision
LOOP END
```

*Roles marked with `*` may be skipped by the Queen based on preset.

## Bounded Repair Cycle

```
Repair Cycle (max: configured in preset)
  1. Queen forwards Sentinel findings to Forger
  2. Forger repairs only the specific failure
  3. Sentinel re-validates
  4. If still failing, increment cycle counter
  5. If max cycles reached, Queen declares FAILED
```

## Evidence Checkpoints

Every handoff must include:
- Status (complete | blocked | failed | needs_approval)
- Findings with evidence and confidence
- Files examined and changed
- Commands run and results
- Risks and unresolved questions
