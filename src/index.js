import { readPluginSettings, resolveConfig } from "./config.js";
import { createMemoryRunner } from "./runner.js";
import { registerSetupTools } from "./setup-tools.js";
import { registerGraphTools } from "./graph-tools.js";
import { registerMemoryReadTools } from "./memory-read-tools.js";
import { registerMemoryWriteTools } from "./memory-write-tools.js";
import { registerMemoryMaintenanceTools } from "./memory-maintenance-tools.js";
import { createPlanSession, registerContractTools } from "./contract-tools.js";
import { registerPolicyTools } from "./policy-tools.js";
import { createSignals } from "./signals.js";
import { createDiscovery } from "./discovery.js";
import { createRsiRuntime, registerRsiTool } from "./rsi-tool.js";
import { registerPrompt } from "./prompt.js";

export default function ompRsi(pi) {
  const config = resolveConfig(readPluginSettings());
  const memory = createMemoryRunner(config);
  const signals = createSignals(pi, config);
  const planSession = createPlanSession(pi, memory);
  const discover = createDiscovery(config, pi);
  const rsi = createRsiRuntime(config, { memory, signals, discover });

  registerSetupTools(pi, config);
  registerGraphTools(pi, config);
  registerMemoryReadTools(pi, { memory });
  registerMemoryWriteTools(pi, config, { memory });
  registerMemoryMaintenanceTools(pi, { memory });
  registerContractTools(pi, config, { memory, planSession });
  registerPolicyTools(pi, config, { memory });
  registerRsiTool(pi, config, rsi);
  registerPrompt(pi, config, planSession);
}
