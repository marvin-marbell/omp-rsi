import { createHash, randomUUID } from "node:crypto";

// Storage ceilings, not policy-length targets or achievement thresholds.
export const SIGNAL_LIMITS = Object.freeze({ sessions: 100, recent: 128, tools: 32, patterns: 64, dedup: 256 });
const OUTCOMES = ["success", "failed", "aborted", "denied", "unknown"];
const LIMITATIONS = [
	"Counts are OMP tool_result events, not agent mistakes, earned credit, task success or independent evidence sources.",
	"OMP tool_result does not expose a root/child dispatch relationship. Nested or composite outcomes cannot be distinguished; a successful composite can hide failed children.",
	"Tool arguments, input, output/content, details, metadata, error messages and session history are never inspected. Nonzero exit text in a successful result remains dispatch success.",
	"OMP exposes only isError, not a structured denial or abort reason. Failures are unclassified; no denial is inferred from free text.",
	"RSI/probe/internal tool names are excluded. Internal work using ordinary tool names is indistinguishable without reading arguments and may remain included.",
	"Tool names are retained only when OMP verifies they are currently active. Missing or unavailable lists use fixed anonymous buckets; counters are still captured.",
	"Same-tool failure/recovery sequences follow result arrival order, not causal attribution; concurrent calls may finish out of order. Overflow and anonymous tool groups do not produce sequence claims.",
	"Deduplication covers only the bounded recent tool-call-ID window. Replayed IDs outside it can count again. No ancestor/child session joins or pre-activation history are read.",
];
const object = value => value !== null && typeof value === "object";
function leaf(value, key) {
	try { return object(value) ? value[key] : undefined; } catch { return undefined; }
}
const totals = () => ({ total: 0, success: 0, failed: 0, aborted: 0, denied: 0, unknown: 0 });
const sequences = () => ({ repeated_failures: 0, recoveries: 0, longest_failure_streak: 0 });
const coverage = () => ({ events_seen: 0, excluded_self_or_probe: 0, nested_omitted: 0, duplicate_calls: 0, malformed_execution: 0, malformed_result: 0, invalid_tool_names: 0, unknown_tool_names: 0, unverified_tool_names: 0, missing_structured_code: 0, unrecognized_structured_code: 0, samples_dropped: 0, dedup_ids_dropped: 0, tool_calls_grouped_as_other: 0, pattern_events_dropped: 0 });
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const validTool = name => typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_.:/-]{0,95}$/.test(name);
function excluded(name) {
	return typeof name === "string" && name.length <= 128 && (
		/^(?:functions\.)?(?:memory_rsi(?:$|[._:/-])|rsi(?:$|[._:/-])|__)/.test(name)
		|| /(?:^|[._:/-])(?:probe|internal)(?:$|[._:/-])/.test(name)
	);
}
function classify(event) {
	const flag = leaf(event, "isError");
	if (flag === false) return { outcome: "success", failure_class: null, structured_code: null };
	if (flag === true) return { outcome: "failed", failure_class: "unclassified_failure", structured_code: null, uncertainty: "missing_structured_code" };
	return { outcome: "unknown", failure_class: null, structured_code: null, uncertainty: "malformed_result" };
}
function projectToolName(pi, name, counts) {
	if (!validTool(name)) { counts.invalid_tool_names++; return "(unclassified-tool)"; }
	try {
		// The host's active list, not a model-controlled requested name.
		const tools = pi.getActiveTools?.();
		if (Array.isArray(tools) && tools.includes(name)) return name;
	} catch { /* Anonymous capture if registry is unavailable. */ }
	counts.unverified_tool_names++;
	return "(unregistered-tool)";
}
function newState(previous = 0, reset = "activation", marker = randomUUID()) {
	return {
		marker, since: Date.now(), first: null, last: null, evicted: false,
		previousDropped: previous, reset, totals: totals(), sequences: sequences(), coverage: coverage(),
		tools: new Map(), other: null, patterns: new Map(), recent: [], seen: new Set(),
	};
}
function erase(state) {
	state.tools.clear(); state.patterns.clear(); state.recent.length = 0; state.seen.clear();
	state.other = null; state.totals = totals(); state.sequences = sequences(); state.coverage = coverage();
	state.first = null; state.last = null;
}
function count(target, outcome) { target.total++; target[outcome]++; }
function toolGroup(state, name) {
	let group = state.tools.get(name);
	if (!group && state.tools.size < SIGNAL_LIMITS.tools) {
		group = { tool: name, totals: totals(), sequences: sequences(), streak: 0 };
		state.tools.set(name, group);
	}
	if (group) return group;
	state.coverage.tool_calls_grouped_as_other++;
	return state.other ??= { tool: "(other-tools)", totals: totals(), sequences: sequences(), streak: 0 };
}
function updateSequences(state, group, outcome) {
	if (!validTool(group.tool)) return { failure_streak: null, recovery: false };
	const recovery = outcome === "success" && group.streak > 0;
	if (outcome === "failed") {
		group.streak++;
		if (group.streak > 1) { group.sequences.repeated_failures++; state.sequences.repeated_failures++; }
		group.sequences.longest_failure_streak = Math.max(group.sequences.longest_failure_streak, group.streak);
		state.sequences.longest_failure_streak = Math.max(state.sequences.longest_failure_streak, group.streak);
	} else {
		if (recovery) { group.sequences.recoveries++; state.sequences.recoveries++; }
		group.streak = 0; // Abort, denial and unknown are not failed-attempt evidence.
	}
	return { failure_streak: group.streak, recovery };
}
function record(state, name, classification) {
	const now = Date.now(), { outcome, failure_class, structured_code, uncertainty } = classification;
	state.first ??= now; state.last = now;
	count(state.totals, outcome);
	if (uncertainty) state.coverage[uncertainty]++;
	const group = toolGroup(state, name);
	count(group.totals, outcome);
	const sequence = updateSequences(state, group, outcome);
	if (failure_class) {
		const key = `${group.tool}|${failure_class}`;
		let pattern = state.patterns.get(key);
		if (!pattern && state.patterns.size < SIGNAL_LIMITS.patterns) {
			pattern = { tool: group.tool, outcome, failure_class, structured_code, count: 0 };
			state.patterns.set(key, pattern);
		}
		if (pattern) pattern.count++; else state.coverage.pattern_events_dropped++;
	}
	// No call IDs or live object references enter samples or public snapshots.
	state.recent.push({ sequence: state.totals.total, at_ms: now, tool: group.tool, outcome, failure_class, structured_code, ...sequence });
	if (state.recent.length > SIGNAL_LIMITS.recent) { state.recent.shift(); state.coverage.samples_dropped++; }
}
function rates(counts) {
	return { denominator: counts.total, ...Object.fromEntries(OUTCOMES.map(key => [key, counts.total ? counts[key] / counts.total : null])) };
}

/**
 * OMP tool_result observer. Reads only toolName, toolCallId and isError.
 * Session identity comes only from the host context and never from tool input.
 * This collector neither persists nor transmits observations; explicit observe
 * persists a snapshot locally, and explicit mine may later disclose it.
 */
export function createSessionSignals(pi, config = {}) {
	const enabled = config.rsiTelemetryEnabled === true;
	const activatedAt = Date.now();
	let active = enabled, states = new Map();
	const retained = new Set();
	function ensure(agent) {
		let state = states.get(agent);
		if (state && !state.evicted) { retained.delete(state); retained.add(state); return state; }
		if (retained.size >= SIGNAL_LIMITS.sessions) {
			const oldest = retained.values().next().value;
			oldest.previousDropped += oldest.totals.total;
			erase(oldest); oldest.evicted = true; oldest.reset = "capacity";
			states.delete(oldest.sessionKey);
			retained.delete(oldest);
		}
		state = newState(state?.previousDropped ?? 0, state?.evicted ? "capacity" : "activation", state?.marker);
		state.sessionKey = agent;
		states.set(agent, state); retained.add(state);
		return state;
	}
	function onResult(event, ctx) {
		if (!active) return;
		const agent = ctx?.sessionManager?.getSessionId?.();
		if (typeof agent !== "string" || !agent) return;
		const state = ensure(agent);
		state.coverage.events_seen++;
		const name = leaf(event, "toolName");
		if (excluded(name)) { state.coverage.excluded_self_or_probe++; return; }
		const callId = leaf(event, "toolCallId");
		if (!validId(callId)) { state.coverage.malformed_execution++; return; }
		const id = createHash("sha256").update(callId).digest("hex");
		if (state.seen.has(id)) { state.coverage.duplicate_calls++; return; }
		state.seen.add(id);
		if (state.seen.size > SIGNAL_LIMITS.dedup) { state.seen.delete(state.seen.values().next().value); state.coverage.dedup_ids_dropped++; }
		const classification = classify(event);
		const tool = projectToolName(pi, name, state.coverage);
		record(state, tool, classification);
	}
	function forget(agent) {
		const state = typeof agent === "string" ? states.get(agent) : undefined;
		if (!state) return false;
		erase(state); retained.delete(state); states.delete(agent);
		return true;
	}
	if (enabled) {
		if (typeof pi?.on !== "function") throw new Error("Session telemetry requires OMP pi.on");
		pi.on("tool_result", onResult);
		pi.on("session_shutdown", (_event, ctx) => {
			const agent = ctx?.sessionManager?.getSessionId?.();
			if (typeof agent === "string") forget(agent);
		});
	}
	function status(agent) {
		const state = typeof agent === "string" ? states.get(agent) : undefined;
		const status = !enabled ? "disabled" : !active ? "stopped" : typeof agent !== "string" || !agent ? "invalid-session" : !state ? "not-observed" : state.evicted ? "evicted" : "capturing";
		return { enabled, active, status, local_only: true, persistence: "explicit-observe-only", network_called: false, permission_effect: "none" };
	}
	function snapshot(agent) {
		const state = typeof agent === "string" ? states.get(agent) : undefined;
		const counts = state?.totals ?? totals();
		return {
			schema: "memory-rsi-session-signals/v1", ...status(agent),
			source: { kind: "current-session-tool-results", event: "tool_result", session_marker: state?.marker ?? null, scope: "host-current-session", counted_unit: "tool-result-event" },
			coverage: {
				activated_at_ms: activatedAt, window_since_ms: state?.since ?? activatedAt, snapshot_at_ms: Date.now(),
				first_counted_at_ms: state?.first ?? null, last_counted_at_ms: state?.last ?? null,
				reset_reason: state?.reset ?? "no-observations", prior_window_calls_dropped: state?.previousDropped ?? 0,
				...state?.coverage ?? coverage(), recent_retained: state?.recent.length ?? 0, dedup_retained: state?.seen.size ?? 0,
			},
			limits: { ...SIGNAL_LIMITS }, totals: { ...counts }, rates: rates(counts),
			sequences: { scope: "same-tool-result-order", ...state?.sequences ?? sequences() },
			tools: state ? [...state.tools.values(), ...state.other ? [state.other] : []].map(group => ({ tool: group.tool, totals: { ...group.totals }, rates: rates(group.totals), sequences: { ...group.sequences }, sequence_tracking: validTool(group.tool) })) : [],
			failure_patterns: state ? [...state.patterns.values()].map(pattern => ({ ...pattern })) : [],
			recent: state ? state.recent.map(sample => ({ ...sample })) : [],
			limitations: [...LIMITATIONS],
		};
	}
	function clear(agent) {
		const previous = typeof agent === "string" ? states.get(agent) : undefined;
		const cleared = forget(agent);
		if (cleared && active) {
			const next = ensure(agent);
			next.reset = "clear";
			next.marker = previous.marker; // Same source, new observation window; not independent evidence.
		}
		return { ...status(agent), cleared, scope: "host-current-session", persisted_artifacts_removed: false };
	}
	return { snapshot, clear, status };
}
