/**
 * CDP-Web Provider — drives M365 Copilot via browser tabs using Chrome DevTools Protocol.
 *
 * Unlike the app-based CDP provider (which targets M365Copilot.exe singleton),
 * this provider launches/connects to a full browser with multiple tabs, allowing
 * unlimited concurrent conversations.
 *
 * Auth is shared across all tabs via the browser's cookie jar (persistent profile).
 * If a session times out, it's detected and the user is prompted to re-login once.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { CDPWebLanguageModel } from "./model"

export function createCDPWeb(
  opts: Record<string, unknown> & {
    port?: unknown
    effort?: unknown
    timeout?: unknown
  },
) {
  const config = {
    port: typeof opts.port === "number" ? opts.port : 9224,
    effort: typeof opts.effort === "string" ? opts.effort : "opus",
    timeout: typeof opts.timeout === "number" ? opts.timeout : 300,
  }

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new CDPWebLanguageModel(modelId, config)
    },
    chat(modelId: string): LanguageModelV3 {
      return new CDPWebLanguageModel(modelId, config)
    },
  }
}
