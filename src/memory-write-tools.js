import { textResult } from "./memory-output.js";
import { requireChoice } from "./memory-parameters.js";

/** Register CLI-backed memory entry creation and revision tools. */
export function registerMemoryWriteTools(pi, config, { memory }) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_new",
		label: "Create memory",
		description: "Create a new memory entry with validated YAML frontmatter. The CLI commits and pushes to the memory repo automatically unless no_git is set.",
		parameters: z.object({
			name: z.string().describe("Entry file name (slug)."),
			description: z.string().describe("One-line description for the frontmatter."),
			body: z.string().optional().describe("Full body content of the entry."),
			author: z.string().optional().describe("Agent ID override (default: configured agent ID)."),
			tags: z.string().optional().describe("Comma-separated tags."),
			category: z.string().optional().describe("Category subdirectory: atlas, efforts, calendar, moc, or a configured custom category."),
			confidence: z.string().optional().describe("Confidence level: established, working, or exploratory."),
			status: z.string().optional().describe("Entry status: active, archived, or draft. Default: active."),
			shared: z.boolean().optional().describe("Write to memory/shared/ instead of memory/{agent_id}/."),
			no_git: z.boolean().optional().describe("Skip git add/commit/push."),
			allow_non_main_branch: z.boolean().optional().describe("Allow committing while HEAD is on a non-default branch."),
		}),
		approval: "exec",
		async execute(_id, args, signal) {
			requireChoice("memory_new", "confidence", args.confidence, ["established", "working", "exploratory"]);
			requireChoice("memory_new", "status", args.status, ["active", "archived", "draft"]);
			const argv = ["new", args.name, "--description", args.description];
			const author = args.author ?? config.agentId;
			if (author) argv.push("--author", author);
			if (args.tags) argv.push("--tags", args.tags);
			if (args.category) argv.push("--category", args.category);
			if (args.confidence) argv.push("--confidence", args.confidence);
			if (args.status) argv.push("--status", args.status);
			if (args.shared) argv.push("--shared");
			if (args.no_git) argv.push("--no-git");
			if (args.allow_non_main_branch) argv.push("--allow-non-main-branch");
			// Stdin preserves multiline bodies without argv-length limits.
			if (args.body !== undefined && args.body !== "") {
				argv.push("--body", "-");
				return textResult(await memory(argv, { signal, stdin: args.body }));
			}
			return textResult(await memory(argv, { signal }));
		},
	});

	pi.registerTool({
		name: "memory_update",
		label: "Update memory",
		description: "Update an existing memory entry: replace the body or section, adjust tags/confidence/status. Commits and pushes unless no_git is set.",
		parameters: z.object({
			file_path: z.string().describe("Path of the markdown memory entry."),
			body: z.string().optional().describe("New body content (replaces the entry body)."),
			tags: z.string().optional().describe("Replace tags (comma-separated)."),
			add_tags: z.string().optional().describe("Append tags (comma-separated)."),
			confidence: z.string().optional().describe("Confidence level: established, working, or exploratory."),
			status: z.string().optional().describe("Status: active, archived, or draft."),
			no_git: z.boolean().optional().describe("Skip git add/commit/push."),
			allow_non_main_branch: z.boolean().optional().describe("Allow committing while HEAD is on a non-default branch."),
		}),
		approval: "exec",
		async execute(_id, args, signal) {
			requireChoice("memory_update", "confidence", args.confidence, ["established", "working", "exploratory"]);
			requireChoice("memory_update", "status", args.status, ["active", "archived", "draft"]);
			const argv = ["update", args.file_path];
			if (args.tags) argv.push("--tags", args.tags);
			if (args.add_tags) argv.push("--add-tags", args.add_tags);
			if (args.confidence) argv.push("--confidence", args.confidence);
			if (args.status) argv.push("--status", args.status);
			if (args.no_git) argv.push("--no-git");
			if (args.allow_non_main_branch) argv.push("--allow-non-main-branch");
			if (args.body !== undefined && args.body !== "") {
				argv.push("--body", "-");
				return textResult(await memory(argv, { signal, stdin: args.body }));
			}
			return textResult(await memory(argv, { signal }));
		},
	});
}
