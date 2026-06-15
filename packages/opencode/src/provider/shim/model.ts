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

  constructor(modelId: string, config: ShimModelConfig) {
    this.modelId = modelId
    this.provider = config.provider
    this.transport = config.transport
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
    const prompt = buildPrompt(options)
    const { text, thinking, requestBody } = await this.transport({
      prompt,
      modelId: this.modelId,
      signal: options.abortSignal,
    })
    const parsed = parseResponse(text, thinking)

    // Estimate token usage since these backends do not return counts
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
    const prompt = buildPrompt(options)
    const { text, thinking, requestBody } = await this.transport({
      prompt,
      modelId: this.modelId,
      signal: options.abortSignal,
    })
    const parsed = parseResponse(text, thinking)
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
