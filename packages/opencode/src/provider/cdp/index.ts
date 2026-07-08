/**
 * CDP Provider — drives M365 Copilot (Opus) via Chrome DevTools Protocol.
 *
 * STATEFUL: Maintains a persistent conversation in the Copilot UI. Only sends
 * new messages each turn (system prompt + tools on first call, then just deltas).
 * Copilot manages its own context window server-side, so the 128k input limit
 * becomes per-message, not per-session.
 *
 * Tool calls use the same prompt instructions and parseResponse() logic as the
 * shim providers (PowerAutomate, ServiceNow).
 */
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { CDPLanguageModel } from "./model"

export function createCDP(
  opts: Record<string, unknown> & {
    port?: unknown
    effort?: unknown
    timeout?: unknown
  },
) {
  const config = {
    port: typeof opts.port === "number" ? opts.port : 9223,
    effort: typeof opts.effort === "string" ? opts.effort : "opus",
    timeout: typeof opts.timeout === "number" ? opts.timeout : 300,
  }

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new CDPLanguageModel(modelId, config)
    },
    chat(modelId: string): LanguageModelV3 {
      return new CDPLanguageModel(modelId, config)
    },
  }
}
