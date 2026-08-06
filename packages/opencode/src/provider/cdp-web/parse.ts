import { parseResponse as shimParseResponse, type ParsedResponse } from "../shim/parse"
import { Log } from "@opencode-ai/core/util/log"
const _cdpLog = Log.create({ service: "cdp-web" })
function _cdpFmt(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}
function dlog(...args: unknown[]): void {
  _cdpLog.error(args.map(_cdpFmt).join(" "))
}


/**
 * CDP-Web response parser.
 * Strips Copilot-injected footer and markdown escapes before parsing.
 */
export function parseResponse(raw: string, thinking?: string): ParsedResponse {
  if (typeof raw !== "string") {
    raw = raw != null ? JSON.stringify(raw) : ""
  }
  dlog(`[cdp-web parse] raw (${raw.length} chars): ${raw.slice(0, 300)}`)

  // Strip Copilot injected footer (always appended after the actual response)
  let cleaned = stripCopilotFooter(raw)
  // Remove markdown backslash escapes (tool\_call -> tool_call)
  cleaned = cleaned.replace(/\\([_*\[\]()~`>#+=|{}.!-])/g, "$1")
  cleaned = cleaned.trim()

  if (cleaned !== raw.trim()) {
    dlog(`[cdp-web parse] cleaned (${cleaned.length} chars): ${cleaned.slice(0, 300)}`)
  }

  // Repair unescaped backslashes BEFORE any JSON.parse attempt.
  // Copilot's innerText gives us raw Windows paths like C:\Users\test.txt
  // where \t would be interpreted as a tab by JSON.parse, corrupting keys.
  // Use repairJsonLines (not repairBackslashes directly) so prose text with
  // quotes/apostrophes doesn't corrupt the inString state machine.
  const repaired = repairJsonLines(cleaned)

  if (repaired !== cleaned) {
    dlog(`[cdp-web parse] repaired (${repaired.length} chars): ${repaired.slice(0, 300)}`)
  }

  // Try with repaired text first (handles Windows path backslashes)
  const result = shimParseResponse(repaired, thinking)
  if (result.type === "tool_calls") {
    dlog(`[cdp-web parse] OK: ${result.calls.length} tool call(s): ${result.calls.map((c) => c.name).join(", ")}`)
    return result
  }

  // If repair didn't help, try original cleaned text
  if (repaired !== cleaned) {
    const fallback = shimParseResponse(cleaned, thinking)
    if (fallback.type === "tool_calls") {
      dlog(`[cdp-web parse] OK (fallback): ${fallback.calls.length} tool call(s): ${fallback.calls.map((c) => c.name).join(", ")}`)
      return fallback
    }
  }

  dlog(`[cdp-web parse] text response (no tool calls): ${result.text.slice(0, 100)}`)
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
 * the object.
 *
 * Strategy is CONTEXT-AWARE, decided per string VALUE rather than per char
 * (this is how a human reads it: you see "C:\" and know the whole token is a
 * path, so every backslash in it is literal):
 *  - If a value looks like it contains a Windows path (drive-letter "C:\" or
 *    UNC "\\server"), EVERY backslash in that value is a literal separator, so
 *    we double all of them — even \t, \n, \r that would otherwise look like
 *    valid JSON escapes (e.g. "...\log\test.txt", where \t must stay literal).
 *  - Otherwise we only double INVALID escapes (\d, \s, ...) and leave genuine
 *    escapes (\n, \t, \", \\, \uXXXX) intact, so a real newline in a non-path
 *    command still works.
 *
 * Already-escaped (\\) and escaped-quote (\") sequences are always preserved.
 */
function repairBackslashes(json: string): string {
  // Fast out: nothing to repair if there are no backslashes at all.
  if (json.indexOf("\\") < 0) return json

  let result = ""
  let i = 0
  while (i < json.length) {
    const ch = json[i]
    if (ch !== '"') {
      result += ch
      i++
      continue
    }
    // Opening quote — scan the raw inner text up to the unescaped closing quote,
    // consuming backslash-escaped pairs so an escaped quote (\") doesn't end it.
    let j = i + 1
    let value = ""
    while (j < json.length) {
      if (json[j] === "\\") {
        value += json[j] + (json[j + 1] ?? "")
        j += 2
        continue
      }
      if (json[j] === '"') break
      value += json[j]
      j++
    }
    result += '"' + repairValueBackslashes(value) + '"'
    i = j + 1
  }
  return result
}

/** Valid JSON string escape follow-characters. */
const VALID_JSON_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"])

/** True when a string value looks like it carries a Windows path. */
function looksLikeWindowsPath(value: string): boolean {
  return /[A-Za-z]:\\/.test(value) || /\\\\[A-Za-z0-9]/.test(value)
}

/**
 * Repair backslashes within a single JSON string value's raw inner text.
 * Path context literalizes every backslash; otherwise only invalid escapes are.
 */
function repairValueBackslashes(value: string): string {
  const isPath = looksLikeWindowsPath(value)
  let out = ""
  for (let k = 0; k < value.length; k++) {
    if (value[k] !== "\\") {
      out += value[k]
      continue
    }
    const next = value[k + 1]
    // Always preserve an already-escaped backslash or quote.
    if (next === "\\" || next === '"') {
      out += value[k] + next
      k++
    } else if (isPath) {
      // Path context: this backslash is a literal separator — double it.
      out += "\\\\"
    } else if (next !== undefined && VALID_JSON_ESCAPE.has(next)) {
      // Genuine escape in a non-path value — keep as-is.
      out += value[k] + next
      k++
    } else {
      // Invalid escape (\d, \s, trailing \) — literalize.
      out += "\\\\"
    }
  }
  return out
}
