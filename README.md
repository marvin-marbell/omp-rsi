# omp-rsi

Git-backed agent memory, shared plans, editable policy, graph-only GitNexus, and evidence-linked RSI for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). This is an OMP extension, not a DeepSeek Harness plugin. The [port plan](PLAN.md) records the architecture and phase boundaries.

## Install with OMP

On a POSIX system (or WSL on Windows) with OMP, Git, Python 3.10+ with `venv`, and npm for the optional graph backend:

```sh
omp plugin marketplace add marvin-marbell/omp-rsi
omp plugin install omp-rsi@marvin-marbell
```

For a repeat setup, run `omp plugin marketplace list` and `omp plugin list` first. Skip `marketplace add` if `marvin-marbell` is listed, and skip `plugin install` if `omp-rsi@marvin-marbell` is listed. OMP treats repeating either command as an error; use `omp plugin upgrade omp-rsi@marvin-marbell` for a newer release instead of force-reinstalling during setup.

Restart the OMP session so the extension loads. Adding the marketplace and installing the plugin do **not** install backend dependencies, initialize memory, migrate data, change instructions, or enable remote assessment.

In an interactive OMP session, ask the agent to call `memory_setup` in this order:

1. `{"action":"status"}` — inspect backend, memory, and graph readiness.
2. `{"action":"install","request":"{\"graph\":true}"}` — explicitly install the private Python CLI, ripgrep, and pinned graph-only GitNexus. Use `{"graph":false}` in the request to omit GitNexus. This action asks for interactive operator approval and refuses headless execution; package registries may be accessed.
3. `{"action":"initialize"}` — seed missing memory structure, templates, and policy without overwriting existing content. For a file-only memory base without Git, pass `"no_git":true` and use the same flag when checking status.
4. `{"action":"status"}` again to inspect the resulting readiness. Graph indexes are per selected project; use `gitnexus analyze` separately for each project you choose.

If a different OMP session performs `install`, restart any sessions that were already open: their executable paths were resolved before installation and their status may remain stale. The installing session updates its own paths immediately.

The plugin's default memory base is `~/.omp/agent/memory`; its private dependency runtime is `~/.omp/agent/plugins/omp-rsi/runtime`. It neither modifies global npm packages nor publishes memory without an explicit Git-backed action. Migration is separately previewed and revision-checked; no existing instruction file is synchronized automatically.

## Operator configuration and RSI opt-ins
OMP **Settings → Plugins → omp-rsi@marvin-marbell** exposes the memory base, agent ID, and three independent opt-in switches below. Changes are stored by OMP in its plugin settings and take effect when you restart OMP. `base` must be an absolute path. The TypeSafe key is **not** a plugin setting: OMP masks secret fields in its UI but persists their values in a plugin lockfile, so never paste a credential there. Supply `TYPESAFE_API_KEY` through the OMP process environment (for example, an operator-managed secret store) before starting OMP. Enabling TypeSafe alone never sends data; an explicit assessment request is required.

When both user plugin settings and `OMP_RSI_CONFIG` supply the same field, the user setting wins. Project `plugin-overrides.json` settings are intentionally ignored by this extension: OMP loads project files without an operator trust prompt, so a checked-out repository must not enable remote TypeSafe assessments or redirect memory. Use an operator-selected `OMP_RSI_CONFIG` for a project-specific configuration. Restart the session after changes; settings are loaded once at startup.

Configuration is optional and loaded once when the extension starts. To change defaults, create an operator-owned, regular JSON file at an absolute path and set `OMP_RSI_CONFIG` **before** starting OMP:

```sh
OMP_RSI_CONFIG=/absolute/path/to/omp-rsi.json omp
```

For example, a file-only setup can select a memory base and agent ID:

```json
{
  "base": "/absolute/path/to/memory",
  "agentId": "my-agent"
}
```

`base`, `runtimeDir`, and entries in `instructionFiles` must be absolute paths. The config file must not be a symlink or hard link and is limited to 64 KiB. Instruction-file targets are operator-selected; managed policy sync preserves unmanaged text and requires an explicit preview/apply workflow.

These flags are **independent and false by default**:

- `typesafeEnabled`: permits explicitly requested TypeSafe System One assessments. Set the `TYPESAFE_API_KEY` environment variable separately; never put the key in the JSON file or repository. Without the flag, no TypeSafe request is made.
- `rsiInstructionDiscoveryEnabled`: permits automatic local capture of the current effective prompt, configured instruction files, and visible active OMP skill bodies. Coverage reports omissions and process-global skill scope. This flag alone does not enable remote assessment; with both this and `typesafeEnabled`, selected source bodies may be sent to the configured TypeSafe endpoint during an explicit audit.
- `rsiTelemetryEnabled`: collects current-session tool-result **metadata only**, not arguments or output, for explicitly requested local observation.

Use `memory_rsi` with `{"action":"status"}` to inspect the configured RSI state. Assessments, classifier labels, and actor strings are not approvals; policy changes and promotion remain explicit and revision-bound. No automatic audit applies changes or publishes instruction snapshots.

Source: [vantasnerdan/memory-rsi](https://github.com/vantasnerdan/memory-rsi), MIT; see [LICENSE](LICENSE).

## Durable tasks and RSI trajectories

For work that produces a lasting artifact, multi-step implementation, consequential decision, or reusable lesson, use memory as the task tracker: `memory_setup status`, `memory_plan templates`, `memory_plan review`, then `memory_plan create` before implementation. Quick chat and transient checks need no plan. A new plan pins its template and starts in `planning`; template and task steps are individually tracked. `memory_plan append_event` records phase/step transitions or bounded selected steering, retrieval, and PR-review summaries with an exact reference and an explicitly *reported* cause. `memory_plan update` automatically records scoped evidence, review, and work-item transitions. A changed task scope uses `memory_plan amend` to create a successor; the original plan and its pinned requirements remain unchanged. Existing schema-1 plans stay readable/updatable; amend one to start a schema-2 successor.

The creating OMP session binds the new plan. `memory_plan bind` with `{"plan_id":"..."}` resumes an existing plan; `unbind` clears the session binding. OMP stores only the plan ID in the session branch and re-reads the latest revision for the next prompt. A completed plan is not a new-task plan. Subagents should receive the shared ID, revision, template revision, and assigned work items; evidence is reviewed separately from its report. Focused reusable lessons go into ordinary long-term memory, not duplicate task logs.

`memory_rsi corpus` with `{"kind":"plans"}` discovers stored plan revisions without requiring the agent to first name a mistake. `memory_rsi preview` with `{"kind":"plans","source_id":"...","unit":0}` shows one exact projected state and typed questions **locally**, without assessment or persistence; inspect each unit and its source before `mine`. Explicit `mine` maps selected plan/template/requirement/event units; `reduce` groups linked hypotheses, independent task families, counterexamples, and owner routes. `memory_rsi observe` captures current-session tool-result metadata on explicit request when telemetry is enabled. `memory_rsi review_observe` records only caller-selected `{plan_id,repository,pr_number,head_sha,review_id,review_commit,review_state,summary}` as a separate local observation. The latter does not fetch or authenticate GitHub reviews; compare the selected review commit to the current PR head before relying on an approval, then preview and explicitly mine the observation only if its summary is safe to disclose. Event causes and review counts remain self-reported provenance, never proof of agent fault. Revised sources must be remapped; older mapping/insight artifacts use the prior rubric and cannot be reduced as current roots.

Remote TypeSafe requires both an operator-enabled `typesafeEnabled` setting and an explicit `memory_rsi` assessment action. For trajectory `mine`, inspect the exact local `preview` payload first; preview grants no permission or assurance about content. Prompt preparation, plan creation, and amendment make no remote requests; `preflight` is a separate explicit assessment. Selected event text is persisted in the operator's memory Git repository and follows its retention/sync policy, so use bounded, nonsecret summaries and references, not raw transcripts or PR payloads. Tool-result telemetry remains metadata-only and needs its own opt-in; no hidden reasoning is available. PR feedback and user steering enter a plan only through explicit, selected events; an external change is not an agent error.
