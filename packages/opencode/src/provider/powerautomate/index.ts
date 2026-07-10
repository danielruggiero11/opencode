import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { ShimLanguageModel, type ShimTransport } from "../shim/model"
import { parseResponse } from "../shim/parse"

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
  // Per-device authorization secret sent as the `x-lumen-secret` header. The
  // flow rejects calls whose secret isn't a known, active one (otherwise the
  // signed trigger URL would be an open, unauthenticated LLM endpoint). When
  // unset here it falls back to the POWERAUTOMATE_SECRET env var at call time —
  // so opencode works standalone (export the var) and Lumen-driven (Lumen
  // injects it when launching `opencode serve`). See LumenPowerPages/docs.
  readonly secret?: string
  readonly fetch?: typeof globalThis.fetch
}

// Resolve the device secret: explicit config wins, else the env var (read at
// call time so a secret minted after process start is still picked up).
function resolveSecret(config: PowerAutomateConfig): string | undefined {
  if (config.secret) return config.secret
  const fromEnv = process.env["POWERAUTOMATE_SECRET"]
  return fromEnv && fromEnv.trim() ? fromEnv : undefined
}

// GPT-5 specific prompt suffix — reinforces tool-call formatting compliance.
// Appended to every prompt sent through this transport. Does not affect the
// shared shim or ServiceNow provider.
const GPT5_TOOL_REINFORCEMENT = `

<assistant_instructions>
REMINDER — CRITICAL FORMATTING RULES:
- When you decide to use a tool, your ENTIRE response must be ONLY the JSON object.
- Do NOT write any text, commentary, narration, or status updates before or after the JSON.
- Do NOT say things like "Let me...", "I'll...", "Updating...", "~ ...", or any preamble.
- WRONG: "~ Updating todos...\n{"type":"tool_call",...}" 
- WRONG: "I don't have enough information. {"type":"tool_call",...}"
- CORRECT: {"type":"tool_call","name":"todowrite","id":"td_1","input":{...}}
- If you cannot fulfill the request, just say so in plain text WITHOUT attempting a tool call.
- If you CAN fulfill the request, output ONLY the tool call JSON with zero other text.
</assistant_instructions>`

// Detects whether a response text looks like a failed tool-call attempt — the
// model tried to call a tool but wrapped it in commentary or produced the text
// equivalent without proper JSON. Used to trigger a corrective retry.
function looksLikeFailedToolCall(text: string): boolean {
  // Must contain a literal fragment of tool-call JSON structure
  if (!text.includes('"type"') && !text.includes('"tool_call"') && !text.includes('"input"')) return false
  // But parseResponse didn't extract it as a tool call (caller checks this),
  // so look for indicators that the model intended to call a tool:
  // 1. Contains a partial JSON object with tool_call markers
  if (text.includes('{"type":"tool_call"') || text.includes('{ "type": "tool_call"')) return true
  // 2. Contains tool-call-like structure with type+input but surrounding text
  if (text.includes('"input"') && (text.includes('"name"') || text.includes('"type"'))) {
    // Only trigger if there's non-JSON text surrounding it (not just a standalone object)
    const trimmed = text.trim()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return true
  }
  return false
}

// Corrective prompt appended when retrying after a failed tool-call detection.
const CORRECTIVE_RETRY_SUFFIX = `

Human: Your previous response was not formatted correctly. You included text/commentary alongside or instead of the JSON tool call. Please try again. Output ONLY the raw JSON tool call object — nothing else. No text before it, no text after it, no markdown fences. Just the JSON:
{"type":"tool_call","name":"<tool_name>","id":"<unique_id>","input":{...}}

Assistant:`

// Builds the transport that performs the Power Automate flow call. Everything
// else (prompt serialization, tool-call parsing, streaming) is handled by the
// shared shim base class.
function createTransport(config: PowerAutomateConfig): ShimTransport {
  const { url, queryField, sendModelInBody, responseField } = config
  const fetchFn = config.fetch ?? globalThis.fetch
  const maxAttempts = 3

  // Core fetch logic — makes one HTTP call to the PA flow and returns the text.
  async function callFlow(
    prompt: string,
    modelId: string,
    signal: AbortSignal | undefined,
    secret: string | undefined,
  ): Promise<{ text: string; requestBody: string }> {
    const body: Record<string, unknown> = { [queryField]: prompt }
    if (sendModelInBody) body.model = modelId
    const requestBody = JSON.stringify(body)

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (secret) headers["x-lumen-secret"] = secret

    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers,
          body: requestBody,
          signal,
        })
      } catch (err) {
        lastError = err
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500))
          continue
        }
        throw err
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "")
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

      const raw = await res.text()
      const text = extractText(raw, responseField)
      if (!text) {
        throw new Error(`Power Automate returned empty response — raw: ${raw.slice(0, 500)}`)
      }

      return { text, requestBody }
    }

    throw lastError instanceof Error ? lastError : new Error("Power Automate transport: exhausted retries")
  }

  return async ({ prompt, modelId, signal }) => {
    // Append GPT-5 specific reinforcement to the prompt
    const reinforcedPrompt = prompt + GPT5_TOOL_REINFORCEMENT

    // Authorization secret — resolved per request
    const secret = resolveSecret(config)

    const result = await callFlow(reinforcedPrompt, modelId, signal, secret)

    // Check if the response is a failed tool-call attempt. If so, retry once
    // with a corrective prompt that tells the model to output only JSON.
    const parsed = parseResponse(result.text)
    if (parsed.type === "text" && looksLikeFailedToolCall(parsed.text)) {
      const correctedPrompt = reinforcedPrompt + `\n\nAssistant: ${result.text}` + CORRECTIVE_RETRY_SUFFIX
      const retryResult = await callFlow(correctedPrompt, modelId, signal, secret)
      return retryResult
    }

    return result
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
    secret?: unknown
    fetch?: unknown
  },
) {
  const config: PowerAutomateConfig = {
    url: String(opts.url ?? ""),
    queryField: typeof opts.queryField === "string" && opts.queryField ? opts.queryField : "query",
    sendModelInBody: opts.sendModelInBody === true,
    responseField: typeof opts.responseField === "string" && opts.responseField ? opts.responseField : undefined,
    secret: typeof opts.secret === "string" && opts.secret ? opts.secret : undefined,
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
