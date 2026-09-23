import { textResult } from "./memory-output.js";
import { requireChoice } from "./memory-parameters.js";

/** Register read-only CLI-backed memory discovery and inspection tools. */
export function registerMemoryReadTools(pi, { memory }) {
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
