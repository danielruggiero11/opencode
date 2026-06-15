import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// Prompt serialization for the text-based tool-calling shim.
//
// Converts the AI SDK's structured prompt (system/user/assistant/tool messages
// plus tool definitions) into a single text string that a text-in / text-out
// backend (ServiceNow Now Assist, Power Automate, ...) can consume. The
// underlying model is Claude-family and follows JSON tool-call instructions
// reliably, so tools are described in a system-prompt block.

// Converts AI SDK tools into a system-prompt block that instructs the model to
// respond with a JSON tool call when it needs to invoke a tool.
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

// Builds the full prompt string the backend receives. Packs the system message,
// tool block, and full conversation history into one string.
export function buildPrompt(options: LanguageModelV3CallOptions): string {
  const sections: string[] = []
  const turns: string[] = []

  const toolBlock = toolsBlock(options)

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
            parts.push(JSON.stringify({ type: "tool_call", name: tc.toolName, id: tc.toolCallId, input: inputObj }))
          }
        }
      }
      const text = parts.join("\n")
      if (text) turns.push(`Assistant: ${text}`)
      continue
    }

    // tool results — feed back to the model as the Human turn
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
