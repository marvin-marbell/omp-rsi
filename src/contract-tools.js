import { contractCreateOutput } from "../lib/contracts-output.js";
import { contractCliArgs, contractRequestStdin } from "./memory-contract-request.js";
import { textResult } from "./memory-output.js";

const PLAN_ACTIONS = ["templates", "review", "save_template", "create", "read", "update", "append_event", "amend", "validate", "bind", "unbind"];

const SESSION_ENTRY = "eu.ideoon.omp-rsi.current-plan";
const validPlanId = id => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id);

/** Only an explicit tool action changes the session binding; the plan is owned by memory. */
export function createPlanSession(pi, memory) {
	const current = new Map();
	let generation = 0;
	const sessionId = ctx => ctx?.sessionManager?.getSessionId?.();
	const readPlan = id => memory(["plan", "--request", "-"], { stdin: JSON.stringify({ action: "read", plan_id: id }) });
	const stateFor = session => {
		let state = current.get(session);
		if (!state) {
			state = { planId: undefined, epoch: 0 };
			current.set(session, state);
		}
		return state;
	};
	const capture = ctx => {
		const session = sessionId(ctx);
		if (typeof session !== "string" || !session) return null;
		const state = stateFor(session);
		return { session, generation, state, epoch: state.epoch };
	};
	const isCurrent = (token, ctx) => token.generation === generation && sessionId(ctx) === token.session
		&& current.get(token.session) === token.state
		&& token.state.epoch === token.epoch;
	const restore = ctx => {
		generation++;
		const id = sessionId(ctx);
		if (typeof id !== "string" || !id) return;
		const branch = ctx.sessionManager.getBranch?.();
		if (!Array.isArray(branch)) { current.delete(id); return; }
		const entry = branch.filter(item => item?.type === "custom" && item.customType === SESSION_ENTRY).at(-1);
		const state = stateFor(id);
		state.epoch++;
		state.planId = entry && (entry.data?.plan_id === null || validPlanId(entry.data?.plan_id))
			? entry.data.plan_id : undefined;
	};
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(event, (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => { current.delete(sessionId(ctx)); generation++; });
	async function bind(id, ctx, pending) {
		const session = sessionId(ctx);
		if (typeof session !== "string" || !session || typeof pi.appendEntry !== "function") {
			throw new Error("Current-plan binding requires a persistent OMP session");
		}
		if (id !== null && !validPlanId(id)) throw new Error("Invalid plan ID");
		const token = pending ?? capture(ctx);
		if (!token || !isCurrent(token, ctx)) throw new Error("Session changed before plan binding; plan remains saved but was not bound");
		// Reserve the decision before the backend read; a later bind or unbind wins.
		token.state.epoch++;
		const operation = { ...token, epoch: token.state.epoch };
		if (id !== null) await readPlan(id);
		if (!isCurrent(operation, ctx)) throw new Error("Session changed before plan binding or binding superseded; plan remains saved but was not bound");
		pi.appendEntry(SESSION_ENTRY, { plan_id: id });
		operation.state.planId = id;
		return { plan_id: id, bound: id !== null, scope: "current-session-branch", persisted: true };
	}
	async function snapshot(ctx) {
		const session = sessionId(ctx), state = current.get(session);
		const id = state?.planId;
		if (!id) return null;
		const token = { session, generation, state, epoch: state.epoch };
		try {
			const entry = JSON.parse(await readPlan(id));
			if (!isCurrent(token, ctx) || token.state.planId !== id) return null;
			return { plan_id: id, revision: entry.revision, complete: entry.validation?.complete === true, template_id: entry.plan?.template?.template_id };
		} catch {
			if (!isCurrent(token, ctx) || token.state.planId !== id) return null;
			return { plan_id: id, unavailable: true };
		}
	}
	return { bind, snapshot, capture };
}

/** Register revision-checked plans; the Python CLI remains the contract authority. */
export function registerContractTools(pi, config, { memory, planSession }) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_plan",
		label: "Memory plan",
		description: "Decide whether the task is durable; quick chat needs no plan. For durable work review a template and create a shared plan before implementation. Explicit bind/unbind restores a current-plan handle in the OMP session; amendments preserve pinned requirements. Achievements require reviewed evidence, not counts or model scores.",
		parameters: z.object({
			action: z.string().describe(`One of: ${PLAN_ACTIONS.join(", ")}.`),
			request: z.string().optional().describe('JSON object excluding action. Review: {"template_id":"coding"}. Create: {"plan_id":"task-id","template_id":"coding","template_revision":"<review revision>","task":{...}}. Read/validate/bind: {"plan_id":"task-id"}. Unbind needs no request. Update/append_event/amend use the reviewed template and current revision.'),
			no_git: z.boolean().optional().describe("Skip memory Git commit/sync; saved files remain durable locally."),
			allow_non_main_branch: z.boolean().optional().describe("Explicitly allow a memory commit on a non-default branch."),
		}),
		// Template saves, plan updates, and plan creation share this action-dependent tool.
		approval: "exec",
		async execute(_id, args, signal, _onUpdate, ctx) {
			if (args.action === "bind" || args.action === "unbind") {
				if (!planSession) throw new Error("Current-plan session binding is unavailable");
				const request = JSON.parse(args.request ?? "{}");
				if (!request || typeof request !== "object" || Array.isArray(request) || (args.action === "bind"
					? Object.keys(request).length !== 1 || !validPlanId(request.plan_id)
					: Object.keys(request).length !== 0)) throw new Error("Invalid current-plan binding request");
				return textResult(JSON.stringify(await planSession.bind(args.action === "bind" ? request.plan_id : null, ctx)));
			}
			const stdin = contractRequestStdin(args.action, args.request, PLAN_ACTIONS.filter(action => !["bind", "unbind"].includes(action)));
			const pendingBinding = ["create", "amend"].includes(args.action) && planSession ? planSession.capture(ctx) : null;
			const result = await memory(contractCliArgs("plan", args), { stdin, signal });
			if (!["create", "amend"].includes(args.action)) return textResult(result);
			const saved = JSON.parse(result);
			// The new or successor plan has been saved; only an explicit RSI action can disclose it remotely.
			if (pendingBinding) {
				try { saved.session_binding = await planSession.bind(saved.plan.plan_id, ctx, pendingBinding); }
				catch { saved.session_binding = { bound: false, reason: "Plan saved; bind explicitly in the current session." }; }
			}
			return textResult(contractCreateOutput(saved));
		},
	});
}
