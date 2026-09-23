import { contractCreateOutput } from "../lib/contracts-output.js";
import { contractCliArgs, contractRequestStdin } from "./memory-contract-request.js";
import { textResult } from "./memory-output.js";

const PLAN_ACTIONS = ["templates", "review", "save_template", "create", "read", "update", "validate"];

/** Register revision-checked plans; the Python CLI remains the contract authority. */
export function registerContractTools(pi, config, { memory, rsi }) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_plan",
		label: "Memory plan",
		description: "Rewards > gates: discover and review templates, then write a durable shared task contract. Earn achievements with evidence; parent and subagents use the same plan ID, revision, and work items. Review returns the template and creation guidance. Updates are revision-checked and scoped; templates evolve separately from pinned plans.",
		parameters: z.object({
			action: z.string().describe(`One of: ${PLAN_ACTIONS.join(", ")}.`),
			request: z.string().optional().describe('JSON object excluding action. Review: {"template_id":"coding"}. Create: {"plan_id":"task-id","template_id":"coding","template_revision":"<review revision>","task":{...}}. Read/validate: {"plan_id":"task-id"}. Update includes plan_id, revision, work_item_id and evidence/reviews/status. Start with templates then review for full schema.'),
			no_git: z.boolean().optional().describe("Skip memory Git commit/sync; saved files remain durable locally."),
			allow_non_main_branch: z.boolean().optional().describe("Explicitly allow a memory commit on a non-default branch."),
		}),
		// Template saves, plan updates, and plan creation share this action-dependent tool.
		approval: "exec",
		async execute(_id, args, signal, _onUpdate, ctx) {
			const stdin = contractRequestStdin(args.action, args.request, PLAN_ACTIONS);
			const result = await memory(contractCliArgs("plan", args), { stdin, signal });
			if (args.action !== "create" || !rsi) return textResult(result);
			const saved = JSON.parse(result);
			try {
				saved.policy_preflight = await rsi.preflight(saved.plan.plan_id, args, { signal, ctx }, saved.revision);
			} catch {
				// The durable plan must remain visible even when assessment cannot run.
				saved.policy_preflight = {
					status: "unavailable",
					reason: "Plan saved; policy preflight could not be attached. Read the current plan and retry memory_rsi preflight before relying on an assessment.",
					permission_effect: "none",
				};
			}
			return textResult(contractCreateOutput(saved));
		},
	});
}
