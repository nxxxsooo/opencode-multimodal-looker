import type { Config } from "@opencode-ai/plugin";
import type { Opts } from "./types";

/**
 * Parse a `provider/model` reference. The provider ends at the first `/`; the
 * model may itself contain `/` (e.g. `openrouter/anthropic/claude-fable-5.1`).
 * Returns null when malformed.
 */
export function parseModelRef(
  model: string | undefined,
): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return null;
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Build the config object for the injected vision subagent. */
export function buildVisionAgentConfig(opts: Opts): Record<string, any> {
  const agentName = opts.agent || "vision";
  return {
    description:
      "Vision analysis subagent. Reads an image path and returns a textual description.",
    mode: "subagent",
    model: opts.model,
    prompt:
      "You are a vision analysis subagent. You are given an image FILE PATH and a question. " +
      "Use the read tool on the path to load the image, analyze it, and return ONLY the textual analysis.",
    permission: {
      external_directory: "allow",
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
      doom_loop: "deny",
    },
  } as Record<string, any>;
}

/**
 * Mutate an opencode `Config` to (a) declare the chosen model as image-capable and
 * (b) inject the vision subagent. No-op if `opts.model` is missing or malformed.
 */
export function applyConfig(cfg: Config, opts: Opts): void {
  const ref = parseModelRef(opts.model);
  if (!ref) return;

  const [provider, modelId] = [ref.providerID, ref.modelID];
  cfg.provider = cfg.provider || {};
  cfg.provider[provider] = cfg.provider[provider] || { models: {} };
  cfg.provider[provider].models = cfg.provider[provider].models || {};
  cfg.provider[provider].models[modelId] = {
    ...(cfg.provider[provider].models[modelId] || {}),
    id: modelId,
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true,
  };

  cfg.agent = cfg.agent || {};
  cfg.agent[opts.agent || "vision"] = buildVisionAgentConfig(opts) as any;
}

/** The system instruction telling the main agent to delegate image pointers. */
export function delegationInstruction(agentName: string): string {
  return (
    `If a user message contains an image pointer like '[image saved at: PATH]', ` +
    `delegate analysis to the "${agentName}" subagent via the Task tool, passing the path and the user's request.`
  );
}

/**
 * OpenCode V2: upsert the vision subagent through an `agent.transform` editor.
 * V2 has no mutable global config hook, so the agent is registered directly
 * with the agent domain (editor.update creates missing agents). `model`
 * overrides `opts.model` — used by the fallback chain to re-point the agent at
 * another vision model after a quota failure.
 */
export function applyAgent(
  editor: { update(id: string, update: (agent: any) => void): void },
  opts: Opts,
  model?: string,
): void {
  const ref = parseModelRef(model ?? opts.model);
  if (!ref) return;
  const agentName = opts.agent || "vision";
  editor.update(agentName, (agent) => {
    agent.name = agentName;
    agent.description = buildVisionAgentConfig(opts).description;
    agent.mode = "subagent";
    agent.model = { providerID: ref.providerID, id: ref.modelID };
    agent.system = buildVisionAgentConfig(opts).prompt;
    agent.permissions = [
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ];
  });
}
