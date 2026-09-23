const MAX_OUTPUT_CHARS = 100_000;
const TRUNCATED = `\n…(truncated at ${MAX_OUTPUT_CHARS} characters; narrow the query)`;

export function clip(text) {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS - TRUNCATED.length)}${TRUNCATED}`
		: text;
}

export function textResult(text) {
	return { content: [{ type: "text", text: clip(text) }] };
}
