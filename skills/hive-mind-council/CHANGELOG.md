# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — Machine-Readable Protocol and Adapter Conformance

### Added

- Versioned JSON Schemas for HIVE protocol artifacts
- Artifact and bundle validation CLI
- Runtime capability negotiation contract
- Adapter conformance levels and manifests
- Portable `.hive-run` artifact bundle format
- Negative, semantic, and mutation tests
- Cross-runtime live-validation methodology
- Generated adapter conformance report

### Changed

- Protocol, skill, schema, and artifact versions are tracked independently
- JSON Schemas are the canonical source for field names and enums
- Adapters now declare supported protocol versions and tested capabilities
- Examples and conformance fixtures are schema-validated

### Compatibility

- Existing Markdown workflows remain supported
- v0.2.x artifacts can be migrated by adding protocol and run identifiers
- Host-runtime execution and enforcement remain runtime-dependent

## [0.2.1] — Public-Readiness Hardening

### Added

- Product boundary document explaining the skill versus runtime distinction
- JSON-based protocol-conformance suite
- Reproducible OpenCode smoke-test documentation
- Anti-overclaim contract checks
- Thin-package CI validation

### Changed

- Public descriptions now identify the project as a portable council protocol
- Adapter documentation now explains host-runtime dependencies
- Repository assets are limited to installable skill code and lightweight branding
- Runtime smoke tests are separated from offline CI validation

### Removed

- Remotion promotional production project from the installable skill repository
- Large or generated promotional production artifacts

### Fixed

- Wording that could imply standalone runtime enforcement
- Ambiguous autonomy and multi-agent execution claims

## [0.2.0] — Capability Enhancement

### Added
- **Council protocol** — Shared run contract, evidence ledger, confidence labels, and stop conditions used by every role
- **Role contracts** — Formal input/output specifications, evidence requirements, failure handling, and bounded autonomy for all six roles
- **Handoff schema** — Standardized YAML/Markdown handoff format with status, findings, evidence, risks, and recommended next actions
- **Orchestration presets** — Four predefined configurations (Quick, Standard, Deep, Audit) with role selection and fix cycle limits
- **Verification policy** — Multi-layer validation (static, automated, behavioral, safety, portability), adversarial scenarios, and claim audit
- **Safety policy** — Permission levels (READ, WRITE, EXECUTE, NETWORK, GIT_MUTATE, DESTRUCTIVE), approval requirements, untrusted input policy, and file scope enforcement
- **Role operating modes** — Each role gains specialized operating modes (e.g., Scout: repository mapper, dependency tracer, failure investigator)
- **Task classification** — Queen now classifies tasks and selects the minimal council configuration
- **Decision records** — Architect documents design decisions with alternatives and consequences
- **HIVE Review** — Deterministic final review format with evidence references and follow-up tasks
- **Adapter protocol alignment** — All four adapters (Claude Code, Codex, OpenCode, Generic) now reference the same core contracts with capability detection

### Changed
- **SKILL.md** — Rewritten around shared run contract, orchestration presets, evidence rules, and safety model
- **Agent role files** — Each role upgraded with explicit capabilities, input/output contracts, evidence requirements, failure handling, bounded autonomy, and acceptance criteria
- **Templates** — New templates for run contract, role handoff, evidence ledger, and final review
- **.gitignore** — Added hive-ad build artifacts to prevent contamination

### Removed
- **Root playwright dependency** — Promotional asset generation dependencies no longer contaminate the core skill package

### Fixed
- **Scope enforcement** — Roles now verify file scope before modifications
- **Completion claims** — No role may claim completion without corresponding evidence
- **Unbounded loops** — Configurable maximum fix cycles prevent infinite repair loops

## [0.1.0] — Initial Release
- Empty initial release.

[0.3.0]: https://github.com/yuzuruu29/the-hive-skill/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/yuzuruu29/the-hive-skill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yuzuruu29/the-hive-skill/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuzuruu29/the-hive-skill/releases/tag/v0.1.0
