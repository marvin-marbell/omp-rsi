import { textResult } from "./memory-output.js";
import { requireChoice } from "./memory-parameters.js";

/** Register repository and cache maintenance tools separately from reads and entry writes. */
export function registerMemoryMaintenanceTools(pi, { memory }) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_init",
		label: "Initialize memory agent",
		description: "Initialize the directory structure for a new agent inside the memory repo.",
		parameters: z.object({ agent_id: z.string().describe("Identifier of the agent to initialize.") }),
		approval: "exec",
		async execute(_id, args, signal) {
			return textResult(await memory(["init", args.agent_id], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_sync",
		label: "Sync memory repository",
		description: "Sync the memory repo with its git remote (pull and push). Use after or before long offline stretches.",
		parameters: z.object({
			pull_only: z.boolean().optional().describe("Only pull."),
			push_only: z.boolean().optional().describe("Only push."),
		}),
		approval: "exec",
		async execute(_id, args, signal) {
			const argv = ["sync"];
			if (args.pull_only) argv.push("--pull-only");
			if (args.push_only) argv.push("--push-only");
			return textResult(await memory(argv, { signal }));
		},
	});

	pi.registerTool({
		name: "memory_clone",
		label: "Clone memory repository",
		description: "Clone the configured memory repository locally for offline access.",
		parameters: z.object({}),
		approval: "exec",
		async execute(_id, _args, signal) {
			return textResult(await memory(["clone"], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_cache",
		label: "Manage memory cache",
		description: "Manage the SQLite BM25 index cache: build, status, or clear it.",
		parameters: z.object({ action: z.string().describe("One of: build, status, clear.") }),
		approval: "exec",
		async execute(_id, args, signal) {
			requireChoice("memory_cache", "action", args.action, ["build", "status", "clear"]);
			return textResult(await memory(["cache", args.action], { signal }));
		},
	});
}
