import { Plugin } from "@opencode/plugin";
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import { applyAgent, applyConfig } from "./agent";
import {
  isImagePart,
  imagePointer,
  transformMessages,
  transformV2Messages,
} from "./transform";
import { resolveImagePath } from "./image";
import { isQuotaError, buildModelChain } from "./fallback";
import { parseModelRef } from "./agent";
import type { Msg, Opts } from "./types";

/**
 * opencode-multimodal-looker
 *
 * A third-party opencode plugin that routes pasted images to a cheap vision model
 * so a text-only main agent can work from the vision model's text output.
 *
 * At load time it injects a vision subagent, then rewrites image parts of the
 * main agent's messages into text pointers that instruct it to delegate analysis
 * to that subagent.
 *
 * If the *main* model is already multimodal, routing is skipped by default (the
 * main model sees the image directly). Set `force: true` to always route — e.g.
 * to send images to a cheaper vision model while keeping a stronger text model
 * as main.
 *
 * The default export supports both OpenCode V1 and V2:
 * - V1 (>= 1.18.29) calls `server(input, options)` and uses the returned hooks.
 * - V2 validates the export's `id` + `setup()` and runs the V2 implementation.
 */

const PLUGIN_ID = "opencode-multimodal-looker";

/** Shared option parsing + the image-pointer instruction. */
function parseOptions(options: Record<string, unknown> | undefined) {
  const opts = (options ?? {}) as Opts;
  return {
    opts,
    agentName: opts.agent || "vision",
    tmpDir: opts.tmpDir,
    hasModel: !!opts.model,
    force: !!opts.force,
  };
}

const NO_MODEL_WARNING =
  "[opencode-multimodal-looker] no `model` option set; vision routing disabled.";

// ---------------------------------------------------------------------------
// V1 implementation (unchanged behavior)
// ---------------------------------------------------------------------------

const v1Plugin: V1Plugin = async (_input, options) => {
  const { opts, agentName, tmpDir, hasModel, force } = parseOptions(options);

  // modelID -> image-capable, learned from `chat.params` (full Model capabilities).
  // `chat.message` runs before `chat.params` in a turn, so the very first message
  // for a given model (before its capability is known) defaults to routing. After
  // that the decision is exact and updates immediately on a mid-session switch.
  const capabilities = new Map<string, boolean>();
  let routeEnabled = hasModel;

  if (!hasModel) console.warn(NO_MODEL_WARNING);

  return {
    // Inject the vision subagent at load time.
    config: async (cfg) => {
      if (!hasModel) return;
      applyConfig(cfg as any, opts);
    },

    // Learn each model's image capability as requests are actually made.
    "chat.params": async (input) => {
      const id = (input as any)?.model?.id;
      const img = !!(input as any)?.model?.capabilities?.input?.image;
      if (id) capabilities.set(id, img);
    },

    // Runs first per user message and owns the rewrite, so the stripped message is
    // what the model sees this turn (detection hooks run too late to be authoritative).
    "chat.message": async (input, output) => {
      if (!hasModel) return;
      if ((input as any)?.agent === agentName) return; // never rewrite the subagent
      const id = (input as any)?.model?.modelID;
      const isMultimodal = id ? capabilities.get(id) : undefined;
      // Route unless we know the model is multimodal (or `force` is set).
      const route = force || isMultimodal !== true;
      routeEnabled = route;
      if (!route) return;
      const parts = ((output as any).parts as any[]) || [];
      (output as any).parts = parts.map((p: any) => {
        if (isImagePart(p)) {
          const path = resolveImagePath(p, tmpDir);
          if (path) return { type: "text", text: imagePointer(path, agentName) };
        }
        return p;
      });
    },

    // Idempotent backup transform (primary rewrite happens in `chat.message`).
    "experimental.chat.messages.transform": async (_input2, output) => {
      if (!routeEnabled) return;
      const transformed = transformMessages(
        output.messages as unknown as Msg[],
        agentName,
        tmpDir,
      );
      output.messages.splice(0, output.messages.length, ...(transformed as any));
    },
  };
};

// ---------------------------------------------------------------------------
// V2 implementation
// ---------------------------------------------------------------------------

const v2Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const { opts, agentName, tmpDir, hasModel, force } = parseOptions(
      ctx.options as Record<string, unknown> | undefined,
    );

    if (!hasModel) console.warn(NO_MODEL_WARNING);

    // modelID -> image-capable, learned from the model catalog on first use and
    // memoized per provider/model. Unknown models default to routing, matching
    // the V1 behavior before a model's capability is known.
    const capabilities = new Map<string, boolean>();
    const isImageCapable = async (providerID: string, modelID: string) => {
      const key = `${providerID}/${modelID}`;
      const cached = capabilities.get(key);
      if (cached !== undefined) return cached;
      try {
        // @opencode/plugin exposed the catalog as `ctx.catalog.model` up to 2.0.3
        // and renamed it to `ctx.model` by 2.0.10. Reading only the old path threw
        // a TypeError on current opencode, which the catch below turned into
        // "not multimodal" — so every model looked text-only and `force: false`
        // never skipped anything. Support both shapes.
        const catalog =
          (ctx as any).model ?? (ctx as any).catalog?.model;
        if (!catalog?.list) throw new Error("no model catalog on plugin context");
        const listed = await catalog.list();
        const data: any[] = Array.isArray(listed)
          ? listed
          : ((listed as any)?.data ?? []);
        const model = data.find(
          (m) => m.providerID === providerID && (m.modelID ?? m.id) === modelID,
        );
        const img =
          Array.isArray(model?.capabilities?.input) &&
          model.capabilities.input.includes("image");
        capabilities.set(key, img);
        return img;
      } catch (err) {
        // Fail open (route), but make the reason visible instead of silent.
        console.warn(
          `[${PLUGIN_ID}] capability lookup failed for ${key}; routing anyway:`,
          err,
        );
        return false;
      }
    };

    // Ordered vision-model chain with quota failover (V2 only). Without
    // `fallbackModels` the chain is just the primary and behavior is unchanged.
    const chain = hasModel ? buildModelChain(opts.model, opts.fallbackModels) : [];
    const resetMs =
      typeof opts.fallbackResetMs === "number"
        ? opts.fallbackResetMs
        : 30 * 60_000;
    let chainIndex = 0;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const setAgentModel = async (model: string) => {
      await ctx.agent.transform((editor) => {
        applyAgent(editor as any, opts, model);
      });
    };

    if (hasModel) {
      // After the reset window, try the primary again so a recovered quota is
      // picked up; if it is still saturated the retry hook fails over again.
      const scheduleReset = () => {
        if (resetTimer) clearTimeout(resetTimer);
        if (!(resetMs > 0) || chain.length < 2) return;
        resetTimer = setTimeout(() => {
          resetTimer = undefined;
          chainIndex = 0;
          void setAgentModel(chain[0]).then(
            () =>
              console.warn(
                `[${PLUGIN_ID}] vision model reset to primary ${chain[0]}`,
              ),
            (err: unknown) =>
              console.warn(`[${PLUGIN_ID}] vision model reset failed:`, err),
          );
        }, resetMs);
        resetTimer.unref?.();
      };

      // Inject the vision subagent (agent.update upserts missing agents).
      await setAgentModel(chain[chainIndex]);

      // Fail the vision subagent over to the next model on quota/rate-limit
      // errors: switch the child session and the agent registry, then retry
      // immediately. If the in-flight retry keeps the old model, the next
      // delegation still lands on the fallback.
      if (chain.length > 1) {
        await ctx.session.hook("retry", async (event: any) => {
          if (event.agent !== agentName) return;
          if (!isQuotaError(event.error)) return;
          if (chainIndex >= chain.length - 1) return; // chain exhausted
          const from = chain[chainIndex];
          chainIndex += 1;
          const next = chain[chainIndex];
          const ref = parseModelRef(next)!;
          try {
            await ctx.session.switchModel({
              sessionID: event.sessionID,
              model: { providerID: ref.providerID, id: ref.modelID },
            });
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] session model switch failed:`, err);
          }
          try {
            await setAgentModel(next);
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] agent model switch failed:`, err);
          }
          console.warn(
            `[${PLUGIN_ID}] vision model ${from} hit a quota/rate limit; ` +
              `switched vision subagent to ${next}`,
          );
          scheduleReset();
          event.decision = { retry: true, delay: 0 };
        });
      }
    }

    // Rewrite image media parts on user messages immediately before each
    // agent-loop model request. This covers both fresh attachments and image
    // parts already in history (the equivalent of V1's chat.message +
    // experimental.chat.messages.transform). Capability comes from the model
    // catalog, so no learning hooks are needed.
    await ctx.session.hook("context", async (event) => {
      if (!hasModel) return;
      if (event.agent === agentName) return; // never rewrite the subagent
      const isMultimodal = await isImageCapable(
        event.model.providerID,
        event.model.id,
      );
      if (!force && isMultimodal) return;
      (event as any).messages = transformV2Messages(
        event.messages as any[],
        agentName,
        tmpDir,
      );
    });

    // setup() cleanup: drop the pending back-to-primary timer on unload.
    return () => {
      if (resetTimer) clearTimeout(resetTimer);
    };
  },
});

// ---------------------------------------------------------------------------
// Dual V1/V2 default export
// ---------------------------------------------------------------------------

export default {
  ...v2Plugin,
  async server(input: unknown, options?: Record<string, unknown>) {
    return v1Plugin(input as any, options);
  },
};
