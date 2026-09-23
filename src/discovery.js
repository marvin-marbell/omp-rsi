import { createInstructionSourceDiscovery } from "../lib/rsi-source-discovery.js";

/** Public OMP skill snapshot; missing API remains an explicit coverage gap. */
export function createDiscovery(config, pi) {
	const getSkills = typeof pi?.pi?.getActiveSkills === "function" ? () => pi.pi.getActiveSkills() : undefined;
	return createInstructionSourceDiscovery(config, getSkills);
}
