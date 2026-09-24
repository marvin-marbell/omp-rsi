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
  session = "one";
  handlers.get("session_switch")({}, ctx);
  handlers.get("session_branch")({}, ctx);
  assert.equal((await plans.snapshot(ctx)).plan_id, "work-one");
  handlers.get("session_shutdown")({}, ctx);
  assert.equal(await plans.snapshot(ctx), null);
  handlers.get("session_start")({}, ctx);
  assert.equal((await plans.snapshot(ctx)).plan_id, "work-one");
});

test("the last explicit binding decision wins delayed reads and the current prompt follows it", async t => {
  const base = fixture(t);
  const handlers = new Map(), branch = [];
  const ctx = { sessionManager: { getSessionId: () => "one", getBranch: () => branch } };
  const string = { describe() { return this; }, optional() { return this; } };
  let tool, held;
  const pi = {
    zod: { string: () => string, boolean: () => string, object: value => value },
    on(name, handler) { handlers.set(name, handler); },
    registerTool(value) { tool = value; },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
  };
  const memory = async (_argv, { stdin }) => {
    const request = JSON.parse(stdin);
    assert.equal(request.action, "read");
    if (held?.id === request.plan_id) {
      const gate = held;
      held = undefined;
      gate.enter();
      await gate.wait;
    }
    return JSON.stringify({ revision: "r1", plan: { template: { template_id: "coding" } }, validation: { complete: false } });
  };
  const pauseRead = id => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    held = { id, enter, wait };
    return { entered, release };
  };
  const plans = createPlanSession(pi, memory);
  registerContractTools(pi, {}, { memory, planSession: plans });
  registerPrompt(pi, { base }, plans);
  const invoke = (action, plan_id) => tool.execute("call", {
    action, request: plan_id === undefined ? "{}" : JSON.stringify({ plan_id }),
  }, undefined, undefined, ctx);
  const prompt = () => handlers.get("before_agent_start")({ systemPrompt: ["Host"] }, ctx);
  const boundId = async () => {
    const prepared = await prompt();
    return prepared.systemPrompt.find(section => section.includes("<!-- omp-rsi:current-plan:begin -->"));
  };

  const slow = pauseRead("older");
  const older = invoke("bind", "older");
  await slow.entered;
  assert.equal(JSON.parse((await invoke("unbind")).content[0].text).persisted, true);
  slow.release();
  await assert.rejects(older, /superseded/);
  assert.deepEqual(branch.map(entry => entry.data), [{ plan_id: null }]);
  assert.equal(await boundId(), undefined);

  const delayed = pauseRead("second");
  const second = invoke("bind", "second");
  await delayed.entered;
  await invoke("bind", "latest");
  delayed.release();
  await assert.rejects(second, /superseded/);
  assert.deepEqual(branch.map(entry => entry.data), [{ plan_id: null }, { plan_id: "latest" }]);
  assert.match(await boundId(), /Current bound plan latest, revision r1/);

  const snapshotGate = pauseRead("latest");
  const stalePrompt = prompt();
  await snapshotGate.entered;
  await invoke("bind", "recovery");
  snapshotGate.release();
  const stale = await stalePrompt;
  assert.equal(stale.systemPrompt.some(section => section.includes("<!-- omp-rsi:current-plan:begin -->")), false);
  assert.match(await boundId(), /Current bound plan recovery, revision r1/);

  const unbindGate = pauseRead("recovery");
  const staleAfterUnbind = prompt();
  await unbindGate.entered;
  await invoke("unbind");
  unbindGate.release();
  assert.equal((await staleAfterUnbind).systemPrompt.some(section => section.includes("<!-- omp-rsi:current-plan:begin -->")), false);
  assert.equal(await boundId(), undefined);
  await invoke("bind", "valid-again");
  assert.deepEqual(branch.at(-1).data, { plan_id: "valid-again" });
  assert.match(await boundId(), /Current bound plan valid-again, revision r1/);
});

test("create and amend cannot auto-bind a plan after a binding or session change", async () => {
  const handlers = new Map(), branches = new Map([["one", []], ["two", []]]);
  let session = "one", tool, held;
  const ctx = { sessionManager: { getSessionId: () => session, getBranch: () => branches.get(session) } };
  const string = { describe() { return this; }, optional() { return this; } };
  const pi = {
    zod: { string: () => string, boolean: () => string, object: value => value },
    on(name, handler) { handlers.set(name, handler); },
    registerTool(value) { tool = value; },
    appendEntry(customType, data) { branches.get(session).push({ type: "custom", customType, data }); },
  };
  const memory = async (_argv, { stdin }) => {
    const { action } = JSON.parse(stdin);
    if (action === held?.action) {
      const gate = held;
      held = undefined;
      gate.enter();
      await gate.wait;
    }
    return action === "read"
      ? JSON.stringify({ revision: "r1", plan: { template: { template_id: "coding" } }, validation: { complete: false } })
      : JSON.stringify({ plan: { plan_id: `${action}-plan` }, path: "/memory/plans/plan.md", revision: "r1", persistence: { saved: true } });
  };
  const pause = action => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    held = { action, enter, wait };
    return { entered, release };
  };
  const plans = createPlanSession(pi, memory);
  registerContractTools(pi, {}, { memory, planSession: plans });
  const invoke = action => tool.execute("call", { action, request: "{}" }, undefined, undefined, ctx);

  const createGate = pause("create");
  const creating = invoke("create");
  await createGate.entered;
  session = "two";
  handlers.get("session_switch")({}, ctx);
  createGate.release();
  assert.equal(JSON.parse((await creating).content[0].text).session_binding.bound, false);
  assert.deepEqual(branches.get("one"), []);
  assert.deepEqual(branches.get("two"), []);

  session = "one";
  handlers.get("session_switch")({}, ctx);
  const amendGate = pause("amend");
  const amending = invoke("amend");
  await amendGate.entered;
  await invoke("unbind");
  amendGate.release();
  assert.equal(JSON.parse((await amending).content[0].text).session_binding.bound, false);
  assert.deepEqual(branches.get("one").map(entry => entry.data), [{ plan_id: null }]);
  await invoke("create");
  assert.deepEqual(branches.get("one").at(-1).data, { plan_id: "create-plan" });
  assert.deepEqual(branches.get("two"), []);
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
