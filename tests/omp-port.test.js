import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPrompt } from "../src/prompt.js";
import { createPlanSession, registerContractTools } from "../src/contract-tools.js";
import { createDiscovery } from "../src/discovery.js";
import { createSessionSignals } from "../lib/rsi-signals.js";
import { projectSource } from "../lib/rsi-learning-data.js";
import { createInstructionSourceDiscovery } from "../lib/rsi-source-discovery.js";
import { readPluginSettings, resolveConfig } from "../src/config.js";

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

test("current plan handle survives a branch resume and never crosses a switched session", async t => {
  const base = fixture(t);
  const policy = join(base, "shared", "policies");
  mkdirSync(policy, { recursive: true });
  writeFileSync(join(policy, "agent-policy.md"), "Persistent policy\n");
  const handlers = new Map(), branches = new Map([["one", []], ["two", []]]);
  let session = "one", revision = "r1", reads = 0, blockNext = false, unblock;
  const ctx = { sessionManager: { getSessionId: () => session, getBranch: () => branches.get(session) } };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { branches.get(session).push({ type: "custom", customType, data }); },
  };
  const memory = async (_argv, options) => {
    reads++;
    if (blockNext) { blockNext = false; await new Promise(resolve => { unblock = resolve; }); }
    const request = JSON.parse(options.stdin);
    assert.equal(request.action, "read");
    return JSON.stringify({ revision, plan: { template: { template_id: "coding" } }, validation: { complete: false } });
  };
  const plans = createPlanSession(pi, memory);
  registerPrompt(pi, { base }, plans);
  assert.equal((await handlers.get("before_agent_start")({ systemPrompt: ["Host"] }, ctx)).systemPrompt.length, 3);
  await plans.bind("work-one", ctx);
  const prepared = await handlers.get("before_agent_start")({ systemPrompt: ["Host"] }, ctx);
  assert.match(prepared.systemPrompt.at(-1), /work-one, revision r1/);
  revision = "r2";
  const resumed = await handlers.get("before_agent_start")({ systemPrompt: prepared.systemPrompt }, ctx);
  assert.equal(resumed.systemPrompt.length, 4);
  assert.match(resumed.systemPrompt.at(-1), /work-one, revision r2/);
  session = "two";
  handlers.get("session_switch")({}, ctx);
  const other = await handlers.get("before_agent_start")({ systemPrompt: resumed.systemPrompt }, ctx);
  assert.equal(other.systemPrompt.length, 3);
  session = "one";
  handlers.get("session_switch")({}, ctx);
  assert.match((await handlers.get("before_agent_start")({ systemPrompt: other.systemPrompt }, ctx)).systemPrompt.at(-1), /work-one/);
  assert.ok(reads >= 4);
  blockNext = true;
  const stale = plans.bind("late-plan", ctx);
  await new Promise(resolve => setImmediate(resolve));
  session = "two";
  handlers.get("session_switch")({}, ctx);
  unblock();
  await assert.rejects(stale, /Session changed before plan binding/);
  assert.equal(branches.get("two").length, 0);
});

test("creating or amending a plan never invokes remote preflight even when TypeSafe is enabled", async () => {
  let tool, remoteCalls = 0;
  const string = { describe() { return this; }, optional() { return this; } };
  const pi = { zod: { string: () => string, boolean: () => string, object: value => value }, registerTool(value) { tool = value; } };
  const memory = async (_argv, { stdin }) => JSON.stringify({
    plan: { plan_id: JSON.parse(stdin).action === "amend" ? "successor" : "original" },
    path: "/memory/plans/example.md", revision: "r1", persistence: { saved: true },
  });
  registerContractTools(pi, { typesafeEnabled: true }, { memory, rsi: { preflight() { remoteCalls++; throw new Error("remote request"); } } });
  for (const action of ["create", "amend"]) {
    const result = await tool.execute("call", { action, request: "{}" }, undefined, undefined, {});
    const saved = JSON.parse(result.content[0].text);
    assert.equal(saved.persistence.saved, true);
    assert.equal(Object.hasOwn(saved, "policy_preflight"), false);
  }
  assert.equal(remoteCalls, 0);
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

test("only user settings may opt in TypeSafe; project overrides cannot grant consent", t => {
  const base = fixture(t);
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousProfile = process.env.OMP_PROFILE;
  const previousConfig = process.env.OMP_RSI_CONFIG;
  const previousCwd = process.cwd();
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    if (previousProfile === undefined) delete process.env.OMP_PROFILE;
    else process.env.OMP_PROFILE = previousProfile;
    if (previousConfig === undefined) delete process.env.OMP_RSI_CONFIG;
    else process.env.OMP_RSI_CONFIG = previousConfig;
    process.chdir(previousCwd);
  });
  process.env.XDG_DATA_HOME = base;
  delete process.env.OMP_PROFILE;
  const plugins = join(base, "omp", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, "omp-plugins.lock.json"), JSON.stringify({
    settings: { "omp-rsi": { typesafeEnabled: false, rsiTelemetryEnabled: true, agentId: "ui-agent", unrelated: "ignored" } },
  }));
  const configFile = join(base, "operator.json");
  writeFileSync(configFile, JSON.stringify({ typesafeEnabled: true, agentId: "file-agent" }));
  process.env.OMP_RSI_CONFIG = configFile;
  const project = join(base, "work");
  mkdirSync(join(project, ".omp"), { recursive: true });
  mkdirSync(join(project, ".git"));
  writeFileSync(join(project, ".omp", "plugin-overrides.json"), JSON.stringify({
    settings: { "omp-rsi": { typesafeEnabled: true, rsiInstructionDiscoveryEnabled: true, rsiTelemetryEnabled: false, base: "/tmp/untrusted-memory" } },
  }));
  process.chdir(project);
  const settings = readPluginSettings();
  assert.deepEqual(settings, { typesafeEnabled: false, rsiTelemetryEnabled: true, agentId: "ui-agent" });
  const effective = resolveConfig(settings);
  assert.equal(effective.typesafeEnabled, false);
  assert.equal(effective.rsiInstructionDiscoveryEnabled, false);
  assert.equal(effective.rsiTelemetryEnabled, true);
  assert.equal(effective.agentId, "ui-agent");
  assert.equal(effective.typesafeApiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(Object.hasOwn(settings, "typesafeApiKey"), false);
});
