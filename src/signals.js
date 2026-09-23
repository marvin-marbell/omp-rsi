import { createSessionSignals } from "../lib/rsi-signals.js";

/** Tool-result observation is opt-in and entirely local until explicit observe. */
export function createSignals(pi, config) {
	return createSessionSignals(pi, config);
}
