import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPrompt } from "../src/prompt.js";
import { createDiscovery } from "../src/discovery.js";
import { createSessionSignals } from "../lib/rsi-signals.js";
import { projectSource } from "../lib/rsi-learning-data.js";
import { createInstructionSourceDiscovery } from "../lib/rsi-source-discovery.js";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "omp-rsi-port-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("the next OMP prompt uses the current canonical policy without duplicating host sections", t => {
  const base = fixture(t);
  const directory = join(base, "shared", "policies");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "agent-policy.md");
  writeFileSync(path, "First instruction\n");
  let handler;
  registerPrompt({ on(name, fn) { assert.equal(name, "before_agent_start"); handler = fn; } }, { base });
  const initial = handler({ systemPrompt: ["Host policy", "Skill routing"] }).systemPrompt;
  assert.equal(initial.length, 4);
  assert.match(initial.at(-1), /First instruction/);
  writeFileSync(path, "Revised instruction\n");
  const next = handler({ systemPrompt: initial }).systemPrompt;
  assert.deepEqual(next.slice(0, 2), ["Host policy", "Skill routing"]);
  assert.equal(next.length, 4);
  assert.match(next.at(-1), /Revised instruction/);
  assert.doesNotMatch(next.join("\n"), /First instruction/);
});

test("OMP observations project as metadata reports without leaking tool input or output", () => {
  const handlers = new Map();
  const pi = { on(event, fn) { handlers.set(event, fn); }, getActiveTools: () => ["bash"] };
  const signals = createSessionSignals(pi, { rsiTelemetryEnabled: true });
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  handlers.get("tool_result")({ toolName: "bash", toolCallId: "call-1", isError: true, input: { secret: "INPUT_SECRET" }, content: [{ text: "OUTPUT_SECRET" }] }, ctx);
  const snapshot = signals.snapshot("session-1");
  assert.equal(snapshot.totals.failed, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /INPUT_SECRET|OUTPUT_SECRET/);
  const source = { kind: "observation", id: "observed", revision: "r1" };
  const payload = { kind: "observation", bindings: { policy_revision: "p1", plans: [] }, data: { status: "observed", telemetry: snapshot, context_note: null } };
  const units = projectSource(source, payload);
  assert.ok(units.some(unit => unit.coverage.projection_mode === "telemetry-report-units"));
  assert.ok(units.every(unit => unit.coverage.projection_mode !== "unknown-observation-lossless-fallback"));
  assert.doesNotMatch(JSON.stringify(units), /INPUT_SECRET|OUTPUT_SECRET/);
});

test("automatic audit reports unavailable skill catalog as incomplete", async t => {
  const base = fixture(t);
  const instructions = join(base, "instructions.txt");
  writeFileSync(instructions, "Owner instruction\n");
  const discover = createInstructionSourceDiscovery({ rsiInstructionDiscoveryEnabled: true, instructionFiles: [instructions] });
  const ctx = { getSystemPrompt: () => ["Host prompt", "Skill routing only"], sessionManager: { getSessionId: () => "session-1" } };
  const result = await discover(ctx);
  assert.equal(result.discovery.complete, false);
  assert.ok(result.members.some(member => member.body.includes("Owner instruction")));
  assert.ok(result.discovery.classes.find(item => item.kind === "skill").errors.some(error => error.code === "SERVICE_UNAVAILABLE"));
  assert.equal(result.members.filter(member => member.id.startsWith("skill:")).length, 0);
});

test("automatic audit captures visible active skill bodies and excludes hidden skills", async t => {
  const base = fixture(t);
  const visible = join(base, "visible.txt");
  const hidden = join(base, "hidden.txt");
  writeFileSync(visible, "---\nname: public-skill\n---\n\nExact model-visible skill body.\n");
  writeFileSync(hidden, "Hidden skill body.\n");
  const pi = { pi: { getActiveSkills: () => [
    { name: "public-skill", filePath: visible, containRoot: base, hide: false },
    { name: "hidden-skill", filePath: hidden, containRoot: base, hide: true },
  ] } };
  const discover = createDiscovery({ rsiInstructionDiscoveryEnabled: true, instructionFiles: [] }, pi);
  const ctx = { getSystemPrompt: () => ["Host prompt"], sessionManager: { getSessionId: () => "session-1" } };
  const result = await discover(ctx);
  const skills = result.members.filter(member => member.class_id === "skills-active");
  assert.deepEqual(skills.map(member => member.body), ["Exact model-visible skill body."]);
  assert.equal(result.discovery.complete, true);
  assert.equal(result.discovery.agent_scoped, false);
  assert.equal(result.discovery.classes.find(item => item.kind === "skill").user_only_excluded, 1);
});
