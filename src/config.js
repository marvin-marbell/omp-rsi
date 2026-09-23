import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defaultMemoryBase, runtimeConfig } from "../lib/runtime.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const PATHS = ["base", "runtimeDir", "gitnexusHome"];
const EXECUTABLES = ["memoryBin", "pythonBin", "bootstrapPython", "gitnexusBin", "npmBin"];
const BOOLEAN = ["typesafeEnabled", "rsiInstructionDiscoveryEnabled", "rsiTelemetryEnabled"];
const BOUNDS = {
	timeoutMs: [1, 600_000], setupTimeoutMs: [1, 3_600_000], gitnexusTimeoutMs: [1, 900_000],
	rsiLearningTimeoutMs: [1_000, 600_000], typesafeTimeoutMs: [1, 120_000],
	typesafeMaxRequestBytes: [1, 131_072], typesafeMaxResponseBytes: [1, 262_144], typesafeRetries: [0, 3],
};
const STRINGS = ["agentId", "typesafeEndpoint", "typesafeModel", "typesafeApiKeyEnv"];
const ALLOWED = new Set([...PATHS, ...EXECUTABLES, ...BOOLEAN, ...Object.keys(BOUNDS), ...STRINGS, "instructionFiles"]);

function readOperatorConfig(path) {
	if (!isAbsolute(path)) throw new Error("OMP_RSI_CONFIG must be an absolute operator-selected path");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) throw new Error("OMP_RSI_CONFIG must be a regular, singly linked file no larger than 64 KiB");
		const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_CONFIG_BYTES + 1));
		let size = 0;
		while (size < bytes.length) {
			const length = readSync(fd, bytes, size, bytes.length - size, null);
			if (!length) break;
			size += length;
		}
		if (size > MAX_CONFIG_BYTES) throw new Error("OMP_RSI_CONFIG exceeds 64 KiB");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
	} finally { closeSync(fd); }
}

/** Resolved once on plugin load. Only the operator can select settings, never tool arguments. */
export function resolveConfig(overrides = {}) {
	const path = process.env.OMP_RSI_CONFIG;
	const saved = path ? readOperatorConfig(path) : {};
	if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("OMP_RSI_CONFIG must contain a JSON object");
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("OMP RSI overrides must be an object");
	const selected = { ...saved, ...overrides };
	for (const key of Object.keys(selected)) if (!ALLOWED.has(key)) throw new Error(`Unknown OMP RSI configuration field: ${key}`);
	for (const field of PATHS) {
		if (selected[field] === undefined) continue;
		if (typeof selected[field] !== "string" || !isAbsolute(selected[field])) throw new Error(`${field} must be an absolute path`);
		selected[field] = resolve(selected[field]);
	}
	for (const field of EXECUTABLES) {
		if (selected[field] !== undefined && (typeof selected[field] !== "string" || !selected[field].trim())) throw new Error(`${field} must be a nonempty executable path or command`);
	}
	for (const field of STRINGS) {
		if (selected[field] !== undefined && (typeof selected[field] !== "string" || !selected[field].trim())) throw new Error(`${field} must be a nonempty string`);
	}
	for (const field of BOOLEAN) if (selected[field] !== undefined && typeof selected[field] !== "boolean") throw new Error(`${field} must be boolean`);
	for (const [field, [min, max]] of Object.entries(BOUNDS)) {
		if (selected[field] !== undefined && (!Number.isSafeInteger(selected[field]) || selected[field] < min || selected[field] > max)) throw new Error(`${field} must be an integer between ${min} and ${max}`);
	}
	if (selected.instructionFiles !== undefined && (!Array.isArray(selected.instructionFiles) || selected.instructionFiles.some(path => typeof path !== "string" || !isAbsolute(path)))) throw new Error("instructionFiles must be an array of absolute operator-selected paths");
	return runtimeConfig({
		base: defaultMemoryBase(), timeoutMs: 60_000, setupTimeoutMs: 600_000, gitnexusTimeoutMs: 120_000,
		rsiLearningTimeoutMs: 300_000, typesafeEnabled: false, rsiInstructionDiscoveryEnabled: false,
		rsiTelemetryEnabled: false, typesafeEndpoint: "https://api.typesafe.ai/v1/systemone", typesafeModel: "jev-latest",
		typesafeApiKeyEnv: "TYPESAFE_API_KEY", typesafeTimeoutMs: 20_000,
		typesafeMaxRequestBytes: 131_072, typesafeMaxResponseBytes: 262_144, typesafeRetries: 1,
		...selected,
		...(selected.instructionFiles ? { instructionFiles: [...selected.instructionFiles] } : {}),
	});
}
