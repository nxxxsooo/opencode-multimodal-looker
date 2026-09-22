// src/index.ts
import { Plugin } from "@opencode/plugin";

// src/agent.ts
function parseModelRef(model) {
  if (!model)
    return null;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1)
    return null;
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}
function buildVisionAgentConfig(opts) {
  const agentName = opts.agent || "vision";
  return {
    description: "Vision analysis subagent. Reads an image path and returns a textual description.",
    mode: "subagent",
    model: opts.model,
    prompt: "You are a vision analysis subagent. You are given an image FILE PATH and a question. " + "Use the read tool on the path to load the image, analyze it, and return ONLY the textual analysis.",
    permission: {
      external_directory: "allow",
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
      doom_loop: "deny"
    }
  };
}
function applyConfig(cfg, opts) {
  const ref = parseModelRef(opts.model);
  if (!ref)
    return;
  const [provider, modelId] = [ref.providerID, ref.modelID];
  cfg.provider = cfg.provider || {};
  cfg.provider[provider] = cfg.provider[provider] || { models: {} };
  cfg.provider[provider].models = cfg.provider[provider].models || {};
  cfg.provider[provider].models[modelId] = {
    ...cfg.provider[provider].models[modelId] || {},
    id: modelId,
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true
  };
  cfg.agent = cfg.agent || {};
  cfg.agent[opts.agent || "vision"] = buildVisionAgentConfig(opts);
}
function applyAgent(editor, opts, model) {
  const ref = parseModelRef(model ?? opts.model);
  if (!ref)
    return;
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
      { action: "webfetch", resource: "*", effect: "deny" }
    ];
  });
}

// src/image.ts
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
function extForMime(mime) {
  if (mime.includes("png"))
    return "png";
  if (mime.includes("jpeg") || mime.includes("jpg"))
    return "jpg";
  if (mime.includes("gif"))
    return "gif";
  if (mime.includes("webp"))
    return "webp";
  return "bin";
}
function decodeDataUrl(url) {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m)
    return null;
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}
function writeDecoded(decoded, tmpDir) {
  const ext = extForMime(decoded.mime);
  const name = "opencode-vision-" + createHash("sha1").update(decoded.buffer).digest("hex").slice(0, 16) + "." + ext;
  const dir = join(tmpDir, "opencode-vision");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  if (!existsSync(p))
    writeFileSync(p, decoded.buffer);
  return p;
}
function resolveImagePath(part, tmpDir = tmpdir()) {
  const url = part?.url || "";
  try {
    const decoded = decodeDataUrl(url);
    if (decoded)
      return writeDecoded(decoded, tmpDir);
    if (url.startsWith("file://"))
      return decodeURIComponent(url.slice(7));
    if (url.startsWith("/"))
      return url;
  } catch {
    return null;
  }
  return part?.filename || null;
}
function resolveMediaPath(part, tmpDir = tmpdir()) {
  try {
    const meta = part?.metadata;
    if (meta && typeof meta === "object") {
      for (const value of Object.values(meta)) {
        if (typeof value !== "string" || !value)
          continue;
        const decoded = decodeDataUrl(value);
        if (decoded)
          return writeDecoded(decoded, tmpDir);
        if (value.startsWith("file://"))
          return decodeURIComponent(value.slice(7));
        if (value.startsWith("/"))
          return value;
      }
    }
    const mime = part?.mediaType || "image/png";
    const data = part?.data;
    if (typeof data === "string" && data.length > 0) {
      return writeDecoded({ mime, buffer: Buffer.from(data, "base64") }, tmpDir);
    }
    if (data instanceof Uint8Array && data.length > 0) {
      return writeDecoded({ mime, buffer: Buffer.from(data) }, tmpDir);
    }
  } catch {
    return null;
  }
  return part?.filename || null;
}

// src/transform.ts
var IMAGE_PREFIX = "[The user attached an image, saved at:";
var IMAGE_SUFFIX = "]";
function imagePointer(path, agentName) {
  return `${IMAGE_PREFIX} ${path}${IMAGE_SUFFIX}
` + `Use the "${agentName}" subagent (via the Task tool) to analyze this image ` + `and answer the user's request about it. Pass the path and the request to the subagent.`;
}
function isImagePart(part) {
  return part?.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/");
}
function transformMessages(messages, agentName, tmpDir) {
  return messages.map((msg) => {
    const parts = msg?.parts || [];
    const hasImage = parts.some(isImagePart);
    if (!hasImage)
      return msg;
    if (msg.info?.role && msg.info.role !== "user")
      return msg;
    let replaced = false;
    const newParts = parts.map((part) => {
      if (isImagePart(part)) {
        const path = resolveImagePath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });
    return replaced ? { ...msg, parts: newParts } : msg;
  });
}
function isMediaImagePart(part) {
  return part?.type === "media" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/");
}
function transformV2Messages(messages, agentName, tmpDir) {
  return messages.map((msg) => {
    if (msg?.role && msg.role !== "user")
      return msg;
    const parts = msg?.content;
    if (!Array.isArray(parts))
      return msg;
    const hasImage = parts.some(isMediaImagePart);
    if (!hasImage)
      return msg;
    let replaced = false;
    const newParts = parts.map((part) => {
      if (isMediaImagePart(part)) {
        const path = resolveMediaPath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });
    return replaced ? { ...msg, content: newParts } : msg;
  });
}

// src/fallback.ts
var QUOTA_RE = /quota|concurrency|rate[\s_.-]?limit|too[\s_.-]?many[\s_.-]?requests/i;
function isQuotaError(error) {
  if (!error)
    return false;
  if (error.status === 429)
    return true;
  const text = `${error.type ?? ""} ${error.message ?? ""}`;
  return QUOTA_RE.test(text);
}
function buildModelChain(model, fallbackModels) {
  const chain = [];
  const push = (m) => {
    if (typeof m !== "string")
      return;
    const trimmed = m.trim();
    if (!trimmed || !parseModelRef(trimmed))
      return;
    if (!chain.includes(trimmed))
      chain.push(trimmed);
  };
  push(model);
  if (Array.isArray(fallbackModels))
    fallbackModels.forEach(push);
  return chain;
}

// src/index.ts
var PLUGIN_ID = "opencode-multimodal-looker";
function parseOptions(options) {
  const opts = options ?? {};
  return {
    opts,
    agentName: opts.agent || "vision",
    tmpDir: opts.tmpDir,
    hasModel: !!opts.model,
    force: !!opts.force
  };
}
var NO_MODEL_WARNING = "[opencode-multimodal-looker] no `model` option set; vision routing disabled.";
var v1Plugin = async (_input, options) => {
  const { opts, agentName, tmpDir, hasModel, force } = parseOptions(options);
  const capabilities = new Map;
  let routeEnabled = hasModel;
  if (!hasModel)
    console.warn(NO_MODEL_WARNING);
  return {
    config: async (cfg) => {
      if (!hasModel)
        return;
      applyConfig(cfg, opts);
    },
    "chat.params": async (input) => {
      const id = input?.model?.id;
      const img = !!input?.model?.capabilities?.input?.image;
      if (id)
        capabilities.set(id, img);
    },
    "chat.message": async (input, output) => {
      if (!hasModel)
        return;
      if (input?.agent === agentName)
        return;
      const id = input?.model?.modelID;
      const isMultimodal = id ? capabilities.get(id) : undefined;
      const route = force || isMultimodal !== true;
      routeEnabled = route;
      if (!route)
        return;
      const parts = output.parts || [];
      output.parts = parts.map((p) => {
        if (isImagePart(p)) {
          const path = resolveImagePath(p, tmpDir);
          if (path)
            return { type: "text", text: imagePointer(path, agentName) };
        }
        return p;
      });
    },
    "experimental.chat.messages.transform": async (_input2, output) => {
      if (!routeEnabled)
        return;
      const transformed = transformMessages(output.messages, agentName, tmpDir);
      output.messages.splice(0, output.messages.length, ...transformed);
    }
  };
};
var v2Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const { opts, agentName, tmpDir, hasModel, force } = parseOptions(ctx.options);
    if (!hasModel)
      console.warn(NO_MODEL_WARNING);
    const capabilities = new Map;
    const isImageCapable = async (providerID, modelID) => {
      const key = `${providerID}/${modelID}`;
      const cached = capabilities.get(key);
      if (cached !== undefined)
        return cached;
      try {
        const catalog = ctx.model ?? ctx.catalog?.model;
        if (!catalog?.list)
          throw new Error("no model catalog on plugin context");
        const listed = await catalog.list();
        const data = Array.isArray(listed) ? listed : listed?.data ?? [];
        const model = data.find((m) => m.providerID === providerID && (m.modelID ?? m.id) === modelID);
        const img = Array.isArray(model?.capabilities?.input) && model.capabilities.input.includes("image");
        capabilities.set(key, img);
        return img;
      } catch (err) {
        console.warn(`[${PLUGIN_ID}] capability lookup failed for ${key}; routing anyway:`, err);
        return false;
      }
    };
    const chain = hasModel ? buildModelChain(opts.model, opts.fallbackModels) : [];
    const resetMs = typeof opts.fallbackResetMs === "number" ? opts.fallbackResetMs : 30 * 60000;
    let chainIndex = 0;
    let resetTimer;
    const setAgentModel = async (model) => {
      await ctx.agent.transform((editor) => {
        applyAgent(editor, opts, model);
      });
    };
    if (hasModel) {
      const scheduleReset = () => {
        if (resetTimer)
          clearTimeout(resetTimer);
        if (!(resetMs > 0) || chain.length < 2)
          return;
        resetTimer = setTimeout(() => {
          resetTimer = undefined;
          chainIndex = 0;
          setAgentModel(chain[0]).then(() => console.warn(`[${PLUGIN_ID}] vision model reset to primary ${chain[0]}`), (err) => console.warn(`[${PLUGIN_ID}] vision model reset failed:`, err));
        }, resetMs);
        resetTimer.unref?.();
      };
      await setAgentModel(chain[chainIndex]);
      if (chain.length > 1) {
        await ctx.session.hook("retry", async (event) => {
          if (event.agent !== agentName)
            return;
          if (!isQuotaError(event.error))
            return;
          if (chainIndex >= chain.length - 1)
            return;
          const from = chain[chainIndex];
          chainIndex += 1;
          const next = chain[chainIndex];
          const ref = parseModelRef(next);
          try {
            await ctx.session.switchModel({
              sessionID: event.sessionID,
              model: { providerID: ref.providerID, id: ref.modelID }
            });
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] session model switch failed:`, err);
          }
          try {
            await setAgentModel(next);
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] agent model switch failed:`, err);
          }
          console.warn(`[${PLUGIN_ID}] vision model ${from} hit a quota/rate limit; ` + `switched vision subagent to ${next}`);
          scheduleReset();
          event.decision = { retry: true, delay: 0 };
        });
      }
    }
    await ctx.session.hook("context", async (event) => {
      if (!hasModel)
        return;
      if (event.agent === agentName)
        return;
      const isMultimodal = await isImageCapable(event.model.providerID, event.model.id);
      if (!force && isMultimodal)
        return;
      event.messages = transformV2Messages(event.messages, agentName, tmpDir);
    });
    return () => {
      if (resetTimer)
        clearTimeout(resetTimer);
    };
  }
});
var src_default = {
  ...v2Plugin,
  async server(input, options) {
    return v1Plugin(input, options);
  }
};
export {
  src_default as default
};
