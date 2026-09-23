import { createInstructionSourceDiscovery } from "../lib/rsi-source-discovery.js";

/** Automatic capture uses only the invoking session's current OMP context. */
export function createDiscovery(config) {
	return createInstructionSourceDiscovery(config);
}
