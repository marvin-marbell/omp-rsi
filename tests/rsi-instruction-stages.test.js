import test from "node:test";
import assert from "node:assert/strict";
import { loadInstructionFeedback } from "../lib/rsi-instruction-feedback.js";
import { chunkInstructionMember } from "../lib/rsi-instruction-stages.js";

test("instruction chunks are gapless exact UTF-8 coverage without prefix markers", () => {
	const body = `${"😀αβ\n".repeat(7000)}tail`;
	const member = { id: "skill:utf8", class_id: "skills-active", kind: "skill", scope: "active", body, revision: "source-revision", metadata: {} };
	const chunks = chunkInstructionMember(member, 4096);
	assert.ok(chunks.length > 1);
	assert.equal(chunks.map(chunk => chunk.body).join(""), body);
	assert.equal(chunks[0].byte_start, 0);
	assert.equal(chunks.at(-1).byte_end, Buffer.byteLength(body));
	for (let index = 1; index < chunks.length; index++) assert.equal(chunks[index - 1].byte_end, chunks[index].byte_start);
	assert.ok(chunks.every(chunk => chunk.body_bytes <= 4096 && !chunk.body.includes("...[truncated")));
});

test("insufficient reports and tool metadata cannot nominate policy changes", async () => {
	const reviewed = (id, evidence_status = "observed") => ({ report: { type: "evidence", latest_review: "accepted" }, source: { kind: "plan", id, revision: "r" }, evidence_status, signal: "failure", witness: { id: `e-${id}`, path: "plan.evidence.summary", start: 0, end: 4, quote: "test" } });
	const telemetry = { report: { type: "observation-telemetry", tool: "bash" }, source: { kind: "observation", id: "o", revision: "r" }, evidence_status: "observed", signal: "failure", witness: { id: "e-tool", path: "observation.data.telemetry", quote: "failed" } };
	const issue = witnesses => ({ key: "gate", mechanism: "verification-design", destination: "policy", operation: "rewrite", generality: "cross-task", sufficiency: "supported", independent_source_count: 3,
		counts: { evidence_status: { observed: 3 } }, coverage: { omitted_witness_units: 0, context_omissions: 0, strata_represented: 2, strata_total: 2 }, witnesses, uncertainties: [],
		counterevidence: [{ source: { kind: "plan", id: "plan-b", revision: "r" }, map: { id: "m", revision: "r" }, witness_id: "e-plan-b", signal: "success" }] });
	const load = async (status, groups, value) => loadInstructionFeedback(async () => ({ artifact: { id: "insight-gate", kind: "insight", revision: "r", freshness: { stale: false }, data: { status, coverage: groups, issues: [value] } } }), ["insight-gate"]);
	const groups = { groups_total: 1, groups_selected: 1, deferred_groups: [] };
	const weak = await load("complete", groups, issue([reviewed("plan-a", "insufficient"), telemetry]));
	assert.equal(weak.manifest.eligible_items, 0);
	assert.equal((await load("complete", groups, issue([reviewed("plan-a"), reviewed("plan-b")]))).manifest.eligible_items, 1);
});

test("trial reviews are corroborating context and never independently unlock change review", async () => {
	const artifact = { id: "trial-review", kind: "trial_review", revision: "revision", freshness: { stale: false }, data: {
		interpretation: { disposition: "reported-gain-for-review", flags: [], uncertain: [], measurement_scope: "caller reports" }, state: { summary: { total: { outcome: { paired: 5 } } } },
	} };
	const result = await loadInstructionFeedback(async () => ({ artifact }), [artifact.id]);
	assert.equal(result.remote.items[0].corroborating_only, true);
	assert.equal(result.remote.items[0].eligible_for_change_review, false);
	assert.equal(result.manifest.eligible_items, 0);
});

test("feedback selection is explicit, fresh and bounded", async () => {
	await assert.rejects(loadInstructionFeedback(async () => { throw new Error("should not read"); }, Array(17).fill("same")), /at most 16 distinct/);
	await assert.rejects(loadInstructionFeedback(async () => ({ artifact: { id: "stale", kind: "insight", revision: "r", freshness: { stale: true }, data: { issues: [] } } }), ["stale"]), /stale/);
	await assert.rejects(loadInstructionFeedback(async () => ({ artifact: { id: "wrong", kind: "observation", revision: "r", freshness: { stale: false }, data: {} } }), ["wrong"]), /insight or trial_review/);
});
