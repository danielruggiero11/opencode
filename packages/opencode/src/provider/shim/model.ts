import {
  type JSONObject,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { countTokens } from "./tokenizer"
import { buildPrompt } from "./prompt"
import { parseResponse } from "./parse"
import { deTemplateBraces, stripZeroWidth } from "./braces"

// A transport performs the actual network call for a backend. It receives the
// fully serialized prompt and the model id (so it can later select a backend
// model), and returns the raw text response. Tool-call detection, streaming
// simulation, and usage estimation are all handled by the shared base class.
export type ShimTransport = (args: {
  prompt: string
  modelId: string
  signal?: AbortSignal
}) => Promise<{ text: string; thinking?: string; requestBody?: string }>

export interface ShimModelConfig {
  // Provider id — used for the `provider` field and providerMetadata key.
  readonly provider: string
  readonly transport: ShimTransport
  // Provider-specific text prepended to every prompt (backend quirk notes).
  readonly preamble?: string
  // When true, break {{ }}/{% %}/{# #} template markers on the way out and undo
  // them on the way back — for backends that run the prompt through a template
  // engine that would otherwise consume those constructs (ServiceNow Now Assist).
  readonly escapeBraces?: boolean
}

// Shared LanguageModelV3 implementation for text-in / text-out backends that
// use the JSON tool-calling shim. Concrete providers (ServiceNow, Power
// Automate, ...) supply only a `transport` and a `provider` name.
export class ShimLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportsStructuredOutputs = false
  readonly supportsImageUrls = false
  readonly supportedUrls = {} as const

  private readonly transport: ShimTransport
  private readonly preamble?: string
  private readonly escapeBraces: boolean

  constructor(modelId: string, config: ShimModelConfig) {
    this.modelId = modelId
    this.provider = config.provider
    this.transport = config.transport
    this.preamble = config.preamble
    this.escapeBraces = config.escapeBraces ?? false
  }

  // Serialize the prompt, applying provider preamble and (optionally) breaking
  // template markers so a downstream {{ }} engine leaves them intact.
  private serialize(options: LanguageModelV3CallOptions): string {
    const prompt = buildPrompt(options, { preamble: this.preamble })
    return this.escapeBraces ? deTemplateBraces(prompt) : prompt
  }

  // Undo template-marker breaking (and any stray zero-width chars) before the
  // response is parsed for tool calls, so edit/write payloads carry real braces.
  private decode(text: string | undefined): string | undefined {
    if (text === undefined) return undefined
    return this.escapeBraces ? stripZeroWidth(text) : text
  }

  private metadata(): SharedV3ProviderMetadata {
    return { [this.provider]: {} as JSONObject }
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
    const prompt = this.serialize(options)
    const { text, thinking, requestBody } = await this.transport({
      prompt,
      modelId: this.modelId,
      signal: options.abortSignal,
    })
    const parsed = parseResponse(this.decode(text)!, this.decode(thinking))

    // Estimate token usage since these backends do not return counts
    const inputTokens = countTokens(prompt)
    const reasoningTokens = thinking ? countTokens(thinking) : 0

    const content: LanguageModelV3Content[] = []
    let outputTokens = 0

    if (parsed.thinking) content.push({ type: "reasoning", text: parsed.thinking })

    if (parsed.type === "tool_calls") {
      outputTokens = countTokens((parsed.text ?? "") + parsed.calls.map((c) => c.input).join(""))
      if (parsed.text) content.push({ type: "text", text: parsed.text })
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
      providerMetadata: this.metadata(),
      request: { body: requestBody ?? JSON.stringify({ prompt }) },
      response: { timestamp: new Date(), modelId: this.modelId },
      warnings: [],
    }
  }

  // Simulates streaming since these backends are synchronous.
  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>
    request: { body: string }
    response: { headers: Record<string, string> }
  }> {
    const prompt = this.serialize(options)
    const { text, thinking, requestBody } = await this.transport({
      prompt,
      modelId: this.modelId,
      signal: options.abortSignal,
    })
    const parsed = parseResponse(this.decode(text)!, this.decode(thinking))
    const warnings: SharedV3Warning[] = []
    const providerMetadata = this.metadata()

    // Estimate token usage since these backends do not return counts
    const inputTokens = countTokens(prompt)
    const outputTokens =
      parsed.type === "tool_calls" ? countTokens(parsed.calls.map((c) => c.input).join("")) : countTokens(parsed.text)
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
          if (parsed.text) {
            controller.enqueue({ type: "text-start", id: "txt-0" })
            controller.enqueue({ type: "text-delta", id: "txt-0", delta: parsed.text })
            controller.enqueue({ type: "text-end", id: "txt-0" })
          }
          for (const call of parsed.calls) {
            controller.enqueue({ type: "tool-input-start", id: call.id, toolName: call.name })
            controller.enqueue({ type: "tool-input-delta", id: call.id, delta: call.input })
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
          providerMetadata,
        })

        controller.close()
      },
    })

    return {
      stream,
      request: { body: requestBody ?? JSON.stringify({ prompt }) },
      response: { headers: {} },
    }
  }
}
