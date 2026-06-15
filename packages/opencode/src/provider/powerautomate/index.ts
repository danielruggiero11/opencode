import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { ShimLanguageModel, type ShimTransport } from "../shim/model"

export interface PowerAutomateConfig {
  // Full signed trigger URL — the `sig=` query parameter self-authenticates the
  // request, so no bearer token is required.
  readonly url: string
  // JSON body field the flow reads the prompt from. Defaults to "query".
  readonly queryField: string
  // When true, also send `{ model: <modelId> }` in the request body so the flow
  // can select a backend model. Defaults to false until the flow supports it.
  readonly sendModelInBody: boolean
  // JSON field to read the answer from when the flow returns a JSON object.
  // When unset, the raw response body is used as the text (plaintext flows).
  readonly responseField?: string
  readonly fetch?: typeof globalThis.fetch
}

// Builds the transport that performs the Power Automate flow call. Everything
// else (prompt serialization, tool-call parsing, streaming) is handled by the
// shared shim base class.
function createTransport(config: PowerAutomateConfig): ShimTransport {
  const { url, queryField, sendModelInBody, responseField } = config
  const fetchFn = config.fetch ?? globalThis.fetch
  const maxAttempts = 3

  return async ({ prompt, modelId, signal }) => {
    const body: Record<string, unknown> = { [queryField]: prompt }
    // Future model selection: the flow will read this field to choose a backend
    // model. Gated by config so current single-model flows are unaffected.
    if (sendModelInBody) body.model = modelId
    const requestBody = JSON.stringify(body)

    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal,
        })
      } catch (err) {
        // Network/transport failure — retry transient errors
        lastError = err
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500))
          continue
        }
        throw err
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "")
        // 4xx (bad request, expired/invalid sig) are not retryable; 5xx are.
        if (res.status >= 500 && attempt < maxAttempts) {
          lastError = new Error(`Power Automate API ${res.status}`)
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500))
          continue
        }
        throw new APICallError({
          message: `Power Automate API ${res.status}: ${errBody.slice(0, 500)}`,
          url,
          requestBodyValues: { [queryField]: "<prompt>", ...(sendModelInBody ? { model: modelId } : {}) },
          statusCode: res.status,
          responseBody: errBody,
          isRetryable: false,
        })
      }

      // The flow returns plaintext (the model's answer, which may itself be a
      // JSON tool-call that the shim parses). If a responseField is configured,
      // or the body happens to be a JSON object, extract the field from it.
      const raw = await res.text()
      const text = extractText(raw, responseField)
      if (!text) {
        throw new Error(`Power Automate returned empty response — raw: ${raw.slice(0, 500)}`)
      }

      return { text, requestBody }
    }

    throw lastError instanceof Error ? lastError : new Error("Power Automate transport: exhausted retries")
  }
}

// Returns the answer text from a flow response. Plaintext bodies pass straight
// through; JSON-object bodies are unwrapped via responseField (or a small set of
// common field names) so the shim's tool-call parser sees the model's output.
function extractText(raw: string, responseField?: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not actually JSON — treat as plaintext (e.g. a JSON-looking tool call is
    // handled downstream by the shim parser, so leave it intact).
    return trimmed
  }

  if (typeof parsed === "string") return parsed
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const candidates = responseField ? [responseField] : ["response", "result", "output", "text", "content", "answer"]
    for (const key of candidates) {
      const val = obj[key]
      if (typeof val === "string" && val) return val
    }
  }
  // Couldn't find a known field — return the raw JSON so nothing is lost.
  return trimmed
}

// Factory consumed by opencode's BUNDLED_PROVIDERS map.
// Config is passed through provider.options from opencode.json.
export function createPowerAutomate(
  opts: Record<string, unknown> & {
    url?: unknown
    queryField?: unknown
    sendModelInBody?: unknown
    responseField?: unknown
    fetch?: unknown
  },
) {
  const config: PowerAutomateConfig = {
    url: String(opts.url ?? ""),
    queryField: typeof opts.queryField === "string" && opts.queryField ? opts.queryField : "query",
    sendModelInBody: opts.sendModelInBody === true,
    responseField: typeof opts.responseField === "string" && opts.responseField ? opts.responseField : undefined,
    fetch: typeof opts.fetch === "function" ? (opts.fetch as typeof globalThis.fetch) : undefined,
  }

  const transport = createTransport(config)

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new ShimLanguageModel(modelId, { provider: "powerautomate", transport })
    },
    chat(modelId: string): LanguageModelV3 {
      return new ShimLanguageModel(modelId, { provider: "powerautomate", transport })
    },
  }
}
