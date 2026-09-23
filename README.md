# omp-rsi

Git-backed agent memory, shared plans, editable policy, graph-only GitNexus, and evidence-linked RSI for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). This is an OMP extension, not a DeepSeek Harness plugin. The [port plan](PLAN.md) records the architecture and phase boundaries.

## Install with OMP

On a POSIX system (or WSL on Windows) with OMP, Git, Python 3.10+ with `venv`, and npm for the optional graph backend:

```sh
omp plugin marketplace add marvin-marbell/omp-rsi
omp plugin install omp-rsi@marvin-marbell
```

Restart the OMP session so the extension loads. Adding the marketplace and installing the plugin do **not** install backend dependencies, initialize memory, migrate data, change instructions, or enable remote assessment.

In an interactive OMP session, ask the agent to call `memory_setup` in this order:

1. `{"action":"status"}` — inspect backend, memory, and graph readiness.
2. `{"action":"install","request":"{\"graph\":true}"}` — explicitly install the private Python CLI, ripgrep, and pinned graph-only GitNexus. Use `{"graph":false}` in the request to omit GitNexus. This action asks for interactive operator approval and refuses headless execution; package registries may be accessed.
3. `{"action":"initialize"}` — seed missing memory structure, templates, and policy without overwriting existing content. For a file-only memory base without Git, pass `"no_git":true` and use the same flag when checking status.
4. `{"action":"status"}` again to inspect the resulting readiness. Graph indexes are per selected project; use `gitnexus analyze` separately for each project you choose.

The plugin's default memory base is `~/.omp/agent/memory`; its private dependency runtime is `~/.omp/agent/plugins/omp-rsi/runtime`. It neither modifies global npm packages nor publishes memory without an explicit Git-backed action. Migration is separately previewed and revision-checked; no existing instruction file is synchronized automatically.

## Operator configuration and RSI opt-ins

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
