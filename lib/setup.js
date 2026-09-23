import { dirname, delimiter, isAbsolute } from "node:path";
import { backendStatus, localAgentId, safeDirectory } from "./runtime.js";
import { runProcess } from "./process.js";
import { gitnexusStatus } from "./gitnexus.js";

export function memoryEnvironment(config) {
	return {
		...process.env,
		PYTHONUNBUFFERED: "1",
		AGENT_ID: localAgentId(config),
		...(config.base ? { AGENT_MEMORY_PATH: config.base } : {}),
		PATH: isAbsolute(config.memoryBin || "") ? `${dirname(config.memoryBin)}${delimiter}${process.env.PATH || ""}` : process.env.PATH,
	};
}

export async function bootstrapRequest(config, request, { signal, noGit = false } = {}) {
	const argv = ["bootstrap", "--request", "-", "--base", config.base, "--agent-id", localAgentId(config)];
	for (const file of config.instructionFiles ?? []) argv.push("--instruction-file", file);
	if (noGit) argv.push("--no-git");
	const options = { stdin: JSON.stringify(request), env: memoryEnvironment(config), signal, timeoutMs: config.timeoutMs ?? 60000 };
	let result;
	try { result = await runProcess(config.memoryBin || "memory", argv, options); }
	catch (error) {
		if (error.code !== "ENOENT") throw error;
		result = await runProcess(config.pythonBin || "python3", ["-m", "agent_memory", ...argv], options);
	}
	return JSON.parse(result.stdout);
}

export async function setupStatus(config, { signal, noGit = false } = {}) {
	const backend = await backendStatus(config, { signal });
	const graph = await gitnexusStatus(config, { signal });
	let memory = null;
	if (backend.backendReady) {
		try { memory = await bootstrapRequest(config, { action: "status" }, { signal, noGit }); }
		catch (error) { memory = { ready: false, error: error.message }; }
	}
	return {
		base: config.base, runtimeDir: config.runtimeDir, instructionFiles: config.instructionFiles ?? [],
		backend, memory, graph,
		ready: Boolean(backend.backendReady && !backend.installation?.error && backend.checks.every(check => check.available) && memory?.ready && graph.supported),
		guidance: "Readiness covers installed tooling and memory initialization. Analyze each chosen project separately using the graph-only gitnexus tool. Codex migration is opt-in: preview, inspect, then explicitly apply. No embeddings are ever generated.",
	};
}

/** Explicit installer synchronization; imported instructions are never promoted. */
export async function syncSetupInstructions(config, { signal, report = () => {} } = {}) {
	const results = [];
	for (const target of config.instructionFiles ?? []) {
		await safeDirectory(dirname(target));
		const preview = await bootstrapRequest(config, { action: "sync_instructions", target }, { signal });
		report(preview.diff || `Managed instructions unchanged: ${target}`);
		results.push(await bootstrapRequest(config, {
			action: "sync_instructions", target, apply: true,
			expected_revision: preview.expected_revision, expected_target_revision: preview.expected_target_revision,
			actor: "agent", reason: "Explicit setup requested automated synchronization of the existing canonical policy, preserving unmanaged instructions; this actor label is provenance, not proof of human approval.",
		}, { signal }));
	}
	return results;
}

