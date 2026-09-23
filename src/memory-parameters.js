export function requireChoice(tool, field, value, choices) {
	if (value !== undefined && !choices.includes(value)) {
		throw new Error(`${tool}: ${field} must be one of ${choices.join(", ")}`);
	}
}
