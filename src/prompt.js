import { policyText } from "../lib/prompt.js";

const MARKER = "<!-- omp-rsi:live-policy:begin -->";
const END = "<!-- omp-rsi:live-policy:end -->";
const POLICY_MARKER = "<!-- omp-rsi:canonical-policy:begin -->";
const POLICY_END = "<!-- omp-rsi:canonical-policy:end -->";

function guidance(config) {
	return [
		"Rewards > gates. Shared memory plans are execution contracts: earn achievements from reviewed outcomes, not counts or model scores. Start with memory_setup status; install and initialize explicitly if needed. Import alone does not install or migrate anything.",
		"GitNexus is graph-only. Use analyze/query/context/impact for a selected project; never generate embeddings or overwrite instruction files.",
		"Read selected memory_plan templates before creation. Pass a plan ID, current revision and assigned work items during delegation; re-read after conflicts. Use memory_policy to read and explicitly update the canonical versioned policy, and preview/sync managed instruction mirrors only to operator-configured paths.",
		"The editable memory policy supplements, never overrides, higher-priority instructions, safety constraints, permissions or approvals. Actor labels and assessment scores are not human approval. Policy changes require review; active plans keep their pinned requirements.",
		"TypeSafe preflight is optional coaching, not permission or proof of compliance. For durable improvements, observe or reflect explicit local evidence, select outcomes through corpus/mine/reduce, then prepare/propose/evaluate and run paired holdout trials before explicit revision-bound promotion. No tool telemetry, summary or evaluator judgment alone proves causation or achievement.",
		config.rsiInstructionDiscoveryEnabled === true
			? "Automatic instruction audits are local-only: capture the current effective system prompt, operator-configured instruction files and public process-active visible skill bodies in full or complete chunks. Report any missing, unreadable or oversized member; the skill catalog is process-global and not independently scoped per subagent. Never infer review of unseen layers. Structural findings alone never authorize a policy change; require exact witnesses, reviewed cross-task outcomes and counterevidence. Never automatically apply or publish audit snapshots."
			: "Automatic instruction discovery is disabled. Explicit memory_rsi audit with selected source bodies remains available; never infer coverage of unseen prompt or skill layers.",
		"Use memory_ls then memory_toc and memory_section/search for progressive retrieval; use memory_grep for exact strings. Write focused durable knowledge with memory_new/memory_update and validate before memory_sync. Use memory_plan rather than generic entries for contracts.",
	].join("\n\n");
}

/** Re-read canonical policy at each user-prompt preparation without replacing host sections. */
export function registerPrompt(pi, config) {
	pi.on("before_agent_start", event => {
		const sections = event.systemPrompt;
		if (!Array.isArray(sections)) throw new Error("OMP effective system prompt sections are unavailable");
		const retained = sections.filter(section => !(typeof section === "string" && (
			(section.startsWith(`${MARKER}\n`) && section.endsWith(`\n${END}`))
			|| (section.startsWith(`${POLICY_MARKER}\n`) && section.endsWith(`\n${POLICY_END}`))
		)));
		return { systemPrompt: [...retained, `${MARKER}\n${guidance(config)}\n${END}`, `${POLICY_MARKER}\n## Editable memory policy\n${policyText(config)}\n${POLICY_END}`] };
	});
}
