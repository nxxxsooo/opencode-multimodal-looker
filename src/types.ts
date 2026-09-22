export type Opts = {
  /** Vision-capable model as `provider/model`, e.g. `opencode-go/qwen3.7-plus`. */
  model?: string;
  /**
   * Ordered fallback vision models (`provider/model`). When the vision
   * subagent's current model fails with a quota / rate-limit error (e.g.
   * Bailian's "concurrency allocated quota exceeded"), the subagent is
   * switched to the next entry for subsequent requests and the failed request
   * is retried immediately. V2 only. Default: no fallback.
   */
  fallbackModels?: string[];
  /**
   * Milliseconds to stay on a fallback model before switching back to the
   * primary, so a recovered quota is picked up again. Default: 30 minutes.
   * Set to 0 to stay on the last fallback until reload.
   */
  fallbackResetMs?: number;
  /** Name of the injected vision subagent. Defaults to `vision`. */
  agent?: string;
  /** Directory under which decoded images are cached. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /**
   * Route images to the vision subagent even when the main model is itself
   * multimodal. Default: `false` (auto-skip — if the main model can see images,
   * the subagent is not used, so the main model handles images directly). Set to
   * `true` to always route, e.g. to offload images to a cheaper vision model.
   */
  force?: boolean;
};

export interface FilePartLike {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

export interface Msg {
  info?: { role?: string };
  parts: any[];
}

/** OpenCode V2 media content part (`Message.content[]` entry). */
export interface MediaPartLike {
  type: "media";
  mediaType?: string;
  data?: string | Uint8Array;
  filename?: string;
  metadata?: Record<string, unknown>;
}
