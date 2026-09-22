import { parseModelRef } from "./agent";

/** Error shape of the OpenCode V2 session `retry` hook. */
export interface RetryErrorLike {
  type?: string;
  message?: string;
  status?: number;
}

const QUOTA_RE = /quota|concurrency|rate[\s_.-]?limit|too[\s_.-]?many[\s_.-]?requests/i;

/**
 * True when an error looks like a quota / rate-limit failure worth failing
 * over — HTTP 429, or a message mentioning quota/concurrency/rate limits
 * (Bailian's coding-plan limit returns "concurrency allocated quota
 * exceeded. please try again later." and may arrive with a non-429 status
 * through gateways).
 */
export function isQuotaError(error: RetryErrorLike | undefined): boolean {
  if (!error) return false;
  if (error.status === 429) return true;
  const text = `${error.type ?? ""} ${error.message ?? ""}`;
  return QUOTA_RE.test(text);
}

/**
 * Build the ordered vision-model chain: the primary `model` followed by every
 * parseable, de-duplicated `fallbackModels` entry. Malformed entries are
 * dropped so one bad config value cannot disable the whole chain.
 */
export function buildModelChain(
  model?: string,
  fallbackModels?: string[],
): string[] {
  const chain: string[] = [];
  const push = (m: unknown) => {
    if (typeof m !== "string") return;
    const trimmed = m.trim();
    if (!trimmed || !parseModelRef(trimmed)) return;
    if (!chain.includes(trimmed)) chain.push(trimmed);
  };
  push(model);
  if (Array.isArray(fallbackModels)) fallbackModels.forEach(push);
  return chain;
}
