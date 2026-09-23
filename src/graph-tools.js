import { executeGraph, GRAPH_ACTIONS } from "../lib/gitnexus.js";
import { textResult } from "./memory-output.js";

/** Exactly the audited graph-only action surface; backend preflight rejects extraneous fields. */
export function registerGraphTools(pi, config) {
	const z = pi.zod;
	pi.registerTool({
		name: "gitnexus",
		label: "GitNexus Graph",
		description: "Graph-only GitNexus: doctor, status, analyze, query, context, impact, detect_changes, list. Analyze explicitly indexes only the owner-selected cwd; query is lexical graph search, never embeddings. No arbitrary flags, raw Cypher, wiki/LLM, model download, or embedding removal. Available before installation; doctor reports setup needs. Repo actions require an absolute cwd root. Existing .gitnexusrc embedding settings fail closed.",
		parameters: z.object({
			action: z.enum(GRAPH_ACTIONS).describe("Allowlisted graph action."),
			cwd: z.string().optional().describe("Absolute owner-selected repository root; required except doctor/list. Analyze writes its .gitnexus index and managed runtime registry."),
			query: z.string().optional().describe("query only: 1–16 lexical identifier/path words (AND match)."),
			symbol: z.string().optional().describe("context/impact only: exact symbol name."),
			file: z.string().optional().describe("context/impact only: disambiguating source path."),
			limit: z.number().int().optional().describe("query/impact only: 1–100 results, default 20."),
			depth: z.number().int().optional().describe("impact only: relationship depth 1–10, default 3."),
			direction: z.enum(["upstream", "downstream"]).optional().describe("impact only; default upstream."),
			scope: z.enum(["unstaged", "staged", "all", "compare"]).optional().describe("detect_changes only; default unstaged."),
			base_ref: z.string().optional().describe("Required only for compare scope: branch or commit."),
			force: z.boolean().optional().describe("analyze only: rebuild even if commit unchanged; preserves existing embeddings."),
		}),
		approval: "exec",
		async execute(_id, args, signal) {
			const { result } = await executeGraph(config, args, { signal });
			return textResult(result);
		},
	});
}
