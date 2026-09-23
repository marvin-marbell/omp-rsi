import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export const SOURCE_DISCOVERY_VERSION = "memory-rsi-source-discovery/2";
const FILE_READ_BUDGET = 128 * 1024;
const MAX_MEMBER_BODY_BYTES = 128 * 1024;
const MAX_MEMBERS = 64;
const MAX_CONFIGURED_FILES = 32;
const MAX_ERROR_DETAILS = 64;
const MAX_ERROR_DETAIL_BYTES = 512;
const MAX_ROUTE_PATH_BYTES = 512;
const MAX_ROUTE_MANIFEST_BYTES = 6 * 1024;
const MANAGED_POLICY_BEGIN = "<!-- memory-rsi:policy:begin -->";
const MANAGED_POLICY_END = "<!-- memory-rsi:policy:end -->";
const OMP_POLICY_BEGIN = "<!-- omp-rsi:canonical-policy:begin -->";
const OMP_POLICY_END = "<!-- omp-rsi:canonical-policy:end -->";

const hash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SAFE_ERROR_CODES = new Set(["SKILL_BODY_UNAVAILABLE", "CATALOG_INCOMPLETE", "EACCES", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOTDIR", "EPERM", "ERROR_LIMIT", "MANAGED_BLOCK_MALFORMED", "MEMBER_LIMIT", "ROUTE_INVALID", "SERVICE_UNAVAILABLE", "SOURCE_INVALID_UTF8", "SOURCE_NOT_REGULAR", "SOURCE_TOO_LARGE", "SOURCE_UNAVAILABLE"]);
const code = error => SAFE_ERROR_CODES.has(error?.code) ? error.code : "SOURCE_UNAVAILABLE";
const boundedDetail = value => clipUtf8(String(value), MAX_ERROR_DETAIL_BYTES).text || "source detail omitted";
const errorView = (error, memberId) => ({ member_id: memberId, code: code(error), detail: boundedDetail(error instanceof Error ? error.message : error) });
function boundedErrors(errors) {
	if (errors.length <= MAX_ERROR_DETAILS) return errors.map(error => ({ ...error, detail: boundedDetail(error.detail) }));
	return [
		...errors.slice(0, MAX_ERROR_DETAILS - 1).map(error => ({ ...error, detail: boundedDetail(error.detail) })),
		{ member_id: "discovery-errors", code: "ERROR_LIMIT", detail: `${errors.length - MAX_ERROR_DETAILS + 1} additional discovery errors omitted` },
	];
}
function boundedTargets(targets) {
	const selected = [];
	let bytes = 2;
	for (const target of targets) {
		const size = Buffer.byteLength(JSON.stringify(target));
		if (bytes + size + (selected.length ? 1 : 0) > MAX_ROUTE_MANIFEST_BYTES) continue;
		selected.push(target);
		bytes += size + (selected.length > 1 ? 1 : 0);
	}
	return { selected, omitted: targets.length - selected.length };
}

function clipUtf8(value, maxBytes) {
	const totalBytes = Buffer.byteLength(value);
	if (totalBytes <= maxBytes) return { text: value, total_bytes: totalBytes, retained_bytes: totalBytes, truncated: false };
	if (maxBytes <= 0) return { text: "", total_bytes: totalBytes, retained_bytes: 0, truncated: true };
	const marker = `\n...[truncated; original UTF-8 bytes: ${totalBytes}]`;
	const markerBytes = Buffer.byteLength(marker);
	if (markerBytes > maxBytes) return { text: "", total_bytes: totalBytes, retained_bytes: 0, truncated: true };
	const payloadBudget = maxBytes - markerBytes;
	const points = [...value];
	let low = 0, high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(points.slice(0, middle).join("")) <= payloadBudget) low = middle;
		else high = middle - 1;
	}
	const text = points.slice(0, low).join("") + marker;
	return { text, total_bytes: totalBytes, retained_bytes: Buffer.byteLength(text), truncated: true };
}

function stripManagedPolicyBlocks(value) {
	let body = value, count = 0, offset = 0;
	while (true) {
		const begin = body.indexOf(MANAGED_POLICY_BEGIN, offset);
		if (begin < 0) break;
		const end = body.indexOf(MANAGED_POLICY_END, begin + MANAGED_POLICY_BEGIN.length);
		if (end < 0) break;
		body = body.slice(0, begin) + body.slice(end + MANAGED_POLICY_END.length);
		count += 1;
		offset = begin;
	}
	return { body, count, malformed: body.includes(MANAGED_POLICY_BEGIN) || body.includes(MANAGED_POLICY_END) };
}

function readRegularText(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw Object.assign(new Error("instruction source is not a regular file"), { code: "SOURCE_NOT_REGULAR" });
		const limit = Math.min(stat.size, FILE_READ_BUDGET);
		const buffer = Buffer.alloc(limit);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		const truncated = stat.size > FILE_READ_BUDGET;
		let body;
		for (let trim = 0; trim <= (truncated ? 3 : 0); trim += 1) {
			try { body = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, Math.max(0, length - trim))); break; }
			catch (error) { if (trim === (truncated ? 3 : 0)) throw Object.assign(new Error(`instruction source is not valid UTF-8: ${error.message}`), { code: "SOURCE_INVALID_UTF8" }); }
		}
		return { body, truncated, total_bytes: stat.size };
	} finally { closeSync(fd); }
}

function collectClass({ id, kind, scope, members, expectedTotal = members.length, complete = true, errors = [], owner, workflow }) {
	const discovered = members.slice(0, MAX_MEMBERS);
	const allErrors = [...errors];
	if (members.length > discovered.length) allErrors.push({ member_id: id, code: "MEMBER_LIMIT", detail: `${members.length - discovered.length} additional source members omitted` });
	const accepted = [];
	for (const member of discovered) {
		const bodyBytes = Buffer.byteLength(member.body);
		if (bodyBytes > MAX_MEMBER_BODY_BYTES) {
			allErrors.push({ member_id: member.id, code: "SOURCE_TOO_LARGE", detail: `source member exceeds ${MAX_MEMBER_BODY_BYTES} bytes and was omitted rather than clipped` });
			continue;
		}
		accepted.push({
			id: member.id, class_id: id, kind, scope, body: member.body, revision: hash(member.body),
			metadata: { id: member.id, revision: hash(member.body), ...member.metadata },
		});
	}
	const routed = boundedTargets(accepted.map(member => {
		const original = discovered.find(candidate => candidate.id === member.id);
		return { member_id: member.id, ...original.route };
	}));
	const omittedMembers = Math.max(0, expectedTotal - accepted.length);
	const sourceComplete = complete && allErrors.length === 0 && omittedMembers === 0;
	return {
		members: accepted,
		coverage: {
			kind, source_id: id, members_total: expectedTotal, members_included: accepted.length,
			omitted_members: omittedMembers, route_limited_members: routed.omitted, truncated_members: 0,
			body_bytes: accepted.reduce((sum, member) => sum + Buffer.byteLength(member.body), 0),
			source_complete: sourceComplete, routing_complete: routed.omitted === 0,
			complete: sourceComplete && routed.omitted === 0, errors: boundedErrors(allErrors),
		},
		route: {
			source_id: id, kind, owner, workflow, apply: "explicit-review-only", targets: routed.selected,
		},
	};
}

async function discoverSystemPrompt(ctx) {
	try {
		const sections = ctx.getSystemPrompt();
		if (!Array.isArray(sections) || sections.some(section => typeof section !== "string")) throw Object.assign(new Error("Current OMP prompt sections unavailable"), { code: "SERVICE_UNAVAILABLE" });
		// OMP exposes effective text, not a provider/source manifest. Retain the
		// whole admitted text as one member; the canonical policy is a separate
		// bound source, so omit only our exact injected policy section.
		const policySections = sections.filter(section => section.startsWith(OMP_POLICY_BEGIN) || section.includes(OMP_POLICY_END));
		const malformed = policySections.some(section => !(section.startsWith(`${OMP_POLICY_BEGIN}\n`) && section.endsWith(`\n${OMP_POLICY_END}`)));
		const admittedSections = sections.filter(section => !policySections.includes(section));
		const original = sections.join("\n\n");
		const stripped = stripManagedPolicyBlocks(admittedSections.join("\n\n"));
		const errors = malformed || stripped.malformed ? [{ member_id: "system-prompt", code: "MANAGED_BLOCK_MALFORMED", detail: "managed policy markers are unbalanced; system prompt omitted" }] : [];
		const members = !errors.length && stripped.body.trim() ? [{
			id: "system:effective-current", body: stripped.body,
			metadata: { form: "effective-prompt", raw_revision: hash(original), raw_bytes: Buffer.byteLength(original), managed_policy_mirrors_excluded: stripped.count, canonical_policy_sections_excluded: policySections.length },
			route: { type: "current-system-prompt", workflow: "provider-or-composition-review" },
		}] : [];
		const result = collectClass({
			id: "system-current", kind: "system",
			scope: "Current OMP effective system prompt at audit time, excluding canonical policy and managed mirrors captured separately; provider boundaries and ownership are unavailable.",
			members, expectedTotal: original.trim() ? 1 : 0, complete: errors.length === 0, errors,
			owner: "system-prompt-providers", workflow: "provider-or-composition-review",
		});
		result.coverage.sections_total = sections.length;
		result.coverage.sections_scanned = sections.length;
		result.coverage.managed_policy_mirrors_excluded = stripped.count + policySections.length;
		result.coverage.original_assembled_bytes = Buffer.byteLength(original);
		result.coverage.admitted_assembled_bytes = members.reduce((total, member) => total + Buffer.byteLength(member.body), 0);
		result.coverage.assembly_byte_scope = "Current effective prompt text, without provider-level attribution; managed policy mirrors excluded and canonical policy separately captured.";
		return result;
	} catch (error) {
		return collectClass({ id: "system-current", kind: "system", scope: "Current effective system prompt", members: [], expectedTotal: 1, complete: false, errors: [errorView(error, "system-prompt")], owner: "system-prompt-providers", workflow: "provider-or-composition-review" });
	}
}

function discoverInstructionFiles(config) {
	const members = [], errors = [], managedPolicyTargets = [];
	const configuredFiles = config.instructionFiles ?? [];
	const scannedFiles = configuredFiles.slice(0, MAX_CONFIGURED_FILES);
	let managedMirrors = 0;
	for (const [index, path] of scannedFiles.entries()) {
		const memberId = typeof path === "string" ? `instruction-file:${hash(path).slice(7, 19)}` : `instruction-file:${index}`;
		try {
			if (typeof path !== "string" || !path || Buffer.byteLength(path) > MAX_ROUTE_PATH_BYTES) throw Object.assign(new Error("configured instruction-file route is invalid or too long"), { code: "ROUTE_INVALID" });
			const route = { type: "instruction-file", path, unmanaged_workflow: "file-owner-review", managed_policy_workflow: "memory_policy-sync" };
			const read = readRegularText(path);
			if (read.truncated) throw Object.assign(new Error(`instruction source exceeds ${FILE_READ_BUDGET} bytes; select a narrower explicit source`), { code: "SOURCE_TOO_LARGE" });
			const stripped = stripManagedPolicyBlocks(read.body);
			if (stripped.malformed) throw Object.assign(new Error("instruction source has unbalanced memory-rsi managed policy markers"), { code: "MANAGED_BLOCK_MALFORMED" });
			managedMirrors += stripped.count;
			if (stripped.count) managedPolicyTargets.push({ type: "managed-policy-mirror", path, workflow: "memory_policy-sync" });
			if (!stripped.body.trim()) continue;
			members.push({ id: memberId, body: stripped.body, metadata: { raw_revision: hash(read.body), raw_bytes: read.total_bytes, managed_policy_mirrors_excluded: stripped.count }, route });
		} catch (error) { errors.push(errorView(error, memberId)); }
	}
	if (configuredFiles.length > scannedFiles.length) errors.push({ member_id: "instruction-files", code: "MEMBER_LIMIT", detail: `${configuredFiles.length - scannedFiles.length} additional configured instruction files omitted` });
	const boundedManaged = boundedTargets(managedPolicyTargets);
	if (boundedManaged.omitted) errors.push({ member_id: "managed-policy-mirrors", code: "MEMBER_LIMIT", detail: `${boundedManaged.omitted} managed policy owner routes omitted by the route budget` });
	const result = collectClass({
		id: "agents-configured", kind: "agents",
		scope: "Unmanaged content from operator-configured AGENTS-like instruction files. Managed memory-rsi policy mirrors are excluded and remain owned by memory_policy sync.",
		members, expectedTotal: members.length, complete: errors.length === 0,
		errors, owner: "instruction-file-owners", workflow: "file-owner-review-or-memory-policy-sync",
	});
	result.route.managed_policy_targets = boundedManaged.selected;
	result.coverage.managed_policy_targets_omitted = boundedManaged.omitted;
	result.coverage.configured_files_total = configuredFiles.length;
	result.coverage.configured_files_scanned = scannedFiles.length;
	result.coverage.configured_files_omitted = configuredFiles.length - scannedFiles.length;
	result.coverage.managed_policy_mirrors_excluded = managedMirrors;
	return result;
}

async function discoverSkills(getSkills, signal) {
	const unavailable = (code, detail) => collectClass({
		id: "skills-active", kind: "skill", scope: "Active model-invocable OMP skills from the public process-active catalog",
		members: [], expectedTotal: 1, complete: false,
		errors: [{ member_id: "skills-catalog", code, detail }],
		owner: "skill-providers", workflow: "skill-owner-review",
	});
	if (typeof getSkills !== "function") return unavailable("SERVICE_UNAVAILABLE", "Public active-skill catalog was not provided; select skill bodies explicitly for a source audit");
	try {
		const catalog = await getSkills();
		if (!Array.isArray(catalog)) return unavailable("CATALOG_INCOMPLETE", "Public active-skill catalog returned no complete array");
		const visible = catalog.filter(skill => skill?.hide !== true);
		const members = [], errors = [], names = new Set();
		for (const [index, skill] of visible.slice(0, MAX_MEMBERS).entries()) {
			const memberId = `skill:${index + 1}`;
			try {
				signal?.throwIfAborted();
				if (typeof skill?.name !== "string" || !skill.name.trim() || Buffer.byteLength(skill.name) > 128
					|| typeof skill.filePath !== "string" || !isAbsolute(skill.filePath)
					|| Buffer.byteLength(skill.filePath) > MAX_ROUTE_PATH_BYTES)
					throw Object.assign(new Error("active skill has an invalid name or file route"), { code: "ROUTE_INVALID" });
				if (names.has(skill.name)) throw Object.assign(new Error("duplicate active skill name"), { code: "CATALOG_INCOMPLETE" });
				names.add(skill.name);
				const path = realpathSync(skill.filePath);
				if (skill.containRoot !== undefined) {
					if (typeof skill.containRoot !== "string" || !isAbsolute(skill.containRoot))
						throw Object.assign(new Error("active skill containment root is invalid"), { code: "ROUTE_INVALID" });
					const root = realpathSync(skill.containRoot);
					if (!statSync(root).isDirectory()) throw Object.assign(new Error("active skill containment root is not a directory"), { code: "ROUTE_INVALID" });
					const rel = relative(root, path);
					if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))
						throw Object.assign(new Error("active skill escapes its declared containment root"), { code: "ROUTE_INVALID" });
				}
				const read = readRegularText(path);
				if (read.truncated) throw Object.assign(new Error(`skill body exceeds ${FILE_READ_BUDGET} bytes; source omitted rather than clipped`), { code: "SOURCE_TOO_LARGE" });
				// Match OMP's buildSkillPromptMessage body projection exactly.
				const body = read.body.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
				if (!body) throw Object.assign(new Error("active skill has no model-visible body"), { code: "SKILL_BODY_UNAVAILABLE" });
				members.push({
					id: `skill:${hash(skill.name).slice(7, 23)}`, body,
					metadata: { name: skill.name, raw_revision: hash(read.body), raw_bytes: read.total_bytes, body_projection: "omp-skill-body" },
					route: { type: "skill", name: skill.name, path: skill.filePath, workflow: "skill-owner-review" },
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				errors.push(errorView(error, memberId));
			}
		}
		if (visible.length > MAX_MEMBERS) errors.push({ member_id: "skills-active", code: "MEMBER_LIMIT", detail: `${visible.length - MAX_MEMBERS} active visible skill bodies omitted` });
		const result = collectClass({
			id: "skills-active", kind: "skill",
			scope: "Exact OMP body projection of active visible skills from the public process-active snapshot. Catalog scope is process-global, not independently attested per subagent.",
			members, expectedTotal: visible.length, complete: errors.length === 0, errors,
			owner: "skill-providers", workflow: "skill-owner-review",
		});
		result.coverage.skills_total = catalog.length;
		result.coverage.model_invocable_total = visible.length;
		result.coverage.user_only_excluded = catalog.length - visible.length;
		result.coverage.body_projection = "omp-skill-body-exact";
		result.coverage.routing_text_in_body = false;
		result.coverage.loader_wrappers_in_body = false;
		result.coverage.projection_omissions = ["frontmatter", "catalog routing text", "runtime loader wrappers and invocation arguments"];
		return result;
	} catch (error) {
		if (signal?.aborted) throw error;
		return unavailable("CATALOG_INCOMPLETE", "Public active-skill catalog could not be read completely");
	}
}

export function discoveryAssessmentSummary(discovery) {
	return {
		mode: discovery.mode,
		requested_classes: ["system", "agents", "skill"],
		agent_scoped: discovery.agent_scoped,
		complete: discovery.complete,
		classes: discovery.classes.map(item => ({
			kind: item.kind, source_id: item.source_id, members_total: item.members_total,
			members_included: item.members_included, omitted_members: item.omitted_members,
			route_limited_members: item.route_limited_members, truncated_members: item.truncated_members,
			source_complete: item.source_complete, routing_complete: item.routing_complete, complete: item.complete,
			...(Number.isSafeInteger(item.configured_files_total) ? { configured_files_total: item.configured_files_total, configured_files_scanned: item.configured_files_scanned, configured_files_omitted: item.configured_files_omitted, managed_policy_targets_omitted: item.managed_policy_targets_omitted } : {}),
			...(Number.isSafeInteger(item.sections_total) ? { sections_total: item.sections_total, sections_scanned: item.sections_scanned,
				original_assembled_bytes: item.original_assembled_bytes, admitted_assembled_bytes: item.admitted_assembled_bytes, assembly_byte_scope: item.assembly_byte_scope } : {}),
			...(Number.isSafeInteger(item.skills_total) ? { skills_total: item.skills_total, model_invocable_total: item.model_invocable_total, user_only_excluded: item.user_only_excluded,
				body_projection: item.body_projection, routing_text_in_body: item.routing_text_in_body, loader_wrappers_in_body: item.loader_wrappers_in_body, projection_omissions: item.projection_omissions } : {}),
			error_codes: item.errors.map(error => error.code),
		})),
	};
}

export function createInstructionSourceDiscovery(config, getSkills) {
	return async function discover(ctx, signal) {
		if (config.rsiInstructionDiscoveryEnabled !== true) throw new Error("Automatic instruction discovery is disabled; the operator must set rsiInstructionDiscoveryEnabled after reviewing system-prompt, AGENTS and skill disclosure");
		if (!ctx?.sessionManager?.getSessionId?.()) throw new Error("Automatic instruction discovery requires the current OMP session; explicit source audits remain available without it");
		signal?.throwIfAborted();
		const [system, agents, skills] = await Promise.all([
			discoverSystemPrompt(ctx), Promise.resolve(discoverInstructionFiles(config)), discoverSkills(getSkills, signal),
		]);
		signal?.throwIfAborted();
		const classes = [system.coverage, agents.coverage, skills.coverage];
		return {
			members: [...system.members, ...agents.members, ...skills.members],
			discovery: {
				schema: SOURCE_DISCOVERY_VERSION, mode: "automatic-current-session-visible-sources",
				captured_at: new Date().toISOString(), provenance: "current-omp-session-prompt-and-process-active-skill-snapshot-at-audit-time",
				agent_scoped: false, complete: classes.every(item => item.complete),
				classes, routes: [system.route, agents.route, skills.route],
				disclosure: "Included source members are retained in full locally and assessed as complete members or complete non-overlapping chunks. Skill catalog is a public process-active snapshot, not independently scoped per subagent; omitted or unreadable skill bodies are reported. Remote assessment requires separate typesafeEnabled and rsiInstructionDiscoveryEnabled opt-ins.",
			},
		};
	};
}
