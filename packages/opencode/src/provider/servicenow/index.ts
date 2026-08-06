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

      // Top-level failure (permission/ACL, invalid capability id, etc.): ServiceNow
      // returns result.status === "error", an empty capabilities object, and a
      // human-readable result.message. This is NOT an output-size problem, so it
      // must not be retried or reported as a context/output-limit error.
      if (result.status === "error" || Object.keys(capabilities).length === 0) {
        const message = typeof result.message === "string" ? result.message : JSON.stringify(result)
        log.error("servicenow request rejected", { capabilityId, message: message.slice(0, 300) })
        throw new APICallError({
          message: `ServiceNow rejected the request for capability ${capabilityId}: ${message}`,
          url: endpoint,
          requestBodyValues: { capabilityId },
          statusCode: 403,
          responseBody: JSON.stringify(result).slice(0, 1000),
          isRetryable: false,
        })
      }

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
      "you are trying to do too much at once. you need to limit your output tokens and give me just the next action to take"

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
  const baseConfig: ServiceNowConfig = {
    instanceURL: String(opts.instanceURL ?? ""),
    username: String(opts.username ?? ""),
    password: String(opts.password ?? ""),
    // Provider-level capabilityId is now only a fallback default. Each model can
    // override it via its own `options.capabilityId` in opencode.jsonc. The
    // per-model value arrives here through the getModel loader in provider.ts,
    // which forwards the merged { ...provider.options, ...model.options }.
    capabilityId: String(opts.capabilityId ?? ""),
    fetch: typeof opts.fetch === "function" ? (opts.fetch as typeof globalThis.fetch) : undefined,
  }

  // Build a language model bound to a specific capability id, preferring the
  // per-model override and falling back to the provider-level default. A fresh
  // transport closure per model is cheap and keeps each model pointed at its
  // own capability, so multiple models can run concurrently.
  const modelFor = (modelId: string, options?: Record<string, unknown>): LanguageModelV3 => {
    const capabilityId = String((options?.capabilityId as string | undefined) ?? baseConfig.capabilityId)
    const transport = createTransport({ ...baseConfig, capabilityId })
    return new ShimLanguageModel(modelId, { provider: "servicenow", transport })
  }

  return {
    languageModel(modelId: string, options?: Record<string, unknown>): LanguageModelV3 {
      return modelFor(modelId, options)
    },
    chat(modelId: string, options?: Record<string, unknown>): LanguageModelV3 {
      return modelFor(modelId, options)
    },
  }
}
