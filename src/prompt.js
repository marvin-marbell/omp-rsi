import { policyText } from "../lib/prompt.js";

const MARKER = "<!-- omp-rsi:live-policy:begin -->";
const END = "<!-- omp-rsi:live-policy:end -->";
const POLICY_MARKER = "<!-- omp-rsi:canonical-policy:begin -->";
const POLICY_END = "<!-- omp-rsi:canonical-policy:end -->";
const PLAN_MARKER = "<!-- omp-rsi:current-plan:begin -->";
const PLAN_END = "<!-- omp-rsi:current-plan:end -->";

function guidance(config) {
	return [
		"First decide whether this is durable work: a lasting artifact, multi-step implementation, consequential decision or repeatable lesson. If yes, use memory_setup status, select/review a template and create or explicitly bind a memory_plan before implementation; keep phases, decisions, corrections and reviewed outcomes in that plan. Quick chat or transient checks need no plan. If storage is unavailable, state the limitation rather than inventing persistence.",
		"GitNexus is graph-only. Use analyze/query/context/impact for a selected project; never generate embeddings or overwrite instruction files.",
		"Read the selected memory_plan template and pin its revision before creation. The plan, not a scratch checklist, tracks durable task state; on resumed turns use the current-plan handle/revision, re-read after conflicts, and record explicit scope changes via successor rather than changing pinned requirements. Pass the plan ID, revision, template and scoped work items to subagents. Prefer improving proven task-specific templates over growing AGENTS/policy; higher-priority instructions still govern conflicts.",
		"The editable memory policy supplements, never overrides, higher-priority instructions, safety constraints, permissions or approvals. Actor labels and assessment scores are not human approval. Policy changes require review; active plans keep their pinned requirements.",
		"TypeSafe preflight is optional coaching, not permission or proof of compliance. For durable improvements, observe or reflect explicit local evidence, select outcomes through corpus/mine/reduce, then prepare/propose/evaluate and run paired holdout trials before explicit revision-bound promotion. No tool telemetry, summary or evaluator judgment alone proves causation or achievement.",
		config.rsiInstructionDiscoveryEnabled === true
			? "Automatic instruction audits are local-only: capture the current effective system prompt, operator-configured instruction files and public process-active visible skill bodies in full or complete chunks. Report any missing, unreadable or oversized member; the skill catalog is process-global and not independently scoped per subagent. Never infer review of unseen layers. Structural findings alone never authorize a policy change; require exact witnesses, reviewed cross-task outcomes and counterevidence. Never automatically apply or publish audit snapshots."
			: "Automatic instruction discovery is disabled. Explicit memory_rsi audit with selected source bodies remains available; never infer coverage of unseen prompt or skill layers.",
		"Use memory_ls then memory_toc and memory_section/search for progressive retrieval; use memory_grep for exact strings. Write focused durable knowledge with memory_new/memory_update and validate before memory_sync. Use memory_plan rather than generic entries for contracts.",
	].join("\n\n");
}

/** Re-read canonical policy at each user-prompt preparation without replacing host sections. */
export function registerPrompt(pi, config, planSession) {
	const prepare = (event, active) => {
		const sections = event.systemPrompt;
		if (!Array.isArray(sections)) throw new Error("OMP effective system prompt sections are unavailable");
		const retained = sections.filter(section => !(typeof section === "string" && (
			(section.startsWith(`${MARKER}\n`) && section.endsWith(`\n${END}`))
			|| (section.startsWith(`${POLICY_MARKER}\n`) && section.endsWith(`\n${POLICY_END}`))
			|| (section.startsWith(`${PLAN_MARKER}\n`) && section.endsWith(`\n${PLAN_END}`))
		)));
		const plan = active ? `${PLAN_MARKER}\n${active.unavailable
			? `Plan ${active.plan_id} is bound but unavailable; read it before relying on a revision.`
			: `Current bound plan ${active.plan_id}, revision ${active.revision}, template ${active.template_id}, complete ${active.complete}. Read the current contract before updating; a new durable task needs its own plan.`}\n${PLAN_END}` : null;
		return { systemPrompt: [...retained, `${MARKER}\n${guidance(config)}\n${END}`, `${POLICY_MARKER}\n## Editable memory policy\n${policyText(config)}\n${POLICY_END}`, ...(plan ? [plan] : [])] };
	};
	if (planSession) pi.on("before_agent_start", async (event, ctx) => prepare(event, await planSession.snapshot(ctx)));
	else pi.on("before_agent_start", event => prepare(event, null));
}
