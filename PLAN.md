# omp-rsi port plan

Source: [vantasnerdan/memory-rsi](https://github.com/vantasnerdan/memory-rsi), MIT. Target: OMP v18 plugin marketplace. Keep the vendored Python agent-memory CLI and framework-independent RSI/graph logic; replace DSH registration, lifecycle, credential, installation, and prompt integrations with OMP extension APIs. No DSH package, profile, Cordis, prompt-renderer, or monkey-patch dependency may remain in the distributable plugin.

## Phase 1 — Native runtime and backend

- Vendor the upstream CLI with attribution and its substantive tests. Preserve the existing memory/plan/policy/RSI JSON contracts and schema; do not silently migrate user data.
- Establish one configuration module with OMP-local defaults (`~/.omp/agent/memory` and a private plugin runtime), explicit opt-ins for remote assessment and instruction discovery, and no embedded credentials. Backend subprocesses have bounded timeouts/cancellation; setup is explicit, never an install-time side effect.
- Port Python/ripgrep and graph-only GitNexus provisioning, backend readiness, bootstrap/migration preview/apply, and the existing graph safety constraints. Importing the extension neither installs dependencies nor modifies memory.
- Acceptance: CLI tests pass; explicit setup status/install/initialize work in an isolated HOME; graph commands remain graph-only; no existing policy or instruction file is overwritten.

## Phase 2 — OMP model tools

- Register the original memory discovery/search/write/maintenance, plan, policy, setup, and graph tools with `pi.registerTool`, OMP schemas/results/abort signals and appropriate approval boundaries. Separate read, write, contract, setup and graph registration by responsibility; share one CLI runner.
- Preserve action fields, validation, revision checks, bounded output, and Git behavior. Do not expose generic shell/Cypher or bypass the CLI's authorization checks.
- Acceptance: load via OMP's extension loader; exercise representative reads, writes, plan revisions, policy preview, setup and graph actions through actual OMP tool calls.

## Phase 3 — RSI and instruction lifecycle

- Keep the upstream TypeSafe System One transport, assessment/rubrics, map/reduce, trials, artifact lineage and promotion behavior. Adapt only host seams: environment credential reference; OMP `tool_result` telemetry without content/arguments; OMP instruction-stack capture with honest coverage; current-session identity; live policy injected through `before_agent_start` without mutating host internals.
- Remote assessment defaults off; automatic instruction discovery has its own opt-in. Incomplete or unavailable source coverage must be explicit and must not claim full-stack review. Preserve exact-source capture, selected-feedback provenance, approval-independent classifier outputs, revision-bound promotion and rollback.
- Acceptance: original RSI regressions plus OMP-specific telemetry, prompt refresh, audit coverage, opt-in, and proposal/promotion scenarios; no network request when disabled.

## Phase 4 — Marketplace and release verification

- Publish `.omp-plugin/marketplace.json` with `omp-rsi@marvin-marbell` and `package.json#omp.extensions` pointing to the OMP entry. Document the official flow: `omp plugin marketplace add marvin-marbell/omp-rsi`, `omp plugin install omp-rsi@marvin-marbell`, restart for extension tools, then explicit setup. No curl-pipe shell installer required.
- Validate marketplace add/discover/install in an isolated OMP profile, then run a real OMP session that calls setup, memory, plans, policy and RSI. Run the focused JS/Python suites and check the packed/installable tree for stale DSH imports and secrets.
- Publish one issue and linked PR per phase. PRs are sequential review units; do not claim the release usable until phase 4 passes. Request Axis's review by email at `axis@ideoon.eu`, referencing the actual PR URLs and GitHub `axis-marbell`.

## Architecture contracts

- `cli/`: upstream Python backend, with clear provenance; `lib/`: framework-independent upstream algorithms and subprocess/security helpers; `src/`: OMP-specific config, runner, tool registrars, prompt/discovery/telemetry, entrypoint.
- Configuration is resolved once per extension load. The model can select actions but cannot change opt-in flags or instruction-file allowlists. Paths and secrets are operator-owned; outputs are bounded.
- Tool registrars accept `(pi, config, dependencies)` and register directly with OMP; the shared runner has `memory(args, {signal,stdin,jsonOutput})` and returns stdout. RSI host receives `memory`, `signals`, `discover` and an environment-credential resolver; no imported DSH service.
- CLI source and JS logic may be copied under MIT; retain license and upstream attribution. Avoid duplicate business logic and adapter-shaped god files.
