# Changelog

All notable changes to agent-memory are documented here.

## 0.7.4 - 2026-09-23

- New memory plans track pinned template and task steps, phase transitions,
  evidence/review history, and selected user, retrieval, and PR-review events.
- Explicit amendments create successor plans without changing original scope;
  existing schema-1 plans remain readable and updatable.
- RSI projection maps plan/template trajectories with revision-linked witnesses.

## 0.2.0 - 2026-08-01

This is the first code-only release of the current agent-memory CLI. It is
published from fresh Git history and contains no user or agent memory corpus.

### Added

- Configurable memory categories with path-safe validation.
- Centralized configuration commands and multi-source indexing for memory,
  rules, and skills.
- BM25F field weighting across titles, descriptions, and section content.
- Structured command logging and a log viewer.
- Integration hooks for session start, compaction, and subagent workflows.
- `memory --version` for installed-version verification.

### Changed

- Git-backed writes verify the memory repository's branch rather than the
  caller's working directory.
- Concurrent push handling uses bounded retry behavior.
- Integration defaults and examples are portable across operators and hosts.

### Packaging

- Package metadata, the CLI, the tag, and release artifacts consistently use
  version `0.2.0`.
- CI validates Python 3.10 and 3.12 with Ruff, pytest, and package builds.
