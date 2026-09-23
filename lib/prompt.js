import { openSync, readSync, closeSync, realpathSync, fstatSync, constants } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_POLICY_BYTES = 131072;
const MAX_POLICY_CHARS = 32768;
const DEFAULT_POLICY = fileURLToPath(new URL("../cli/src/agent_memory/default_policy.md", import.meta.url));


function boundedRead(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("policy is not a regular file");
		const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		// Count Unicode code points, matching the Python policy writer.
		// Never inject a truncated instruction whose meaning could change.
		if (length > MAX_POLICY_BYTES || [...text].length > MAX_POLICY_CHARS) throw new Error("policy exceeds 32768 characters or 131072 bytes");
		if (!text.trim()) throw new Error("policy is empty");
		return text;
	} finally { closeSync(fd); }
}

export function policyText(config) {
	const base = config.base || process.env.AGENT_MEMORY_PATH;
	if (base) {
		try {
			const root = realpathSync(resolve(base));
			const policy = realpathSync(join(root, "shared", "policies", "agent-policy.md"));
			const rel = relative(root, policy);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("policy path escapes memory base");
			return boundedRead(policy);
		} catch (error) {
			if (error.code !== "ENOENT") {
				return `Editable memory policy could not be loaded: ${error.message}. Read and repair it with memory_policy; do not assume it was applied.\n\n${boundedRead(DEFAULT_POLICY)}`;
			}
		}
	}
	return boundedRead(DEFAULT_POLICY);
}

