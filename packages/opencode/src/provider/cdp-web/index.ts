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
    wordUrl?: unknown
    wordPort?: unknown
    reminderTokenInterval?: unknown
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
    // Word engine (model-id "-word" suffix): the parking-doc URL whose embedded
    // Copilot pane we drive, and an optional separate CDP port/browser for Word.
    // wordPort falls back to `port` when omitted (shared browser, shared auth).
    wordUrl: typeof opts.wordUrl === "string" ? opts.wordUrl : undefined,
    wordPort: typeof opts.wordPort === "number" ? opts.wordPort : undefined,
    // Word engine only: re-assert the coding-agent framing every N cumulative
    // tokens of conversation (Copilot has no per-turn resend of the initial
    // preamble — see model.ts formatInitialMessage/formatDeltaMessages — so on
    // long conversations it can lose that framing and drift back into its
    // native Word-assistant register). Default 35,000 tokens.
    reminderTokenInterval:
      typeof opts.reminderTokenInterval === "number" ? opts.reminderTokenInterval : 35_000,
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
