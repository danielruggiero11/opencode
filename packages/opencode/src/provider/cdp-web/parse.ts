import { parseResponse as shimParseResponse, type ParsedResponse } from "../shim/parse"

/**
 * CDP-Web response parser.
 * Strips Copilot-injected footer and markdown escapes before parsing.
 */
export function parseResponse(raw: string, thinking?: string): ParsedResponse {
  if (typeof raw !== "string") {
    raw = raw != null ? JSON.stringify(raw) : ""
  }
  console.error(`[cdp-web parse] raw (${raw.length} chars): ${raw.slice(0, 300)}`)

  // Strip Copilot injected footer (always appended after the actual response)
  let cleaned = stripCopilotFooter(raw)
  // Remove markdown backslash escapes (tool\_call -> tool_call)
  cleaned = cleaned.replace(/\\([_*\[\]()~`>#+=|{}.!-])/g, "$1")
  cleaned = cleaned.trim()

  if (cleaned !== raw.trim()) {
    console.error(`[cdp-web parse] cleaned (${cleaned.length} chars): ${cleaned.slice(0, 300)}`)
  }

  // Repair unescaped backslashes BEFORE any JSON.parse attempt.
  // Copilot's innerText gives us raw Windows paths like C:\Users\test.txt
  // where \t would be interpreted as a tab by JSON.parse, corrupting keys.
  // Use repairJsonLines (not repairBackslashes directly) so prose text with
  // quotes/apostrophes doesn't corrupt the inString state machine.
  const repaired = repairJsonLines(cleaned)

  if (repaired !== cleaned) {
    console.error(`[cdp-web parse] repaired (${repaired.length} chars): ${repaired.slice(0, 300)}`)
  }

  // Try with repaired text first (handles Windows path backslashes)
  const result = shimParseResponse(repaired, thinking)
  if (result.type === "tool_calls") {
    console.error(`[cdp-web parse] OK: ${result.calls.length} tool call(s): ${result.calls.map((c) => c.name).join(", ")}`)
    return result
  }

  // If repair didn't help, try original cleaned text
  if (repaired !== cleaned) {
    const fallback = shimParseResponse(cleaned, thinking)
    if (fallback.type === "tool_calls") {
      console.error(`[cdp-web parse] OK (fallback): ${fallback.calls.length} tool call(s): ${fallback.calls.map((c) => c.name).join(", ")}`)
      return fallback
    }
  }

  console.error(`[cdp-web parse] text response (no tool calls): ${result.text.slice(0, 100)}`)
  return result
}

/**
 * Strip Copilot footer text that gets appended to every response.
 * This text appears after the actual model output and prevents JSON parsing.
 */
function stripCopilotFooter(raw: string): string {
  // The footer starts with "Generate the response in language" or "Generate the reasoning"
  const footerIdx = raw.indexOf("\nGenerate the re")
  if (footerIdx > 0) return raw.slice(0, footerIdx)
  // Also check for double-newline separated footer
  const footer2 = raw.indexOf("\n\nGenerate the re")
  if (footer2 > 0) return raw.slice(0, footer2)
  return raw
}

/**
 * Apply backslash repair only to JSON blocks within the response.
 * A JSON block starts at a line beginning with `{` and continues until
 * brace depth returns to zero (handles multi-line tool calls).
 * Prose lines are passed through unchanged, preventing quote characters
 * in English text from corrupting the inString state machine.
 */
function repairJsonLines(text: string): string {
  const lines = text.split("\n")
  const result: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith("{")) {
      // Collect the full JSON block (may span multiple lines)
      let block = lines[i]
      let depth = 0
      let inStr = false
      for (const ch of trimmed) {
        if (ch === '"' && (block.length === 0 || block[block.length - 1] !== '\\')) inStr = !inStr
        if (!inStr && ch === '{') depth++
        if (!inStr && ch === '}') depth--
      }
      let end = i
      while (depth > 0 && end + 1 < lines.length) {
        end++
        block += "\n" + lines[end]
        for (const ch of lines[end]) {
          if (ch === '"' && (block.length === 0 || block[block.length - 1] !== '\\')) inStr = !inStr
          if (!inStr && ch === '{') depth++
          if (!inStr && ch === '}') depth--
        }
      }
      // Repair the full JSON block as one unit
      const repaired = repairBackslashes(block)
      if (repaired !== block) changed = true
      result.push(repaired)
      i = end + 1
    } else {
      result.push(lines[i])
      i++
    }
  }
  return changed ? result.join("\n") : text
}

/**
 * Fix unescaped backslashes inside JSON string values.
 * Only needed when Copilot returns innerText (not clipboard).
 *
 * Copilot emits tool calls with raw Windows paths like:
 *   "filePath": "C:\Users\drugg\test.txt"
 * where \U, \t etc. are NOT intended as JSON escapes but as literal
 * path separators. JSON.parse would interpret \t as tab, corrupting
 * the object. We double all lone backslashes inside JSON strings.
 *
 * Already-escaped sequences (\\) are preserved as-is.
 */
function repairBackslashes(json: string): string {
  // Only activate when the text looks like it contains Windows paths
  if (!/[A-Za-z]:\\?[A-Za-z]/i.test(json) && !/[A-Za-z]:[/\\]/i.test(json)) return json
  let result = ""
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"' && (i === 0 || json[i - 1] !== '\\')) {
      inString = !inString
      result += ch
    } else if (inString && ch === '\\') {
      const next = json[i + 1]
      // Already-escaped: \\ or \" — pass through both chars
      if (next === '\\' || next === '"') {
        result += ch + next
        i++
      } else {
        // Lone backslash — double it so JSON.parse sees a literal backslash
        result += '\\\\'
      }
    } else {
      result += ch
    }
  }
  return result
}
