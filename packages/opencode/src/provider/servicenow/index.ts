import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { ShimLanguageModel, type ShimTransport } from "../shim/model"

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
    let currentPrompt = prompt
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "sync",
          executionRequests: [{ capabilityId, payload: { userprompt: currentPrompt } }],
        }),
        signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`ServiceNow API ${res.status}: ${body.slice(0, 500)}`)
      }

      const data = (await res.json()) as Record<string, unknown>
      const result = (data?.result as Record<string, unknown> | undefined) ?? {}
      const capabilities = (result.capabilities as Record<string, unknown> | undefined) ?? {}
      const cap = capabilities[capabilityId] as Record<string, unknown> | undefined

      if (!cap || cap.status !== "success") {
        const capJson = JSON.stringify(cap ?? {})
        const capError = typeof cap?.error === "string" ? cap.error : capJson

        // Context overflow: input data exceeds provider limit — do not retry
        if (capError.includes("exceeds limit") || capError.includes("DATA_PRIVACY_API_ERROR")) {
          throw new APICallError({
            message: `ServiceNow context overflow: ${capError}`,
            url: endpoint,
            requestBodyValues: { capabilityId },
            statusCode: 413,
            responseBody: capJson,
            isRetryable: false,
          })
        }

        // Retry on transient skill status failures (e.g. status: unknown)
        if (attempt < maxAttempts) {
          // Empty {} response typically means output exceeded platform limits or timed out.
          // Constrain the model on retry to produce smaller responses.
          if (capJson === "{}" || capJson === '{"status":"unknown"}') {
            currentPrompt +=
              "\n\n[SYSTEM: Your previous response was too large and was lost. You MUST respond with ONLY your single next concrete action step. Keep your response concise — under 4000 words. Do not attempt to do everything at once.]"
          }
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500))
          continue
        }
        throw new Error(
          `ServiceNow skill status: ${String(cap?.status ?? "unknown")} (after ${maxAttempts} attempts) — ${capJson}`,
        )
      }

      const rawResponse = cap.response
      const text =
        typeof rawResponse === "string"
          ? rawResponse
          : Array.isArray(rawResponse) && typeof rawResponse[0] === "string"
            ? rawResponse[0]
            : rawResponse != null
              ? JSON.stringify(rawResponse)
              : ""
      if (!text) {
        throw new Error(
          `ServiceNow returned empty response for capability ${capabilityId} — full cap: ${JSON.stringify(cap)}`,
        )
      }

      return {
        text,
        thinking: (cap.thinking_response as string | undefined) ?? undefined,
        requestBody: JSON.stringify({ mode: "sync", userprompt: currentPrompt }),
      }
    }

    // Unreachable — the loop always returns or throws on the final attempt
    throw new Error("ServiceNow transport: exhausted retries")
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
