/**
 * CDP-Web Provider - drives M365 Copilot via browser tabs using Chrome DevTools Protocol.
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
    headless?: unknown
    browser?: unknown
    forceAuthSwap?: unknown
    profileDir?: unknown
    profileDirectory?: unknown
  },
) {
  const config = {
    port: typeof opts.port === "number" ? opts.port : 9224,
    effort: typeof opts.effort === "string" ? opts.effort : "opus",
    timeout: typeof opts.timeout === "number" ? opts.timeout : 300,
    // Config-driven browser controls (set in opencode.jsonc under the provider's
    // "options"). headless defaults to false (headed) so first-time auth is
    // visible; browser defaults to chrome for clean identity isolation.
    headless: opts.headless === true,
    browser: (opts.browser === "edge" || opts.browser === "chrome" || opts.browser === "auto"
      ? opts.browser
      : "chrome") as "chrome" | "edge" | "auto",
    // DEBUG: exercise the swap machinery even when headed (see model.ts).
    forceAuthSwap: opts.forceAuthSwap === true,
    // Optional: point at a real browser User Data root + named profile so we can
    // drive the user's actual trusted profile. Empty => use the managed default.
    profileDir: typeof opts.profileDir === "string" ? opts.profileDir : undefined,
    profileDirectory: typeof opts.profileDirectory === "string" ? opts.profileDirectory : undefined,
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
