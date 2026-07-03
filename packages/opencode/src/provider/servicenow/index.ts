import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { Log } from "@opencode-ai/core/util/log"
import { ShimLanguageModel, type ShimTransport } from "../shim/model"

const log = Log.create({ service: "servicenow" })

export interface ServiceNowConfig {
  readonly instanceURL: string
  readonly username: string
  readonly password: string
  readonly capabilityId: string
  readonly fetch?: typeof globalThis.fetch
}

// Builds the transport that performs the ServiceNow Now Assist API call.
// Everything else (prompt serialization, tool-call parsing, streaming) is
// handled by the shared shim base class.
function createTransport(config: ServiceNowConfig): ShimTransport {
  const { instanceURL, username, password, capabilityId } = config
  const fetchFn = config.fetch ?? globalThis.fetch
  const credentials = Buffer.from(`${username}:${password}`).toString("base64")
  const endpoint = `${instanceURL}/api/now/oneextend/scripted/setup_and_execute`

  return async ({ prompt, signal }) => {
    // -------------------------------------------------------------------------
    // Retry strategy:
    //   Attempt 1: Normal request.
    //   Attempt 2: Constrained prompt (ask model to output less).
    //   Attempt 3: Constrained prompt again.
    //   After 3 failures: hard error (no compaction — issue is output size, not input).
    // -------------------------------------------------------------------------
    const TOTAL_ATTEMPTS = 3

    const execute = async (body: string): Promise<Response> => {
      return fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      })
    }

    const buildBody = (p: string) =>
      JSON.stringify({
        mode: "sync",
        executionRequests: [{ capabilityId, payload: { userprompt: p } }],
      })

    const extractResponse = (cap: Record<string, unknown>): string => {
      const rawResponse = cap.response
      const text =
        typeof rawResponse === "string"
          ? rawResponse
          : Array.isArray(rawResponse) && typeof rawResponse[0] === "string"
            ? rawResponse[0]
            : rawResponse != null
              ? JSON.stringify(rawResponse)
              : ""
      return text
    }

    // Returns the successful text or null if this attempt should be retried.
    const tryOnce = async (
      p: string,
      attempt: number,
    ): Promise<{ text: string; thinking?: string } | "retry" | "empty"> => {
      const res = await execute(buildBody(p))

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        // HTTP errors are not transient platform glitches — fail immediately
        throw new Error(`ServiceNow API ${res.status}: ${body.slice(0, 500)}`)
      }

      const data = (await res.json()) as Record<string, unknown>
      const result = (data?.result as Record<string, unknown> | undefined) ?? {}
      const capabilities = (result.capabilities as Record<string, unknown> | undefined) ?? {}
      const cap = capabilities[capabilityId] as Record<string, unknown> | undefined

      if (!cap || cap.status !== "success") {
        const capJson = JSON.stringify(cap ?? {})
        const capError = typeof cap?.error === "string" ? cap.error : capJson

        // Context overflow: input data exceeds provider limit — not recoverable here
        if (capError.includes("exceeds limit") || capError.includes("DATA_PRIVACY_API_ERROR")) {
          log.warn("context overflow — input exceeds limit", { attempt, error: capError.slice(0, 200) })
          throw new APICallError({
            message: `ServiceNow context overflow: ${capError}`,
            url: endpoint,
            requestBodyValues: { capabilityId },
            statusCode: 413,
            responseBody: capJson,
            isRetryable: false,
          })
        }

        log.warn("transient failure", {
          attempt,
          status: String(cap?.status ?? "unknown"),
          capJson: capJson.slice(0, 200),
        })
        return "retry"
      }

      const text = extractResponse(cap)
      if (!text || text === "{}") {
        log.warn("empty/truncated response", {
          attempt,
          text,
          cap: JSON.stringify(cap).slice(0, 200),
        })
        return "empty"
      }

      return {
        text,
        thinking: (cap.thinking_response as string | undefined) ?? undefined,
      }
    }

    // --- Attempt 1: initial request ---
    const first = await tryOnce(prompt, 1)
    if (typeof first === "object") {
      return { ...first, requestBody: buildBody(prompt) }
    }

    // --- Attempt 2: constrained prompt (ask model to output less) ---
    const constrainedPrompt =
      prompt +
      "\n\nHuman: Your previous response was too large and was dropped by the platform. " +
      "You MUST dramatically reduce your output. Respond with ONLY your single next concrete action — " +
      "no explanations, no alternatives, no summaries. Maximum 2000 words. " +
      "If you were about to use a tool, output only the tool call JSON with no surrounding text."

    await new Promise((r) => setTimeout(r, 3000))
    log.info("retrying with output constraint", { attempt: 2, promptLength: constrainedPrompt.length })
    const second = await tryOnce(constrainedPrompt, 2)
    if (typeof second === "object") {
      return { ...second, requestBody: buildBody(constrainedPrompt) }
    }

    // --- Attempt 3: constrained prompt again ---
    await new Promise((r) => setTimeout(r, 3000))
    log.info("retrying with output constraint", { attempt: 3, promptLength: constrainedPrompt.length })
    const third = await tryOnce(constrainedPrompt, 3)
    if (typeof third === "object") {
      return { ...third, requestBody: buildBody(constrainedPrompt) }
    }

    // --- All attempts exhausted — hard error (no compaction, issue is output size) ---
    log.error("all retry attempts exhausted", {
      totalAttempts: TOTAL_ATTEMPTS,
      promptLength: prompt.length,
      lastResult: third,
    })
    throw new Error(
      `ServiceNow: all ${TOTAL_ATTEMPTS} attempts failed (empty responses). The model output likely exceeds the platform limit. Check opencode logs for details.`,
    )
  }
}

// Factory consumed by opencode's BUNDLED_PROVIDERS map.
// All credentials are passed through provider.options from opencode.json.
export function createServiceNow(
  opts: Record<string, unknown> & {
    instanceURL?: unknown
    username?: unknown
    password?: unknown
    capabilityId?: unknown
    fetch?: unknown
  },
) {
  const config: ServiceNowConfig = {
    instanceURL: String(opts.instanceURL ?? ""),
    username: String(opts.username ?? ""),
    password: String(opts.password ?? ""),
    capabilityId: String(opts.capabilityId ?? ""),
    fetch: typeof opts.fetch === "function" ? (opts.fetch as typeof globalThis.fetch) : undefined,
  }

  const transport = createTransport(config)

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new ShimLanguageModel(modelId, { provider: "servicenow", transport })
    },
    chat(modelId: string): LanguageModelV3 {
      return new ShimLanguageModel(modelId, { provider: "servicenow", transport })
    },
  }
}
