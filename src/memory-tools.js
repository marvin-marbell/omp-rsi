import { textResult } from "./memory-output.js";

function requireChoice(tool, field, value, choices) {
	if (value !== undefined && !choices.includes(value)) {
		throw new Error(`${tool}: ${field} must be one of ${choices.join(", ")}`);
	}
}

/** Register the CLI-backed memory discovery, writing, and maintenance tools. */
export function registerMemoryTools(pi, config, { memory }) {
	const z = pi.zod;

	pi.registerTool({
		name: "memory_ls",
		label: "List memory",
		description: "List the agent-memory directory tree with progressive disclosure: directories first, then markdown entries with their frontmatter summaries. Start here to discover what memory exists.",
		parameters: z.object({ path: z.string().optional().describe("Subdirectory to list, relative to the memory base. Defaults to the root.") }),
		approval: "read",
		async execute(_id, args, signal) {
			const argv = ["ls"];
			if (args.path) argv.push(args.path);
			return textResult(await memory(argv, { signal }));
		},
	});

	pi.registerTool({
		name: "memory_toc",
		label: "Memory contents",
		description: "Show the table of contents of one memory entry: its frontmatter summary and section titles, without full section bodies.",
		parameters: z.object({ file_path: z.string().describe("Path of the markdown memory entry.") }),
		approval: "read",
		async execute(_id, args, signal) {
			return textResult(await memory(["toc", args.file_path], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_section",
		label: "Read memory section",
		description: "Read one section of a memory entry by (partial) title. The narrowest read: prefer this over reading whole files.",
		parameters: z.object({
			file_path: z.string().describe("Path of the markdown memory entry."),
			title: z.string().describe("Section title; partial matches are accepted."),
		}),
		approval: "read",
		async execute(_id, args, signal) {
			return textResult(await memory(["section", args.file_path, args.title], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Search memory",
		description: "BM25 relevance-ranked search over memory sections, with frontmatter filters (category, confidence, author, status, tag). Returns best-passage snippets. Prefer this for semantic questions over memory_grep.",
		parameters: z.object({
			query: z.string().describe("Natural-language query."),
			scope: z.string().optional().describe("Directory scope: all, own, or shared. Default: all."),
			field: z.string().optional().describe("Ranking field: description, tags, or content. Default: content."),
			category: z.string().optional().describe("Filter by category."),
			tag: z.string().optional().describe("Filter by tag."),
			limit: z.number().optional().describe("Maximum results (default 10)."),
			no_cache: z.boolean().optional().describe("Bypass the SQLite index cache and read files directly."),
			include_sources: z.boolean().optional().describe("Also search configured additional sources (rules, skills)."),
		}),
		approval: "read",
		async execute(_id, args, signal) {
			requireChoice("memory_search", "scope", args.scope, ["all", "own", "shared"]);
			requireChoice("memory_search", "field", args.field, ["description", "tags", "content"]);
			const argv = ["search", args.query];
			if (args.scope) argv.push("--scope", args.scope);
			if (args.field) argv.push("--field", args.field);
			if (args.category) argv.push("--category", args.category);
			if (args.tag) argv.push("--tag", args.tag);
			if (args.limit !== undefined) argv.push("--limit", String(Math.trunc(args.limit)));
			if (args.no_cache) argv.push("--no-cache");
			if (args.include_sources) argv.push("--include-sources");
			return textResult(await memory(argv, { signal }));
		},
	});

	pi.registerTool({
		name: "memory_grep",
		label: "Grep memory",
		description: "Exact or regex search over memory content via ripgrep. Use for identifiers, error strings, and exact phrases.",
		parameters: z.object({
			pattern: z.string().describe("Regex or literal pattern."),
			fixed_strings: z.boolean().optional().describe("Treat the pattern as a literal string."),
			ignore_case: z.boolean().optional().describe("Case-insensitive match."),
			context: z.number().optional().describe("Lines of context around each match."),
			scope: z.string().optional().describe("Directory scope: all, own, or shared."),
		}),
		approval: "read",
		async execute(_id, args, signal) {
			requireChoice("memory_grep", "scope", args.scope, ["all", "own", "shared"]);
			const argv = ["grep", args.pattern];
			if (args.fixed_strings) argv.push("--fixed-strings");
			if (args.ignore_case) argv.push("--ignore-case");
			if (args.context !== undefined) argv.push("--context", String(Math.trunc(args.context)));
			if (args.scope) argv.push("--scope", args.scope);
			return textResult(await memory(argv, { signal }));
		},
	});

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

	pi.registerTool({
		name: "memory_validate",
		label: "Validate memory",
		description: "Validate memory entries against the frontmatter schema (frontmatter fields, enums, cross-references).",
		parameters: z.object({ path: z.string().describe("Entry file or directory to validate.") }),
		approval: "read",
		async execute(_id, args, signal) {
			return textResult(await memory(["validate", args.path], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_init",
		label: "Initialize memory agent",
		description: "Initialize the directory structure for a new agent inside the memory repo.",
		parameters: z.object({ agent_id: z.string().describe("Identifier of the agent to initialize.") }),
		approval: "exec",
		async execute(_id, args, signal) {
			return textResult(await memory(["init", args.agent_id], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_sync",
		label: "Sync memory repository",
		description: "Sync the memory repo with its git remote (pull and push). Use after or before long offline stretches.",
		parameters: z.object({
			pull_only: z.boolean().optional().describe("Only pull."),
			push_only: z.boolean().optional().describe("Only push."),
		}),
		approval: "exec",
		async execute(_id, args, signal) {
			const argv = ["sync"];
			if (args.pull_only) argv.push("--pull-only");
			if (args.push_only) argv.push("--push-only");
			return textResult(await memory(argv, { signal }));
		},
	});

	pi.registerTool({
		name: "memory_clone",
		label: "Clone memory repository",
		description: "Clone the configured memory repository locally for offline access.",
		parameters: z.object({}),
		approval: "exec",
		async execute(_id, _args, signal) {
			return textResult(await memory(["clone"], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_cache",
		label: "Manage memory cache",
		description: "Manage the SQLite BM25 index cache: build, status, or clear it.",
		parameters: z.object({ action: z.string().describe("One of: build, status, clear.") }),
		approval: "exec",
		async execute(_id, args, signal) {
			requireChoice("memory_cache", "action", args.action, ["build", "status", "clear"]);
			return textResult(await memory(["cache", args.action], { signal }));
		},
	});

	pi.registerTool({
		name: "memory_log",
		label: "Read memory log",
		description: "Inspect the CLI usage log: recent commands, durations, and error entries.",
		parameters: z.object({
			tail: z.number().optional().describe("Show only the last N entries."),
			since: z.string().optional().describe("Only entries since this timestamp."),
			level: z.string().optional().describe("Filter by log level."),
			command: z.string().optional().describe("Filter by command name."),
			agent: z.string().optional().describe("Filter by agent id."),
		}),
		approval: "read",
		async execute(_id, args, signal) {
			const argv = ["log"];
			if (args.tail !== undefined) argv.push("--tail", String(Math.trunc(args.tail)));
			if (args.since) argv.push("--since", args.since);
			if (args.level) argv.push("--level", args.level);
			if (args.command) argv.push("--command", args.command);
			if (args.agent) argv.push("--agent", args.agent);
			return textResult(await memory(argv, { signal }));
		},
	});
}
