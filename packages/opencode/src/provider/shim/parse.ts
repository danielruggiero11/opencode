// Response parsing for the text-based tool-calling shim.
//
// The underlying providers (ServiceNow Now Assist, Power Automate, ...) are
// text-in / text-out. The model is instructed via the system prompt to emit a
// JSON object when it wants to call a tool. This module detects and extracts
// those tool calls from the raw text response.

// Parsed result of a model response — supports multiple tool calls.
export type ToolCall = { readonly name: string; readonly id: string; readonly input: string }
export type ParsedResponse =
  | { readonly type: "text"; readonly text: string; readonly thinking?: string }
  | { readonly type: "tool_calls"; readonly calls: readonly ToolCall[]; readonly thinking?: string }

export function parseResponse(raw: string, thinking?: string): ParsedResponse {
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
      // Canonical shape: {"type":"tool_call","name":"<tool>","id":"...","input":{...}}
      if (
        parsed.type === "tool_call" &&
        typeof parsed.name === "string" &&
        typeof parsed.id === "string"
      ) {
        return { name: parsed.name, id: parsed.id, input: JSON.stringify(parsed.input ?? {}) }
      }
      // [LUMEN PATCH — see /CLAUDE.md "Custom Core Patches"] GPT-5 (Power Automate) variant:
      // {"type":"<toolName>","id":"...","input":{...}} — the tool name is in `type`, there is
      // no canonical `name`. Upstream drops this as plain text so the call never fires. Accept
      // a non-"tool_call" string `type` carrying an `input` field as the tool call.
      if (
        typeof parsed.type === "string" &&
        parsed.type !== "tool_call" &&
        typeof parsed.name !== "string" &&
        "input" in parsed
      ) {
        const id = typeof parsed.id === "string" ? parsed.id : `call_${parsed.type}`
        return { name: parsed.type, id, input: JSON.stringify(parsed.input ?? {}) }
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
    if (!trimmed.startsWith("{")) {
      i++
      continue
    }

    // Single-line attempt
    const result = trySingleToolCall(trimmed)
    if (result) {
      calls.push(result)
      i++
      continue
    }

    // Multi-line recovery: if this line looks like the start of a tool call,
    // try joining subsequent lines to form valid JSON
    if (trimmed.startsWith('{"type":"tool_call"') || trimmed.startsWith('{ "type": "tool_call"')) {
      let accumulated = trimmed
      let found = false
      for (let j = i + 1; j < lines.length; j++) {
        accumulated += "\n" + lines[j]
        const multi = trySingleToolCall(accumulated)
        if (multi) {
          calls.push(multi)
          i = j + 1
          found = true
          break
        }
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
          try {
            JSON.parse(rawInput)
            inputStr = rawInput
          } catch {
            inputStr = JSON.stringify({ _truncated: true, _raw: rawInput.slice(0, 500) })
          }
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
