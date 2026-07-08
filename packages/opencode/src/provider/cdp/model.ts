/**
 * CDPLanguageModel — Stateful LanguageModelV3 implementation that maintains
 * a persistent conversation in M365 Copilot. Only sends new messages each
 * turn instead of re-serializing the entire history.
 *
 * Session lifecycle:
 *   1. First doGenerate() call → open new chat, set Opus, send system + tools + user message
 *   2. Subsequent calls → detect delta messages, format and send only the new ones
 *   3. Session invalidation → system prompt changes or connection lost → start fresh
 *
 * Tool calls flow:
 *   - Model responds with tool-call JSON → parsed by parseResponse()
 *   - opencode executes tool, calls doGenerate() again with tool results appended
 *   - We format the tool results as the next user message in the conversation
 *   - Model responds with either more tool calls or final text
 */
import {
  type JSONObject,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { parseResponse } from "../shim/parse"
import { countTokens } from "../shim/tokenizer"
import {
  getSession,
  createSession,
  resetSession,
  ensureClient,
  computeFingerprint,
} from "./session"
import {
  checkComposer,
  openNewChat,
  setEffort,
  sendPrompt,
  getTurnCount,
  awaitResponse,
  extractResponseRaw,
  CopilotReauthRequired,
} from "./driver"
import { CDPError } from "./client"

interface CDPModelConfig {
  port: number
  effort: string
  timeout: number
}

/**
 * Format the tool-use instructions block (same as shim/prompt.ts toolsBlock).
 */
function toolsBlock(options: LanguageModelV3CallOptions): string {
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

/**
 * Extract system content from the prompt.
 */
function extractSystem(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const parts: string[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : ""
      if (text) parts.push(text)
    }
  }
  return parts.join("\n")
}

/**
 * Get tool names from options (for fingerprinting).
 */
function getToolNames(options: LanguageModelV3CallOptions): string[] {
  if (!options.tools) return []
  return options.tools
    .filter((t): t is typeof t & { type: "function" } => t.type === "function")
    .map((t) => t.name)
    .sort()
}

/**
 * Format the initial message (system prompt + tools + first user message).
 */
function formatInitialMessage(options: LanguageModelV3CallOptions): string {
  const system = extractSystem(options.prompt)
  const tools = toolsBlock(options)
  const sections: string[] = []

  if (system) sections.push(system)
  if (tools) sections.push(tools)

  // Find the first user message
  for (const msg of options.prompt) {
    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : String(msg.content)
      if (text) sections.push(text)
      break
    }
  }

  return sections.join("\n\n")
}

/**
 * Format delta messages (only the new ones since last send).
 * Skips system and assistant messages (assistant responses are already in the
 * Copilot conversation). Only formats user and tool-result messages.
 */
function formatDeltaMessages(prompt: LanguageModelV3CallOptions["prompt"], startIndex: number): string {
  const parts: string[] = []

  for (let i = startIndex; i < prompt.length; i++) {
    const msg = prompt[i]

    // Skip system (already sent) and assistant (Copilot already produced these)
    if (msg.role === "system" || msg.role === "assistant") continue

    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : String(msg.content)
      if (text) parts.push(text)
    }

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
      if (results) parts.push(`[Tool Results]\n${results}`)
    }
  }

  return parts.join("\n\n")
}

export class CDPLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "cdp"
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportsStructuredOutputs = false
  readonly supportsImageUrls = false
  readonly supportedUrls = {} as const

  private readonly config: CDPModelConfig

  constructor(modelId: string, config: CDPModelConfig) {
    this.modelId = modelId
    this.config = config
  }

  private metadata(): SharedV3ProviderMetadata {
    return { cdp: {} as JSONObject }
  }

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
    const systemContent = extractSystem(options.prompt)
    const toolNames = getToolNames(options)
    const fingerprint = computeFingerprint(systemContent, toolNames)

    let session = getSession()
    let messageToSend: string
    let isInitial = false

    // Determine if we need a new session or can continue
    if (!session || session.systemFingerprint !== fingerprint) {
      // New session (first call or system prompt changed)
      session = createSession(fingerprint)
      messageToSend = formatInitialMessage(options)
      isInitial = true
    } else if (session.messagesSent >= options.prompt.length) {
      // Session was somehow reset (fewer messages than we sent) — start fresh
      session = createSession(fingerprint)
      messageToSend = formatInitialMessage(options)
      isInitial = true
    } else {
      // Continue existing conversation — send only the delta
      messageToSend = formatDeltaMessages(options.prompt, session.messagesSent)
      if (!messageToSend.trim()) {
        // Edge case: nothing new to send (shouldn't happen, but handle gracefully)
        // This can happen if the only new messages are assistant messages
        // In this case, format the last user/tool message
        const lastMsg = options.prompt[options.prompt.length - 1]
        if (lastMsg.role === "user" || lastMsg.role === "tool") {
          messageToSend = formatDeltaMessages(options.prompt, options.prompt.length - 1)
        } else {
          // Nothing to send — shouldn't reach here
          throw new CDPError("No new message to send to Copilot")
        }
      }
    }

    // Get or reconnect CDP client
    let client: Awaited<ReturnType<typeof ensureClient>>
    try {
      client = await ensureClient(this.config.port)
    } catch (err) {
      // Connection failed — reset session and try fresh
      resetSession()
      throw err
    }

    // Initialize conversation if needed
    if (isInitial || !session.initialized) {
      const hasComposer = await checkComposer(client)
      if (!hasComposer) throw new CopilotReauthRequired()

      await openNewChat(client)
      await setEffort(client, this.config.effort)
      session.initialized = true
      session.turnCount = 0
    }

    // Get current turn count before sending (to know which turn to wait for)
    const turnsBefore = await getTurnCount(client)

    // Send the message
    await sendPrompt(client, messageToSend)

    // Update session state: mark all prompt messages as sent
    session.messagesSent = options.prompt.length

    // Wait for response (the new turn at index turnsBefore)
    let responseText: string
    try {
      responseText = await awaitResponse(client, turnsBefore, this.config.timeout, options.abortSignal)
    } catch (err) {
      // If timeout or connection issue, reset so next call starts fresh
      if (err instanceof CDPError && err.message.includes("not complete")) {
        resetSession()
      }
      throw err
    }

    // Try clipboard extraction for exact source
    const raw = await extractResponseRaw(client, turnsBefore)
    const finalText = raw || responseText

    session.turnCount++

    // Parse response (detect tool calls)
    const parsed = parseResponse(finalText)

    // Estimate token usage
    const inputTokens = countTokens(messageToSend)
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
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
        raw: undefined,
      },
      providerMetadata: this.metadata(),
      request: { body: JSON.stringify({ message: messageToSend.slice(0, 500) + "..." }) },
      response: { timestamp: new Date(), modelId: this.modelId },
      warnings: [],
    }
  }

  // Simulates streaming (CDP responses come all at once after polling).
  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>
    request: { body: string }
    response: { headers: Record<string, string> }
  }> {
    // Just call doGenerate and emit everything at once
    const result = await this.doGenerate(options)
    const warnings: SharedV3Warning[] = result.warnings
    const providerMetadata = result.providerMetadata

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })

        for (const part of result.content) {
          if (part.type === "reasoning") {
            controller.enqueue({ type: "reasoning-start", id: "reasoning-0" })
            controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: part.text })
            controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
          } else if (part.type === "tool-call") {
            controller.enqueue({ type: "tool-input-start", id: part.toolCallId, toolName: part.toolName })
            controller.enqueue({ type: "tool-input-delta", id: part.toolCallId, delta: part.input })
            controller.enqueue({ type: "tool-input-end", id: part.toolCallId })
            controller.enqueue({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            })
          } else if (part.type === "text") {
            controller.enqueue({ type: "text-start", id: "txt-0" })
            controller.enqueue({ type: "text-delta", id: "txt-0", delta: part.text })
            controller.enqueue({ type: "text-end", id: "txt-0" })
          }
        }

        controller.enqueue({
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
          providerMetadata,
        })

        controller.close()
      },
    })

    return {
      stream,
      request: result.request,
      response: { headers: {} },
    }
  }
}
