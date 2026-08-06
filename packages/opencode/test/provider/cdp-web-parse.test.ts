// Regression: Copilot emits tool-call JSON as plain text in the web chat, and
// that text often contains backslashes that are NOT valid JSON escapes — e.g. a
// regex like \d+\s or a Windows path like C:\Users\log\test.txt. A strict
// JSON.parse rejects these, so the tool call was silently dropped (the command
// field vanished, surfacing later as a "Missing key" schema error).
//
// The original repair only ran when the text looked like a Windows path (it
// keyed off a drive-letter regex), so regex backslashes with no path present
// fell straight through and broke. It ALSO silently corrupted path segments
// that started with a valid-escape letter (\t in ...\test.txt became a tab).
//
// The fix makes repair CONTEXT-AWARE per string value (how a human reads it):
//  - a value that looks like a Windows path => every backslash is literal, so
//    double all of them, even \t \n \r that resemble valid escapes;
//  - any other value => only invalid escapes (\d, \s) get literalized while
//    genuine \n \t \" \\ \uXXXX are preserved.
//
// These cases lock that behavior in. Group A previously failed; Group B must
// never regress.
import { describe, expect, test } from "bun:test"
import { parseResponse } from "../../src/provider/cdp-web/parse"

// Parse a raw Copilot response and return the first tool call's decoded input
// object, or null if no tool call was recovered.
function firstCallInput(raw: string): Record<string, unknown> | null {
  const parsed = parseResponse(raw)
  if (parsed.type !== "tool_calls" || parsed.calls.length === 0) return null
  try {
    return JSON.parse(parsed.calls[0].input) as Record<string, unknown>
  } catch {
    return null
  }
}

describe("cdp-web parseResponse backslash repair", () => {
  describe("Group A — previously broke, must now parse", () => {
    test("regex backslashes with no Windows path present", () => {
      // \d and \s are invalid JSON escapes; before the fix this was dropped.
      const raw = '{"type":"tool_call","name":"bash","id":"b1","input":{"command":"Select-String -Pattern \\d+\\s"}}'
      expect(firstCallInput(raw)).toEqual({ command: "Select-String -Pattern \\d+\\s" })
    })

    test("windows path whose segment starts with a valid-escape letter (\\test)", () => {
      // The \t in \test.txt must stay a literal backslash, not become a tab.
      const raw = '{"type":"tool_call","name":"read","id":"r1","input":{"filePath":"C:\\Users\\drugg\\log\\test.txt"}}'
      expect(firstCallInput(raw)).toEqual({ filePath: "C:\\Users\\drugg\\log\\test.txt" })
    })

    test("windows path with \\new and \\run segments (\\n, \\r traps)", () => {
      const raw = '{"type":"tool_call","name":"read","id":"r1","input":{"filePath":"C:\\new\\run\\x.txt"}}'
      expect(firstCallInput(raw)).toEqual({ filePath: "C:\\new\\run\\x.txt" })
    })

    test("a path AND a regex in the same command", () => {
      const raw = '{"type":"tool_call","name":"bash","id":"b1","input":{"command":"Select-String C:\\logs\\t.txt -Pattern \\d+"}}'
      expect(firstCallInput(raw)).toEqual({ command: "Select-String C:\\logs\\t.txt -Pattern \\d+" })
    })
  })

  describe("Group B — already worked, must not regress", () => {
    test("escaped quotes in a normal command", () => {
      const raw = JSON.stringify({ type: "tool_call", name: "bash", id: "b1", input: { command: 'echo "hi"' } })
      expect(firstCallInput(raw)).toEqual({ command: 'echo "hi"' })
    })

    test("genuine newline escape in a non-path command stays a newline", () => {
      // Counterweight to the path cases: here \n is MEANT to be a real newline.
      const raw = JSON.stringify({ type: "tool_call", name: "bash", id: "b1", input: { command: "echo a\necho b" } })
      expect(firstCallInput(raw)).toEqual({ command: "echo a\necho b" })
    })

    test("already-correctly-escaped path is not over-doubled", () => {
      const raw = '{"type":"tool_call","name":"read","id":"r1","input":{"filePath":"C:\\\\Users\\\\x"}}'
      expect(firstCallInput(raw)).toEqual({ filePath: "C:\\Users\\x" })
    })

    test("unicode escape is preserved", () => {
      const raw = JSON.stringify({ type: "tool_call", name: "bash", id: "b1", input: { text: "caf\u00e9" } })
      expect(firstCallInput(raw)).toEqual({ text: "caf\u00e9" })
    })

    test("plain input with no backslashes", () => {
      const raw = JSON.stringify({ type: "tool_call", name: "grep", id: "g1", input: { pattern: "meeting" } })
      expect(firstCallInput(raw)).toEqual({ pattern: "meeting" })
    })
  })
})
