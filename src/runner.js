import { existsSync } from "node:fs";
import { runProcess } from "../lib/process.js";
import { memoryEnvironment } from "../lib/setup.js";

// These CLI commands resolve the selected base through AGENT_MEMORY_PATH and
// do not accept --base; cache subcommands and contracts do accept it.
const ENV_BASE_COMMANDS = new Set(["config", "clone", "sync", "log", "--version", "--help"]);
/** One bounded, abortable subprocess path for memory, contracts and RSI. */
export function createMemoryRunner(config) {
	return async function memory(args, { signal, stdin, jsonOutput = true, cwd } = {}) {
		const argv = [...(jsonOutput ? ["--json-output"] : []), ...args];
		if (config.base && !ENV_BASE_COMMANDS.has(args[0])) argv.push("--base", config.base);
		const options = {
			cwd: cwd ?? (config.base && existsSync(config.base) ? config.base : undefined),
			stdin, signal, timeoutMs: config.timeoutMs ?? 60_000,
			env: memoryEnvironment(config),
		};
		try {
			return (await runProcess(config.memoryBin || "memory", argv, options)).stdout;
		} catch (error) {
			if (error?.code === "ENOENT") {
				return (await runProcess(config.pythonBin || "python3", ["-m", "agent_memory", ...argv], options)).stdout;
			}
			throw new Error(`memory failed: ${error.message}`, { cause: error });
		}
	};
}
