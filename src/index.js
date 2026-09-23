import { resolveConfig } from "./config.js";
import { createMemoryRunner } from "./runner.js";
import { registerSetupTools } from "./setup-tools.js";
import { registerGraphTools } from "./graph-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerContractTools } from "./contract-tools.js";
import { registerPolicyTools } from "./policy-tools.js";
import { createSignals } from "./signals.js";
import { createDiscovery } from "./discovery.js";
import { createRsiRuntime, registerRsiTool } from "./rsi-tool.js";
import { registerPrompt } from "./prompt.js";

export default function ompRsi(pi) {
  const config = resolveConfig();
  const memory = createMemoryRunner(config);
  const signals = createSignals(pi, config);
  const discover = createDiscovery(config, pi);
  const rsi = createRsiRuntime(config, { memory, signals, discover });

  registerSetupTools(pi, config);
  registerGraphTools(pi, config);
  registerMemoryTools(pi, config, { memory });
  registerContractTools(pi, config, { memory, rsi });
  registerPolicyTools(pi, config, { memory });
  registerRsiTool(pi, config, rsi);
  registerPrompt(pi, config);
}
