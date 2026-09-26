import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverCode as discoverCodeEngine, formatCodeDiscovery } from "../lib/code-discovery.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "memory-code-discovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(cwd);
	return { root, cwd };
}

async function source(cwd, rel, contents) {
	const path = join(cwd, rel);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
	return createHash("sha256").update(contents).digest("hex");
}

function hit(rel, start, end, snippet = "stale backend snippet", score = 0.8) {
	return { rel, nameScore: score, contentScore: score, ranges: [{ start, end, p: score, snippet }], linesSeen: end, truncated: false };
}

function backend(cwd, hits, stats = {}) {
	return async () => ({ code: 0, stderr: "", stdout: JSON.stringify({
		root: cwd, query: "find implementation", hits,
		stats: { listed: hits.length, judged: hits.length, filesRead: hits.length, errors: 0, failures: [], ...stats },
	}) });
}

async function discoverCode(args, options = {}) {
	return discoverCodeEngine(args, { approvedRoots: [args.cwd], ...options });
}

test("unapproved repositories fail before invoking the model-backed locator", async t => {
	const { cwd } = await fixture(t);
	let called = false;
	await assert.rejects(discoverCodeEngine({ cwd, query: "where is evidence validated?" }, {
		runner: async () => { called = true; throw Error("must never run"); },
	}), /not operator-approved/);
	assert.equal(called, false);
});

test("an omitted filename score preserves a content hit and reports backend uncertainty", async t => {
	const { cwd } = await fixture(t);
	await source(cwd, "src/accepted.py", "def validate_accepted_artifact_paths(root):\n    return root\n");
	const candidate = hit("src/accepted.py", 1, 2);
	delete candidate.nameScore;
	const result = await discoverCode({ cwd, query: "find implementation" }, {
		runner: backend(cwd, [candidate], { errors: 1 }),
	});
	assert.equal(result.status, "partial");
	assert.equal(result.locations[0].rel, "src/accepted.py");
	assert.match(formatCodeDiscovery(result), /def validate_accepted_artifact_paths/);
});

test("high-scoring cross-root and symlink leads cannot disclose secrets or hide a safe hit", async t => {
	const { root, cwd } = await fixture(t);
	const privatePath = join(root, "external-credential-canary.js");
	await writeFile(privatePath, "DO_NOT_EXPOSE_PRIVATE_TOKEN_42\n");
	await source(cwd, "src/safe.js", "export function renderGreeting() { return 'safe greeting'; }\n");
	await symlink(privatePath, join(cwd, "shortcut.js"));
	const hits = [
		hit("../external-credential-canary.js", 1, 1, "DO_NOT_EXPOSE_PRIVATE_TOKEN_42", 0.99),
		hit(privatePath, 1, 1, "DO_NOT_EXPOSE_PRIVATE_TOKEN_42", 0.98),
		hit("shortcut.js", 1, 1, "DO_NOT_EXPOSE_PRIVATE_TOKEN_42", 0.97),
		hit("src/safe.js", 1, 1, "stale greeting", 0.6),
	];
	const result = await discoverCode({ cwd, query: "find implementation", keywords: ["renderGreeting"] }, { runner: backend(cwd, hits) });
	const visible = JSON.stringify(result) + formatCodeDiscovery(result);
	assert.equal(result.status, "partial");
	assert.deepEqual(result.locations.map(location => location.rel), ["src/safe.js"]);
	assert.match(visible, /safe greeting/);
	assert.doesNotMatch(visible, /external-credential-canary|shortcut\.js|DO_NOT_EXPOSE_PRIVATE_TOKEN_42/);
});

test("a broad upstream range resolves to precise numbered current source with its read-time hash", async t => {
	const { cwd } = await fixture(t);
	const lines = Array.from({ length: 180 }, (_, index) => `// unrelated padding ${String(index + 1).padStart(3, "0")} ${"z".repeat(85)}`);
	lines[92] = "export function calculateInvoiceTotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }";
	const current = lines.join("\n") + "\n";
	const sha256 = await source(cwd, "src/invoices.js", current);
	const result = await discoverCode({ cwd, query: "find implementation", keywords: ["calculateInvoiceTotal"], source_bytes: 2048 }, {
		runner: backend(cwd, [hit("src/invoices.js", 1, 180, "OLD_IMPLEMENTATION_DO_NOT_REPEAT")]),
	});
	const excerpt = result.excerpts.find(item => item.rel === "src/invoices.js");
	assert.notEqual(result.status, "no_leads");
	assert.equal(excerpt.sha256, `sha256:${sha256}`);
	assert.ok(excerpt.lines.some(line => line.number === 93 && line.text === lines[92]), "the selected excerpt must contain the actual matching source line");
	const rendered = formatCodeDiscovery(result);
	assert.match(rendered, /93:.*calculateInvoiceTotal/);
	assert.match(rendered, new RegExp(sha256));
	assert.doesNotMatch(JSON.stringify(result) + rendered, /OLD_IMPLEMENTATION_DO_NOT_REPEAT/);
	assert.ok(Buffer.byteLength(excerpt.lines.map(line => line.text).join("\n")) <= 2048);
});

test("excerpt budget does not erase safe locations from a larger result set", async t => {
	const { cwd } = await fixture(t);
	const hits = [];
	for (let index = 0; index < 24; index++) {
		const rel = `src/module-${String(index).padStart(2, "0")}.js`;
		await source(cwd, rel, `export function queryModule${index}() { return ${index}; }\n` + ("// useful but lengthy source context\n".repeat(100)));
		hits.push(hit(rel, 1, 101));
	}
	const result = await discoverCode({ cwd, query: "find implementation", keywords: ["queryModule"], source_bytes: 2048 }, { runner: backend(cwd, hits) });
	const rendered = formatCodeDiscovery(result);
	assert.equal(result.locations.length, hits.length);
	assert.deepEqual(new Set(result.locations.map(item => item.rel)), new Set(hits.map(item => item.rel)));
	for (const { rel } of hits) assert.ok(rendered.includes(rel), `missing safe file lead ${rel}`);
	assert.ok(result.excerpts.length < result.locations.length, "source clipping must not masquerade as an empty file search");
	assert.notEqual(result.status, "no_leads");
});

test("backend uncertainty and read failures cannot become clean no-match", async t => {
	const { cwd } = await fixture(t);
	await source(cwd, "src/known.js", "export const knownResult = true;\n");
	const uncertain = await discoverCode({ cwd, query: "find implementation", keywords: ["knownResult"] }, {
		runner: backend(cwd, [hit("src/known.js", 1, 1), hit("src/missing.js", 1, 1)], { errors: 1, failures: [{ error: "index incomplete" }] }),
	});
	assert.equal(uncertain.status, "partial");
	assert.ok(uncertain.locations.some(item => item.rel === "src/known.js"));
	assert.ok(uncertain.warnings.length > 0);
	const emptyButFailed = await discoverCode({ cwd, query: "find implementation" }, { runner: backend(cwd, [], { failures: [{ error: "index incomplete" }] }) });
	assert.equal(emptyButFailed.status, "partial");
	assert.ok(emptyButFailed.warnings.length > 0);
	await assert.rejects(discoverCode({ cwd, query: "find implementation" }, { runner: async () => ({ code: 0, stdout: "not json", stderr: "" }) }));
	await assert.rejects(discoverCode({ cwd, query: "find implementation" }, { runner: async () => { throw Error("backend unavailable"); } }));
});

test("implementation and its matching test remain traceable as separate current-source leads", async t => {
	const { cwd } = await fixture(t);
	const impl = "export function routeInvoice(request) { return request.invoiceId; }\n";
	const check = "import { routeInvoice } from '../src/invoices.js';\nassert.equal(routeInvoice({ invoiceId: 17 }), 17);\n";
	const implHash = await source(cwd, "src/invoices.js", impl);
	const testHash = await source(cwd, "tests/invoices.test.js", check);
	const result = await discoverCode({ cwd, query: "find implementation", keywords: ["routeInvoice"] }, {
		runner: backend(cwd, [hit("src/invoices.js", 1, 1), hit("tests/invoices.test.js", 1, 2)]),
	});
	assert.deepEqual(new Set(result.locations.map(item => item.rel)), new Set(["src/invoices.js", "tests/invoices.test.js"]));
	assert.equal(result.excerpts.find(item => item.rel === "src/invoices.js").sha256, `sha256:${implHash}`);
	assert.equal(result.excerpts.find(item => item.rel === "tests/invoices.test.js").sha256, `sha256:${testHash}`);
	const rendered = formatCodeDiscovery(result);
	assert.match(rendered, /src\/invoices\.js/);
	assert.match(rendered, /tests\/invoices\.test\.js/);
	assert.match(rendered, /1:.*function routeInvoice/);
	assert.match(rendered, /2:.*assert\.equal\(routeInvoice/);
});
