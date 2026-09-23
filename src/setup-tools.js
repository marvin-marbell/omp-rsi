import { bootstrapRequest, setupStatus } from "../lib/setup.js";
import { installRuntime } from "../lib/runtime.js";
import { setupFields } from "../lib/setup-json.js";
import { textResult } from "./memory-output.js";

const ACTIONS = ["status", "install", "initialize", "preview_migration", "apply_migration", "sync_instructions"];

async function confirmChange(ctx, title, description) {
	if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function" || !await ctx.ui.confirm(title, description)) {
		throw new Error(`${title} requires explicit interactive operator approval; no changes were started.`);
	}
}

export function registerSetupTools(pi, config) {
	const z = pi.zod;
	pi.registerTool({
		name: "memory_setup",
		label: "Memory Setup",
		description: "Bootstrap memory with explicit actions. Status is read-only. Install explicitly provisions private Python CLI/ripgrep and pinned graph-only GitNexus; initialize seeds missing templates/policy without overwriting user content. Migration previews selected Markdown then applies a revision-checked copy; credentials/history are never imported. Sync instructions only to configured targets. No implicit installation or network on load.",
		parameters: z.object({
			action: z.enum(ACTIONS).describe("Start with status; install and migration apply require operator approval."),
			request: z.string().optional().describe("JSON object excluding action. Install: {graph:true} (default). preview_migration: {source_home:'/chosen/codex',memory_dirs:[],import_id:'codex'}. apply_migration: {preview:<full preview>,expected_revision:'<revision>'}. sync_instructions requires target from configured instructionFiles."),
			no_git: z.boolean().optional().describe("Initialize files without Git; existing repositories are never auto-pushed."),
		}),
		approval: "exec",
		async execute(_id, args, signal, _onUpdate, ctx) {
			if (!ACTIONS.includes(args.action)) throw new Error(`Unknown setup action: ${args.action}`);
			const fields = setupFields(args.request ?? "{}");
			let result;
			if (args.action === "status") {
				if (Object.keys(fields).length) throw new Error("status takes no request fields");
				result = await setupStatus(config, { signal, noGit: args.no_git === true });
			} else if (args.action === "install") {
				if (Object.keys(fields).some(key => key !== "graph") || (fields.graph !== undefined && typeof fields.graph !== "boolean")) throw new Error("install accepts only optional graph:boolean");
				await confirmChange(ctx, "Install OMP RSI dependencies", `Install the bundled Python memory CLI and ripgrep to ${config.runtimeDir}${fields.graph === false ? " (without GitNexus)" : " and GitNexus 1.6.7 via npm"}? This may access the package registry; no global packages are changed.`);
				result = await installRuntime(config, { graph: fields.graph !== false, signal });
			} else {
				if (args.action === "sync_instructions") {
					if (typeof fields.target !== "string" || !(config.instructionFiles ?? []).includes(fields.target)) throw new Error("sync_instructions target must be in the operator-configured instructionFiles allowlist");
					if (fields.apply === true) await confirmChange(ctx, "Sync managed instructions", `Update only the managed policy section in ${fields.target}? Existing unmanaged content is preserved.`);
				} else if (args.action === "apply_migration") {
					if (!fields.preview || !fields.expected_revision) throw new Error("apply_migration requires the reviewed preview and expected_revision");
					await confirmChange(ctx, "Apply memory migration", `Apply the revision-checked reviewed Markdown migration to ${config.base}? Credentials and session history are not imported.`);
				}
				result = await bootstrapRequest(config, { ...fields, action: args.action }, { signal, noGit: args.no_git === true });
			}
			return textResult(JSON.stringify(result));
		},
	});
}
