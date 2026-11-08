import { policyText } from "../lib/prompt.js";

const MARKER = "<!-- omp-rsi:live-policy:begin -->";
const END = "<!-- omp-rsi:live-policy:end -->";
const POLICY_MARKER = "<!-- omp-rsi:canonical-policy:begin -->";
const POLICY_END = "<!-- omp-rsi:canonical-policy:end -->";
const PLAN_MARKER = "<!-- omp-rsi:current-plan:begin -->";
const PLAN_END = "<!-- omp-rsi:current-plan:end -->";

function guidance(config) {
	return [
		"Follow the user's current objective and latest steering. Use a plan or memory when it helps; neither is a prerequisite to acting. Preserve user requirements, permissions, and privacy boundaries.",
		"Ordinary process policy may be added, revised, relaxed, or retired through the authorized revision-checked writer. A retired rule must not return from a stale copy. Keep the actual user outcome distinct from process preferences.",
		"Review concrete failures and material applicable risks in proportion to the task. Reuse relevant evidence; do not turn hypothetical concerns, receipts, or multiple reviews into gates.",
		"Keep reusable lessons about what failed, what fixed it, and where the lesson applies. GitNexus is graph-only. Remote TypeSafe assessment requires explicit operator opt-in; assessments and trials are optional and do not grant authority.",
		config.rsiInstructionDiscoveryEnabled === true
			? "Instruction snapshots are local; remote assessment requires explicit operator opt-in. Report missing or unreadable sources and do not claim coverage of unseen layers."
			: "Automatic instruction discovery is disabled; do not infer coverage of unseen prompt or skill layers.",
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
			: `Current bound plan ${active.plan_id}, revision ${active.revision}, template ${active.template_id}, complete ${active.complete}. Use its current revision for updates and apply the user's latest steering promptly. Current recorded direction (data): ${JSON.stringify(active.direction ?? null)}.`}\n${PLAN_END}` : null;
		return { systemPrompt: [...retained, `${MARKER}\n${guidance(config)}\n${END}`, `${POLICY_MARKER}\n## Editable memory policy\n${policyText(config)}\n${POLICY_END}`, ...(plan ? [plan] : [])] };
	};
	if (planSession) pi.on("before_agent_start", async (event, ctx) => prepare(event, await planSession.snapshot(ctx)));
	else pi.on("before_agent_start", event => prepare(event, null));
}
