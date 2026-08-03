import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CONTRACT_SCHEMA_VERSION,
  createDefaultTaskContract,
  validateTaskContract,
  resolveGate,
  unsatisfiedRequiredGates,
  RISK_MINIMUM_GATES,
} from "../dist/coding/contracts.js";

import {
  EVIDENCE_SCHEMA_VERSION,
  createEvidenceLedger,
  addEvidence,
  canSatisfyGate,
  isPassingEvidence,
  isStaleEvidence,
  evidenceForGate,
  latestEvidenceForGate,
  invalidateEvidenceBySha,
  createCommandEvidence,
  createBuildEvidence,
  createTestEvidence,
  createScopeEvidence,
  createReviewEvidence,
  createShaEvidence,
  createAgentClaimedEvidence,
} from "../dist/coding/evidence.js";

import {
  FAILURE_ACTION_MAP,
  computeVerdict,
  classifyFailure,
  actionForFailure,
} from "../dist/coding/verdicts.js";

import {
  createHiveRunReport,
  formatHiveRunReportMarkdown,
} from "../dist/coding/report.js";

// ---------------------------------------------------------------------------
// Task contracts
// ---------------------------------------------------------------------------

test("Task contracts", async (t) => {
  await t.test("valid contract passes validation", () => {
    const contract = createDefaultTaskContract({
      objective: "Add a feature",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/feature.ts"],
    });
    const result = validateTaskContract(contract);
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  await t.test("empty objective fails validation", () => {
    const contract = createDefaultTaskContract({
      objective: "",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/feature.ts"],
    });
    const result = validateTaskContract(contract);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === "empty_objective"));
  });

  await t.test("duplicate gate IDs fail validation", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    // Manually add a duplicate gate
    contract.requiredBehaviors.push({ ...contract.requiredBehaviors[0] });
    const result = validateTaskContract(contract);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === "duplicate_gate_id"));
  });

  await t.test("contract without required gates fails validation", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    // Make all gates optional
    for (const gate of contract.requiredBehaviors) {
      gate.required = false;
    }
    const result = validateTaskContract(contract);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === "no_required_gates"));
  });

  await t.test("non-adaptive gates always define all gate types", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["node --version"],
    });
    // Non-adaptive: all gate types are always present
    const gateIds = contract.requiredBehaviors.map((b) => b.id);
    assert.ok(gateIds.includes("gate-build-pass"));
    assert.ok(gateIds.includes("gate-typecheck-pass"));
    assert.ok(gateIds.includes("gate-tests-pass"));
    assert.ok(gateIds.includes("gate-scope-verified"));
    assert.ok(gateIds.includes("gate-reviewer-approved"));
  });

  await t.test("contract with build command includes build gate", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm run build", "npm test"],
    });
    const gateIds = contract.requiredBehaviors.map((b) => b.id);
    assert.ok(gateIds.includes("gate-build-pass"));
    assert.ok(gateIds.includes("gate-tests-pass"));
    assert.ok(gateIds.includes("gate-typecheck-pass"));
  });

  await t.test("scope and reviewer gates are always required (risk minimum)", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const scopeGate = contract.requiredBehaviors.find((b) => b.id === "gate-scope-verified");
    const reviewerGate = contract.requiredBehaviors.find((b) => b.id === "gate-reviewer-approved");
    assert.equal(scopeGate.required, true);
    assert.equal(reviewerGate.required, true);
  });

  await t.test("evidence applicability marks unused commands as not_applicable", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm test"],
    });
    const buildEvidence = contract.requiredEvidence.find((e) => e.id === "evidence-build");
    const testEvidence = contract.requiredEvidence.find((e) => e.id === "evidence-tests");
    assert.equal(buildEvidence.applicability, "not_applicable");
    assert.equal(testEvidence.applicability, "required");
  });

  await t.test("risk minimum gates are enforced at all risk levels", () => {
    for (const riskLevel of ["low", "medium", "high", "critical"]) {
      const contract = createDefaultTaskContract({
        objective: "Test",
        repositoryRoot: "/repo",
        baseCommit: "abc123",
        allowedPaths: ["src/a.ts"],
        riskLevel,
      });
      const minimumGates = RISK_MINIMUM_GATES[riskLevel];
      for (const gateId of minimumGates) {
        const gate = contract.requiredBehaviors.find((b) => b.id === gateId);
        assert.ok(gate, `Gate ${gateId} should exist for risk ${riskLevel}`);
        assert.equal(gate.required, true, `Gate ${gateId} should be required for risk ${riskLevel}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence-derived gate resolution
// ---------------------------------------------------------------------------

test("Evidence-derived gate resolution", async (t) => {
  await t.test("resolveGate returns pending when no evidence exists", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");
    const state = resolveGate("gate-scope-verified", ledger, contract);
    assert.equal(state, "pending");
  });

  await t.test("resolveGate returns satisfied when passing evidence exists", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, {
      ...createScopeEvidence({
        sourceRole: "queen",
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/a.ts"],
        violations: [],
      }),
      gateId: "gate-scope-verified",
    });
    const state = resolveGate("gate-scope-verified", ledger, contract);
    assert.equal(state, "satisfied");
  });

  await t.test("resolveGate returns failed when failing evidence exists", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, {
      ...createScopeEvidence({
        sourceRole: "queen",
        changedFiles: ["src/a.ts", ".env"],
        allowedPaths: ["src/a.ts"],
        violations: [".env"],
      }),
      gateId: "gate-scope-verified",
    });
    const state = resolveGate("gate-scope-verified", ledger, contract);
    assert.equal(state, "failed");
  });

  await t.test("resolveGate returns unavailable when all evidence is invalidated", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, {
      ...createScopeEvidence({
        sourceRole: "queen",
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/a.ts"],
        violations: [],
      }),
      gateId: "gate-scope-verified",
      repositorySha: "abc123",
    });
    invalidateEvidenceBySha(ledger, "abc123", "Repository changed");
    const state = resolveGate("gate-scope-verified", ledger, contract);
    assert.equal(state, "unavailable");
  });

  await t.test("resolveGate returns pending when only agent-claimed evidence exists", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, {
      ...createAgentClaimedEvidence({
        sourceRole: "builder",
        claim: "All tests pass",
      }),
      gateId: "gate-tests-pass",
    });
    const state = resolveGate("gate-tests-pass", ledger, contract);
    assert.equal(state, "pending");
  });

  await t.test("unsatisfiedRequiredGates uses evidence-derived resolution", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");

    // Satisfy scope gate via evidence
    addEvidence(ledger, {
      ...createScopeEvidence({
        sourceRole: "queen",
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/a.ts"],
        violations: [],
      }),
      gateId: "gate-scope-verified",
    });

    const unsatisfied = unsatisfiedRequiredGates(contract, ledger);
    assert.ok(!unsatisfied.some((g) => g.id === "gate-scope-verified"));
    assert.ok(unsatisfied.length > 0); // reviewer-approved still unsatisfied
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("Evidence ledger", async (t) => {
  await t.test("AGENT_CLAIMED cannot satisfy gates", () => {
    assert.equal(canSatisfyGate("AGENT_CLAIMED"), false);
    assert.equal(canSatisfyGate("UNAVAILABLE"), false);
    assert.equal(canSatisfyGate("SKIPPED"), false);
    assert.equal(canSatisfyGate("PASSED"), true);
    assert.equal(canSatisfyGate("EXECUTED"), true);
    assert.equal(canSatisfyGate("OBSERVED"), true);
  });

  await t.test("executed passing command can satisfy a gate", () => {
    const ledger = createEvidenceLedger("test-session");
    const evidence = addEvidence(ledger, createCommandEvidence({
      sourceRole: "validator",
      command: "npm test",
      exitCode: 0,
    }));
    assert.equal(evidence.status, "PASSED");
    assert.equal(canSatisfyGate(evidence.status), true);
    assert.equal(isPassingEvidence(evidence.status), true);
  });

  await t.test("failed command blocks acceptance", () => {
    const ledger = createEvidenceLedger("test-session");
    const evidence = addEvidence(ledger, createCommandEvidence({
      sourceRole: "validator",
      command: "npm test",
      exitCode: 1,
    }));
    assert.equal(evidence.status, "FAILED");
    assert.equal(isStaleEvidence(evidence), false);
  });

  await t.test("stale evidence is invalidated", () => {
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, createShaEvidence({
      sourceRole: "queen",
      sha: "abc123",
      branch: "main",
    }));
    addEvidence(ledger, createBuildEvidence({
      sourceRole: "validator",
      exitCode: 0,
      repositorySha: "abc123",
    }));
    assert.equal(ledger.records.length, 2);
    const invalidated = invalidateEvidenceBySha(ledger, "abc123", "Repository changed");
    assert.equal(invalidated, 2);
    assert.equal(ledger.records.every((e) => !e.valid), true);
    assert.equal(ledger.records[0].invalidationReason, "Repository changed");
  });

  await t.test("evidenceForGate returns only valid evidence for gate", () => {
    const ledger = createEvidenceLedger("test-session");
    addEvidence(ledger, { ...createBuildEvidence({ sourceRole: "validator", exitCode: 0 }), gateId: "gate-build-pass" });
    addEvidence(ledger, { ...createBuildEvidence({ sourceRole: "validator", exitCode: 1 }), gateId: "gate-build-pass", valid: false });
    const matching = evidenceForGate(ledger, "gate-build-pass");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].valid, true);
  });

  await t.test("agent-claimed evidence is properly tagged", () => {
    const claim = createAgentClaimedEvidence({
      sourceRole: "builder",
      claim: "All tests pass",
    });
    assert.equal(claim.status, "AGENT_CLAIMED");
    assert.equal(canSatisfyGate(claim.status), false);
  });

  await t.test("scope evidence records violations", () => {
    const evidence = createScopeEvidence({
      sourceRole: "queen",
      changedFiles: ["src/a.ts", ".env"],
      allowedPaths: ["src/"],
      violations: [".env"],
    });
    assert.equal(evidence.status, "FAILED");
    assert.ok(evidence.summary.includes(".env"));
  });

  await t.test("review evidence records approval", () => {
    const evidence = createReviewEvidence({
      sourceRole: "reviewer",
      approved: true,
      findings: [],
    });
    assert.equal(evidence.status, "PASSED");
    assert.equal(evidence.gateId, "gate-reviewer-approved");
  });
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

test("Verdict computation", async (t) => {
  await t.test("full evidence produces ACCEPTED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm test"],
    });
    const ledger = createEvidenceLedger("test-session");

    // Add evidence for all gates (this is what the orchestrator records)
    addEvidence(ledger, {
      ...createScopeEvidence({ sourceRole: "queen", changedFiles: ["src/a.ts"], allowedPaths: ["src/a.ts"], violations: [] }),
      gateId: "gate-scope-verified",
    });
    addEvidence(ledger, {
      ...createTestEvidence({ sourceRole: "validator", exitCode: 0 }),
      gateId: "gate-tests-pass",
    });
    addEvidence(ledger, {
      ...createReviewEvidence({ sourceRole: "reviewer", approved: true, findings: [] }),
      gateId: "gate-reviewer-approved",
    });
    addEvidence(ledger, {
      ...createCommandEvidence({ sourceRole: "queen", command: "integrated-validation", exitCode: 0 }),
      gateId: "gate-integrated-validation",
    });

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      reviewerApproved: true,
    });
    assert.equal(verdict.verdict, "ACCEPTED");
  });

  await t.test("unsatisfied gates without reviewer produces REJECTED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm test"],
    });
    const ledger = createEvidenceLedger("test-session");

    // Only add scope evidence, not tests or reviewer
    addEvidence(ledger, {
      ...createScopeEvidence({ sourceRole: "queen", changedFiles: ["src/a.ts"], allowedPaths: ["src/a.ts"], violations: [] }),
      gateId: "gate-scope-verified",
    });

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      reviewerApproved: false,
    });
    // Without reviewer approval, verdict is REJECTED (not REPAIRABLE)
    assert.equal(verdict.verdict, "REJECTED");
  });

  await t.test("unsatisfied test gate with reviewer approval produces REPAIRABLE", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm test"],
    });
    const ledger = createEvidenceLedger("test-session");

    // Satisfy scope and reviewer, but not tests
    addEvidence(ledger, {
      ...createScopeEvidence({ sourceRole: "queen", changedFiles: ["src/a.ts"], allowedPaths: ["src/a.ts"], violations: [] }),
      gateId: "gate-scope-verified",
    });
    addEvidence(ledger, {
      ...createReviewEvidence({ sourceRole: "reviewer", approved: true, findings: [] }),
      gateId: "gate-reviewer-approved",
    });

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      reviewerApproved: true,
    });
    assert.equal(verdict.verdict, "REPAIRABLE");
    assert.ok(verdict.unsatisfiedGates.includes("gate-tests-pass"));
  });

  await t.test("scope violation produces REJECTED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");

    addEvidence(ledger, createScopeEvidence({
      sourceRole: "queen",
      changedFiles: ["src/a.ts", "etc/passwd"],
      allowedPaths: ["src/a.ts"],
      violations: ["etc/passwd"],
    }));

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
    });
    assert.equal(verdict.verdict, "REJECTED");
  });

  await t.test("missing infrastructure produces BLOCKED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      isInfrastructureBlocked: true,
    });
    assert.equal(verdict.verdict, "BLOCKED");
  });

  await t.test("cancellation produces BLOCKED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      isCancelled: true,
    });
    assert.equal(verdict.verdict, "BLOCKED");
  });

  await t.test("critical safety violation produces REJECTED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
    });
    const ledger = createEvidenceLedger("test-session");

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      hasCriticalSafetyViolation: true,
    });
    assert.equal(verdict.verdict, "REJECTED");
  });

  await t.test("budget exhausted with unsatisfied gates produces REJECTED", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      budget: { maxRepairAttempts: 2 },
    });
    const ledger = createEvidenceLedger("test-session");

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 2,
      reviewerApproved: false,
    });
    assert.equal(verdict.verdict, "REJECTED");
  });

  await t.test("agent-claimed evidence does not satisfy gates", () => {
    const contract = createDefaultTaskContract({
      objective: "Test",
      repositoryRoot: "/repo",
      baseCommit: "abc123",
      allowedPaths: ["src/a.ts"],
      validationCommands: ["npm test"],
    });
    const ledger = createEvidenceLedger("test-session");

    // Add agent-claimed evidence for all gates
    addEvidence(ledger, {
      ...createAgentClaimedEvidence({ sourceRole: "builder", claim: "All tests pass" }),
      gateId: "gate-tests-pass",
    });
    addEvidence(ledger, {
      ...createAgentClaimedEvidence({ sourceRole: "builder", claim: "Scope verified" }),
      gateId: "gate-scope-verified",
    });
    addEvidence(ledger, {
      ...createAgentClaimedEvidence({ sourceRole: "builder", claim: "Reviewer approved" }),
      gateId: "gate-reviewer-approved",
    });

    const verdict = computeVerdict(contract, ledger, {
      repairAttemptsUsed: 0,
      reviewerApproved: false,
    });
    // Agent-claimed evidence should not satisfy gates
    assert.equal(verdict.verdict, "REJECTED");
    assert.ok(verdict.unsatisfiedGates.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

test("Failure taxonomy", async (t) => {
  await t.test("all failure classes have deterministic actions", () => {
    for (const [failureClass, action] of Object.entries(FAILURE_ACTION_MAP)) {
      assert.ok(action, `${failureClass} must have an action`);
      assert.equal(actionForFailure(failureClass), action);
    }
  });

  await t.test("classifyFailure detects build failures", () => {
    assert.equal(classifyFailure({ description: "build failed" }), "BUILD_FAILURE");
    assert.equal(classifyFailure({ description: "typecheck error" }), "TYPECHECK_FAILURE");
    assert.equal(classifyFailure({ description: "test suite failed" }), "TEST_FAILURE");
  });

  await t.test("classifyFailure detects scope violations", () => {
    assert.equal(classifyFailure({ description: "anything", isScopeViolation: true }), "SCOPE_VIOLATION");
    assert.equal(classifyFailure({ description: "anything", isProtectedPath: true }), "PROTECTED_PATH_VIOLATION");
  });

  await t.test("classifyFailure detects infrastructure issues", () => {
    assert.equal(classifyFailure({ description: "anything", isInfrastructure: true }), "INFRASTRUCTURE_BLOCKER");
    assert.equal(classifyFailure({ description: "anything", isTimeout: true }), "PROVIDER_TIMEOUT");
    assert.equal(classifyFailure({ description: "anything", isCancelled: true }), "CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test("Reports", async (t) => {
  await t.test("JSON report is deterministic", () => {
    const session = {
      schemaVersion: 1,
      id: "test-session",
      objective: "Test objective",
      mode: "auto",
      approvalPolicy: "changes",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      repository: { root: "/repo", capturedAt: "2026-01-01T00:00:00.000Z", dirty: false, changedFiles: [] },
      tasks: [],
      events: [],
      providerBindings: [],
      validationResults: [],
      reviewResults: [],
      files: [],
      verdict: "ACCEPTED",
      failures: [],
      integrations: [],
    };
    const report1 = createHiveRunReport(session);
    const report2 = createHiveRunReport(session);
    assert.deepEqual(report1, report2);
  });

  await t.test("report includes verdict", () => {
    const session = {
      schemaVersion: 1,
      id: "test-session",
      objective: "Test objective",
      mode: "auto",
      approvalPolicy: "changes",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      repository: { root: "/repo", capturedAt: "2026-01-01T00:00:00.000Z", dirty: false, changedFiles: [] },
      tasks: [],
      events: [],
      providerBindings: [],
      validationResults: [],
      reviewResults: [],
      files: [],
      verdict: "ACCEPTED",
      finalReport: { verdict: "ACCEPTED", verdictReasons: ["All gates satisfied"] },
      failures: [],
      integrations: [],
    };
    const report = createHiveRunReport(session);
    assert.equal(report.outcome.verdict, "ACCEPTED");
  });

  await t.test("report includes failure history", () => {
    const session = {
      schemaVersion: 1,
      id: "test-session",
      objective: "Test",
      mode: "auto",
      approvalPolicy: "changes",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      repository: { root: "/repo", capturedAt: "2026-01-01T00:00:00.000Z", dirty: false, changedFiles: [] },
      tasks: [],
      events: [],
      providerBindings: [],
      validationResults: [],
      reviewResults: [],
      files: [],
      verdict: "ACCEPTED",
      failures: [{
        failureClass: "TEST_FAILURE",
        attemptNumber: 1,
        actionTaken: "invoke_fixer",
        repairSucceeded: true,
        description: "Tests failed",
        timestamp: "2026-01-01T00:00:30.000Z",
      }],
      integrations: [],
    };
    const report = createHiveRunReport(session);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].failureClass, "TEST_FAILURE");
  });

  await t.test("markdown report includes all sections", () => {
    const session = {
      schemaVersion: 1,
      id: "test-session",
      objective: "Test",
      mode: "auto",
      approvalPolicy: "changes",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      repository: { root: "/repo", capturedAt: "2026-01-01T00:00:00.000Z", dirty: false, changedFiles: [] },
      tasks: [],
      events: [],
      providerBindings: [],
      validationResults: [],
      reviewResults: [],
      files: [],
      verdict: "ACCEPTED",
      finalReport: {
        verdict: "ACCEPTED",
        finalSha: "abc123",
        evidenceSummary: [{
          id: "ev-1",
          gateId: "gate-scope-verified",
          category: "scope_verification",
          status: "PASSED",
          summary: "All files in scope",
          valid: true,
        }],
      },
      failures: [{
        failureClass: "TEST_FAILURE",
        attemptNumber: 1,
        actionTaken: "invoke_fixer",
        description: "Tests failed",
        timestamp: "2026-01-01T00:00:30.000Z",
      }],
      integrations: [{
        integratedSha: "abc123",
        integratedFiles: ["src/a.ts"],
        hadConflicts: false,
        timestamp: "2026-01-01T00:00:45.000Z",
      }],
    };
    const report = createHiveRunReport(session);
    const markdown = formatHiveRunReportMarkdown(report);
    assert.ok(markdown.includes("ACCEPTED"));
    assert.ok(markdown.includes("Acceptance gates"));
    assert.ok(markdown.includes("Evidence ledger"));
    assert.ok(markdown.includes("Failure history"));
    assert.ok(markdown.includes("Integration history"));
    assert.ok(markdown.includes("Repository state"));
    assert.ok(markdown.includes("abc123"));
  });

  await t.test("unknown cost represented honestly", () => {
    const session = {
      schemaVersion: 1,
      id: "test-session",
      objective: "Test",
      mode: "auto",
      approvalPolicy: "changes",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      repository: { root: "/repo", capturedAt: "2026-01-01T00:00:00.000Z", dirty: false, changedFiles: [] },
      tasks: [],
      events: [],
      providerBindings: [],
      validationResults: [],
      reviewResults: [],
      files: [],
    };
    const report = createHiveRunReport(session);
    assert.equal(report.usage.providerCost.provenance, "unavailable");
    assert.equal(report.usage.totalEstimatedCost.provenance, "unavailable");
  });
});
