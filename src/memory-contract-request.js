/** Validate the outer request without normalizing its JSON: the CLI must still see duplicate nested keys. */
export function contractRequestStdin(action, request, choices) {
	if (!choices.includes(action)) throw new Error(`action must be one of ${choices.join(", ")}`);
	let fields;
	try { fields = JSON.parse(request ?? "{}"); }
	catch { throw new Error("request must be a JSON object string"); }
	if (!fields || Array.isArray(fields) || typeof fields !== "object") {
		throw new Error("request must be a JSON object string");
	}
	if (Object.hasOwn(fields, "action")) throw new Error("Pass action separately, not inside request");
	const members = (request ?? "{}").trim().slice(1, -1).trim();
	return `{"action":${JSON.stringify(action)}${members ? "," + members : ""}}`;
}

export function contractCliArgs(command, args) {
	const argv = [command, "--request", "-"];
	if (args.no_git) argv.push("--no-git");
	if (args.allow_non_main_branch) argv.push("--allow-non-main-branch");
	return argv;
}
