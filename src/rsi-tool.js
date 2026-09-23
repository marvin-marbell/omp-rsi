import { setupFields } from "../lib/setup-json.js";
import { createRsi } from "../lib/rsi.js";
import { rsiOutput } from "../lib/rsi-output.js";

const ACTIONS = ["status", "diagnose", "audit", "trial_spec", "trial_results", "trial_review", "preflight", "prepare", "sections", "propose", "evaluate", "reflect", "observe", "review_observe", "retrieval_observe", "clear_signals", "corpus", "preview", "mine", "reduce", "read", "list", "promote"];

/** Host context, not a model-supplied identifier, selects the invoking session. */
function currentExecution(exec = {}) {
	const agent = exec.ctx?.sessionManager?.getSessionId?.();
	return { ...exec, agent: typeof agent === "string" && agent ? agent : undefined };
}

export function createRsiRuntime(config, { memory, signals, discover }) {
	const rsi = createRsi(config, {
		memory, signals,
		discover: discover && (exec => discover(exec.ctx, exec.signal)),
	});
	return {
		run(action, fields, args = {}, exec = {}) { return rsi.run(action, fields, args, currentExecution(exec)); },
	};
}

export function registerRsiTool(pi, config, runtime) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_rsi",
		label: "Memory RSI",
		description: "Review memory policy and instruction sources with bounded, provenance-aware assessments. Preview one exact local projection unit before explicitly mining it remotely; TypeSafe requires operator opt-in. Use review_observe for selected PR fields and retrieval_observe to hash a selected memory entry locally and record a claimed outcome; no raw content is ingested. Actions: status, diagnose, audit, trial_spec, trial_results, trial_review, preflight, prepare, sections, propose, evaluate, reflect, observe, review_observe, retrieval_observe, clear_signals, corpus, preview, mine, reduce, read, list, promote. Proposals and promotion remain explicitly reviewed and revision-bound; nothing automatically applies.",
		parameters: z.object({
			action: z.string().describe(`One of: ${ACTIONS.join(", ")}.`),
			request: z.string().optional().describe('JSON object excluding action. preview:{kind:\"plans\"|\"observations\",source_id,unit?} shows exact outbound unit locally without network; mine:{kind,source_ids? OR after?,limit?,max_calls?,refresh?,cursor?} explicitly assesses selected units when enabled. audit:{sources?,plan_id?,feedback_ids?}; trial_spec:{trial_id,proposal_id,hypothesis,procedure,stopping_rule,environment,metrics,cases}; trial_results:{trial_id,trial_revision,results,review_note}; trial_review:{results_id}; preflight:{plan_id}; reflect:{plan_id,lesson?}; observe:{plan_id?,context_note?}; review_observe:{plan_id,repository,pr_number,head_sha,review_id,review_commit,review_state,summary}; retrieval_observe:{plan_id,entry_path,outcome,summary}; reduce:{artifact_ids,max_issues?}; prepare:{plan_ids,insight_ids?}; propose:{proposal_id,body OR edits,reason,expected_revision,plan_ids,source_artifact_ids?}; evaluate:{proposal_id}; read:{id,issue_index?}; list:{kind?,limit?,after?}; promote:{proposal_id,evaluation_id,expected_revision,review_note,apply?}.'),
			no_git: z.boolean().optional().describe("Keep artifacts local without Git publication; automatic audits force local-only persistence."),
			allow_non_main_branch: z.boolean().optional().describe("Explicitly permit persistence on a non-default memory branch."),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const fields = setupFields(params.request ?? "{}");
			const result = await runtime.run(params.action, fields, params, { ctx, signal });
			const text = rsiOutput(result);
			if (text.length > 100_000) throw new Error("RSI result exceeds the inline output budget; read the durable artifact by ID instead");
			return { content: [{ type: "text", text }] };
		},
	});
}
