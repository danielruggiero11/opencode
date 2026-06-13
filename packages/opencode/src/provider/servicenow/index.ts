import {
  APICallError,
  type JSONObject,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { countTokens } from "./tokenizer"

export interface ServiceNowConfig {
  readonly instanceURL: string
  readonly username: string
  readonly password: string
  readonly capabilityId: string
  readonly fetch?: typeof globalThis.fetch
}

// Parsed result of a ServiceNow response — supports multiple tool calls
type ToolCall = { readonly name: string; readonly id: string; readonly input: string }
type ParsedResponse =
  | { readonly type: "text"; readonly text: string; readonly thinking?: string }
  | { readonly type: "tool_calls"; readonly calls: readonly ToolCall[]; readonly thinking?: string }

class ServiceNowLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "servicenow"
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportsStructuredOutputs = false
  readonly supportsImageUrls = false
  readonly supportedUrls = {} as const

  private readonly config: ServiceNowConfig

  constructor(modelId: string, config: ServiceNowConfig) {
    this.modelId = modelId
    this.config = config
  }

  // ---------------------------------------------------------------------------
  // Prompt serialization
  // ---------------------------------------------------------------------------

  // Converts AI SDK tools into a system-prompt block that instructs Claude to
  // respond with a JSON tool call when it needs to invoke a tool. This is the
  // text-based tool-calling shim: the underlying model is Claude via Bedrock
  // and understands structured JSON reliably.
  private toolsBlock(options: LanguageModelV3CallOptions): string {
    const tools = options.tools
    if (!tools || tools.length === 0 || options.toolChoice?.type === "none") return ""

    const defs = tools
      .filter((t): t is typeof t & { type: "function" } => t.type === "function")
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema,
      }))

    const requiredInstruction =
      options.toolChoice?.type === "required"
        ? "\nYou MUST call one of the available tools in your response."
        : options.toolChoice?.type === "tool"
          ? `\nYou MUST call the tool named "${options.toolChoice.toolName}".`
          : ""

    return `
<tool_use_instructions>
You have access to tools. When you need to call a tool respond with ONLY a valid JSON object — no surrounding text, no markdown fences, no explanation:
{"type":"tool_call","name":"<tool_name>","id":"<unique_string>","input":<json_object>}

Rules:
- Output ONLY the raw JSON when calling a tool.
- One tool call per response.
- After tool results are provided you may call another tool or give your final text answer.
- CRITICAL: Your entire response must be ONLY the JSON object. Do not include any text before or after it. Do not explain what you are doing. Do not narrate. Just output the JSON.
- Do NOT explain what you are about to do before calling a tool. No preamble.
- If you want to communicate with the user, do NOT call a tool — just respond with plain text. Never mix text and a tool call in the same response.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. ALWAYS maximize use of parallel tool calls — aim for 5-10+ parallel calls whenever there are independent operations. This dramatically reduces round-trips. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially.
- To make multiple tool calls in one response, output each JSON object on its own line (one per line, no array wrapper):
{"type":"tool_call","name":"tool_a","id":"id_1","input":{...}}
{"type":"tool_call","name":"tool_b","id":"id_2","input":{...}}
{"type":"tool_call","name":"tool_c","id":"id_3","input":{...}}${requiredInstruction}

Available tools:
${JSON.stringify(defs, null, 2)}
</tool_use_instructions>`
  }

  // Builds the full userprompt string that ServiceNow receives. Packs the
  // system message, tool block, and full conversation history into one string.
  private buildPrompt(options: LanguageModelV3CallOptions): string {
    const sections: string[] = []
    const turns: string[] = []

    const toolBlock = this.toolsBlock(options)

    for (const msg of options.prompt) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : ""
        if (text) sections.push(`<system>\n${text}${toolBlock ? "\n" + toolBlock : ""}\n</system>`)
        continue
      }

      if (msg.role === "user") {
        const text = Array.isArray(msg.content)
          ? msg.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("")
          : String(msg.content)
        turns.push(`Human: ${text}`)
        continue
      }

      if (msg.role === "assistant") {
        const parts: string[] = []
        if (Array.isArray(msg.content)) {
          for (const p of msg.content) {
            if (p.type === "text") {
              parts.push((p as { type: "text"; text: string }).text)
            } else if (p.type === "tool-call") {
              const tc = p as { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
              const inputObj = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input
              parts.push(
                JSON.stringify({ type: "tool_call", name: tc.toolName, id: tc.toolCallId, input: inputObj }),
              )
            }
          }
        }
        const text = parts.join("\n")
        if (text) turns.push(`Assistant: ${text}`)
        continue
      }

      // tool results — feed back to Claude as the Human turn
      if (msg.role === "tool") {
        const results = Array.isArray(msg.content)
          ? (
              msg.content as Array<{
                type: string
                toolCallId?: string
                toolName?: string
                output?: { type: string; value: unknown } | unknown
                isError?: boolean
              }>
            )
              .map((p) => {
                const out = p.output as { type?: string; value?: unknown } | undefined
                const val =
                  out?.type === "text" && typeof out.value === "string"
                    ? out.value
                    : out?.value !== undefined
                      ? JSON.stringify(out.value)
                      : JSON.stringify(out ?? p)
                const label = p.toolName ?? p.toolCallId ?? "tool"
                const status = p.isError ? "ERROR" : "OK"
                return `[${label} → ${status}]\n${val}`
              })
              .join("\n\n")
          : ""
        if (results) turns.push(`Human: [Tool Results]\n${results}`)
      }
    }

    // If there was no <system> block but we have tools, prepend the tool block
    if (sections.length === 0 && toolBlock) {
      sections.push(toolBlock)
    }

    if (turns.length > 0) sections.push(turns.join("\n\n"))
    return sections.join("\n\n")
  }

  // ---------------------------------------------------------------------------
  // API call
  // ---------------------------------------------------------------------------

  private async callAPI(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; thinking?: string }> {
    const { instanceURL, username, password, capabilityId } = this.config
    const fetchFn = this.config.fetch ?? globalThis.fetch
    const credentials = Buffer.from(`${username}:${password}`).toString("base64")
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetchFn(`${instanceURL}/api/now/oneextend/scripted/setup_and_execute`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "sync",
          executionRequests: [{ capabilityId, payload: { userprompt: prompt } }],
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
            url: `${instanceURL}/api/now/oneextend/scripted/setup_and_execute`,
            requestBodyValues: { capabilityId },
            statusCode: 413,
            responseBody: capJson,
            isRetryable: false,
          })
        }

        // Retry on transient skill status failures (e.g. status: unknown)
        if (attempt < maxAttempts) {
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
      }
    }

    // Unreachable — the loop always returns or throws on the final attempt
    throw new Error("ServiceNow callAPI: exhausted retries")
  }

  // ---------------------------------------------------------------------------
  // Response parsing — detect whether Claude chose to call a tool
  // ---------------------------------------------------------------------------

  private parseResponse(raw: string, thinking?: string): ParsedResponse {
    // Defensive: ensure raw is always a string even if upstream typing is bypassed
    if (typeof raw !== "string") {
      raw = raw != null ? JSON.stringify(raw) : ""
    }

    const trySingleToolCall = (s: string): ToolCall | null => {
      // Strip markdown code fences e.g. ```json\n{...}\n```
      const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
      const candidate = fenceMatch ? fenceMatch[1].trim() : s.trim()
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>
        if (
          parsed.type === "tool_call" &&
          typeof parsed.name === "string" &&
          typeof parsed.id === "string"
        ) {
          return { name: parsed.name, id: parsed.id, input: JSON.stringify(parsed.input ?? {}) }
        }
      } catch {
        // not valid JSON
      }
      return null
    }

    // Try the full response as a single tool call first
    const fromFull = trySingleToolCall(raw)
    if (fromFull) return { type: "tool_calls", calls: [fromFull], thinking }

    // Collect all tool calls found across lines
    const calls: ToolCall[] = []
    const lines = raw.split("\n")
    let i = 0
    while (i < lines.length) {
      const trimmed = lines[i].trim()
      if (!trimmed.startsWith("{")) { i++; continue }

      // Single-line attempt
      const result = trySingleToolCall(trimmed)
      if (result) { calls.push(result); i++; continue }

      // Multi-line recovery: if this line looks like the start of a tool call,
      // try joining subsequent lines to form valid JSON
      if (trimmed.startsWith('{"type":"tool_call"') || trimmed.startsWith('{ "type": "tool_call"')) {
        let accumulated = trimmed
        let found = false
        for (let j = i + 1; j < lines.length; j++) {
          accumulated += "\n" + lines[j]
          const multi = trySingleToolCall(accumulated)
          if (multi) { calls.push(multi); i = j + 1; found = true; break }
        }
        if (found) continue

        // Truncated tool call — try regex extraction as last resort
        const nameMatch = accumulated.match(/"name"\s*:\s*"([^"]+)"/)
        const idMatch = accumulated.match(/"id"\s*:\s*"([^"]+)"/)
        const inputMatch = accumulated.match(/"input"\s*:\s*(\{[\s\S]*)/)
        if (nameMatch && idMatch) {
          let inputStr = "{}"
          if (inputMatch) {
            const rawInput = inputMatch[1]
            try { JSON.parse(rawInput); inputStr = rawInput }
            catch { inputStr = JSON.stringify({ _truncated: true, _raw: rawInput.slice(0, 500) }) }
          }
          calls.push({ name: nameMatch[1], id: idMatch[1], input: inputStr })
        }
        i++
        continue
      }
      i++
    }

    if (calls.length > 0) return { type: "tool_calls", calls, thinking }
    return { type: "text", text: raw, thinking }
  }

  // ---------------------------------------------------------------------------
  // doGenerate
  // ---------------------------------------------------------------------------

  async doGenerate(options: LanguageModelV3CallOptions): Promise<{
    content: LanguageModelV3Content[]
    finishReason: { unified: "stop" | "tool-calls"; raw: string }
    usage: {
      inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: undefined; cacheWrite: undefined }
      outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined }
      raw: undefined
    }
    providerMetadata: SharedV3ProviderMetadata
    request: { body: string }
    response: { timestamp: Date; modelId: string }
    warnings: SharedV3Warning[]
  }> {
    const prompt = this.buildPrompt(options)
    const { text, thinking } = await this.callAPI(prompt, options.abortSignal)
    const parsed = this.parseResponse(text, thinking)

    // Estimate token usage since the ServiceNow API does not return counts
    const inputTokens = countTokens(prompt)
    const reasoningTokens = thinking ? countTokens(thinking) : 0

    const content: LanguageModelV3Content[] = []
    let outputTokens = 0

    if (parsed.thinking) content.push({ type: "reasoning", text: parsed.thinking })

    if (parsed.type === "tool_calls") {
      outputTokens = countTokens(parsed.calls.map((c) => c.input).join(""))
      for (const call of parsed.calls) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        })
      }
    } else {
      outputTokens = countTokens(parsed.text)
      content.push({ type: "text", text: parsed.text })
    }

    return {
      content,
      finishReason: {
        unified: parsed.type === "tool_calls" ? "tool-calls" : "stop",
        raw: parsed.type === "tool_calls" ? "tool_use" : "end_turn",
      },
      usage: {
        inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: outputTokens + reasoningTokens, text: outputTokens, reasoning: reasoningTokens },
        raw: undefined,
      },
      providerMetadata: { servicenow: {} as JSONObject },
      request: { body: JSON.stringify({ mode: "sync", userprompt: prompt }) },
      response: { timestamp: new Date(), modelId: this.modelId },
      warnings: [],
    }
  }

  // ---------------------------------------------------------------------------
  // doStream — simulates streaming since ServiceNow is synchronous
  // ---------------------------------------------------------------------------

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>
    request: { body: string }
    response: { headers: Record<string, string> }
  }> {
    const prompt = this.buildPrompt(options)
    const { text, thinking } = await this.callAPI(prompt, options.abortSignal)
    const parsed = this.parseResponse(text, thinking)
    const warnings: SharedV3Warning[] = []

    // Estimate token usage since the ServiceNow API does not return counts
    const inputTokens = countTokens(prompt)
    const outputTokens = parsed.type === "tool_calls"
      ? countTokens(parsed.calls.map((c) => c.input).join(""))
      : countTokens(parsed.text)
    const reasoningTokens = thinking ? countTokens(thinking) : 0

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })

        if (parsed.thinking) {
          controller.enqueue({ type: "reasoning-start", id: "reasoning-0" })
          controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: parsed.thinking })
          controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
        }

        if (parsed.type === "tool_calls") {
          for (const call of parsed.calls) {
            controller.enqueue({
              type: "tool-input-start",
              id: call.id,
              toolName: call.name,
            })
            controller.enqueue({
              type: "tool-input-delta",
              id: call.id,
              delta: call.input,
            })
            controller.enqueue({ type: "tool-input-end", id: call.id })
            controller.enqueue({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })
          }
        } else {
          controller.enqueue({ type: "text-start", id: "txt-0" })
          controller.enqueue({ type: "text-delta", id: "txt-0", delta: parsed.text })
          controller.enqueue({ type: "text-end", id: "txt-0" })
        }

        controller.enqueue({
          type: "finish",
          finishReason: {
            unified: parsed.type === "tool_calls" ? "tool-calls" : "stop",
            raw: parsed.type === "tool_calls" ? "tool_use" : "end_turn",
          },
          usage: {
            inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: outputTokens + reasoningTokens, text: outputTokens, reasoning: reasoningTokens },
            raw: undefined,
          },
          providerMetadata: { servicenow: {} as JSONObject },
        })

        controller.close()
      },
    })

    return {
      stream,
      request: { body: JSON.stringify({ mode: "sync", userprompt: prompt }) },
      response: { headers: {} },
    }
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

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new ServiceNowLanguageModel(modelId, config)
    },
    chat(modelId: string): LanguageModelV3 {
      return new ServiceNowLanguageModel(modelId, config)
    },
  }
}
