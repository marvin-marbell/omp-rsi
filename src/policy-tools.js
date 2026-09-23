import { contractCliArgs, contractRequestStdin } from "./memory-contract-request.js";
import { textResult } from "./memory-output.js";

const POLICY_ACTIONS = ["read", "update", "history", "rollback", "sync"];

/** Register persistent policy operations with an operator-owned instruction-file allowlist. */
export function registerPolicyTools(pi, config, { memory }) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_policy",
		label: "Memory policy",
		description: "Read or explicitly revise the persistent agent policy used by OMP prompt assembly. Inspect history or roll back; preview and sync a managed policy section into operator-allowlisted AGENTS-like files without replacing human content. Policy supplements, never overrides, platform permissions or higher-priority instructions. Shared policy changes require explicit review; actor labels are audit metadata, not proof of approval.",
		parameters: z.object({
			action: z.string().describe(`One of: ${POLICY_ACTIONS.join(", ")}.`),
			request: z.string().optional().describe('JSON object excluding action. Update: {"body":"...","expected_revision":"<read revision>","actor":"agent","reason":"..."}. Rollback also specifies target revision. Sync: {"target":"<configured path>"} previews; apply:true requires expected_revision, expected_target_revision, actor and reason. Read returns usage guidance.'),
			no_git: z.boolean().optional().describe("Skip memory Git commit/sync; saved files remain durable locally."),
			allow_non_main_branch: z.boolean().optional().describe("Explicitly allow a memory commit on a non-default branch."),
		}),
		// Update, rollback and sync with apply:true can persist or commit changes.
		approval: "exec",
		async execute(_id, args, signal) {
			const stdin = contractRequestStdin(args.action, args.request, POLICY_ACTIONS);
			const argv = contractCliArgs("policy", args);
			for (const file of config.instructionFiles ?? []) argv.push("--instruction-file", file);
			return textResult(await memory(argv, { stdin, signal }));
		},
	});
}
