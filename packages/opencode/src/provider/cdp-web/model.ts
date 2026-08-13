/**
 * CDPWebLanguageModel — Pooled LanguageModelV3 implementation that manages
 * multiple concurrent Copilot conversations via browser tabs.
 *
 * Each doGenerate() call:
 * 1. Acquires a session from the pool (or creates a new tab)
 * 2. Sends the prompt delta to that tab's Copilot conversation
 * 3. Awaits and parses the response
 * 4. Releases the session back to the pool
 *
 * This allows unlimited parallel conversations.
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
import { parseResponse } from "./parse"
import { parseResponse as parseResponseClean } from "../shim/parse"
import { countTokens } from "../shim/tokenizer"
import {
  createSession,
  acquireSession,
  releaseSession,
  destroySession,
  connectSession,
  computeFingerprint,
  isTargetClaimed,
  type SessionState,
} from "./session"
import {
  checkAuth,
  checkComposer,
  checkReauth,
  clickReauthContinue,
  openNewChat,
  setEffort,
  EFFORT_LABELS,
  sendPrompt,
  getTurnCount,
  awaitResponse,
  extractResponseRaw,
  attachFiles,
  CopilotReauthRequired,
  enableWsCapture,
  beginResponseCapture,
  waitForConversationId,
  reopenConversation,
  getConversationInfo,
} from "./driver"
import { extractFilePathsFromText } from "./extract-paths"
import { CDPClient, CDPError, findCopilotTabs, listTargets, createTabViaCDP } from "./client"
import { ensureBrowser, openCopilotTab, closeBrowser, getLaunchedHeadless } from "./browser"
import { claimedGuids, writeClaim, releaseClaim, claimedTargetIds, writeTargetClaim, touchTargetClaim } from "./claims"
import path from "path"
import os from "os"
import { existsSync } from "fs"
import { formatCopilotTools } from "./tool-manifest"
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


interface CDPWebModelConfig {
  port: number
  effort: string
  timeout: number
  /** Launch the browser headless. Config-driven via opencode.jsonc. Default false. */
  headless?: boolean
  /** Which browser to launch. Config-driven via opencode.jsonc. Default "chrome". */
  browser?: "chrome" | "edge" | "auto"
  /**
   * DEBUG: force the full headless→headed swap machinery (close → relaunch →
   * rebind) to run during a reauth EVEN when the steady-state is already headed.
   * Lets you exercise/harden the swap path without committing to headless daily.
   * You still trigger it by causing a real reauth (e.g. logging out). Default false.
   */
  forceAuthSwap?: boolean
  /** Optional real browser User Data root to drive the user's actual profile. */
  profileDir?: string
  /** Optional --profile-directory (e.g. "Default") within that User Data root. */
  profileDirectory?: string
}

/**
 * Extract the workspace root from the system prompt ("Working directory: ...").
 */
function extractWorkspaceRoot(systemText: string): string {
  const match = systemText.match(/Working directory:\s*(.+)/)
  return match?.[1]?.trim() || process.cwd()
}

/**
 * Look for a project manifest/guide file at the TOP LEVEL of the workspace
 * (the folder we're located in — not subdirectories). Returns the absolute
 * path of the first one found, or null if none exist. This is only a pointer;
 * the file is never auto-loaded into the prompt.
 */
function findManifestFile(workspaceRoot: string): string | null {
  const candidates = ["CLAUDE.md"]
  for (const name of candidates) {
    const full = path.join(workspaceRoot, name)
    try {
      if (existsSync(full)) return full
    } catch {
      // ignore fs errors — treat as "not present"
    }
  }
  return null
}

/**
 * Build the Copilot system preamble — replaces the generic opencode system prompt.
 */
function copilotPreamble(workspaceRoot: string, manifestPath: string | null): string {
  return [
    'You are a coding agent working on a local project. I am your execution runtime.',
    'You do not have a local copy of the code and any sandbox you have is empty — do not try to read from it or verify anything yourself.',
    'Instead, whenever you need to see a file or search the code, respond with ONLY this JSON (no prose, no markdown fences, no explanation before or after):',
    '{"type":"tool_call","name":"<tool_name>","id":"<any_string>","input":{<parameters>}}',
    '',
    'I will run that command on my machine and paste the output back. Then you continue — either with another tool call or your final answer.',
    '',
    'ASSUMPTIONS:',
    '- The code exists and is reachable ONLY through me via tool calls.',
    '- You have NO internet, NO enterprise search, NO web search, NO built-in plugins.',
    '- NEVER say you cannot access files. Emit a tool call and I will get the result.',
    '- NEVER ask me to paste or upload code. Emit a read or grep tool call instead.',
    '- You can make MULTIPLE tool calls in one response when they are independent.',
    '  Put each JSON object on its own line (no array wrapper, no text between them):',
    '  {"type":"tool_call","name":"grep","id":"g1","input":{"pattern":"meeting","include":"*.py"}}',
    '  {"type":"tool_call","name":"glob","id":"g2","input":{"pattern":"**/*notes*"}}',
    '- If calls depend on each other, do them one at a time. Wait for my result before continuing.',
    ...(manifestPath
      ? [
          '',
          `PROJECT MANIFEST: A guide for this codebase exists at ${manifestPath}.`,
          'It is NOT loaded automatically. It documents this application\'s architecture, conventions, and file layout. If you need project context before editing, read it first with a read tool call.',
        ]
      : []),
    '',
    `Workspace: ${workspaceRoot}`,
  ].join('\n')
}

/**
 * Format tool definitions using the curated Copilot manifest.
 */
function toolsBlock(options: LanguageModelV3CallOptions, workspaceRoot: string, dropTask = false): string {
  if (!options.tools?.length || options.toolChoice?.type === "none") return ""
  // Subagents must never be told about the `task` tool: advertising it lets
  // Copilot emit a task tool-call and spawn another subagent (runaway tabs).
  const tools = dropTask
    ? (options.tools as Array<{ name?: string }>).filter((t) => t.name !== "task")
    : options.tools
  return formatCopilotTools(tools as Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>, workspaceRoot)
}

/**
 * Strip Copilot-injected footer text ("Generate the response in language...").
 * This footer is appended to every response by the Copilot backend.
 */
function stripCopilotFooter(raw: string): string {
  const idx = raw.indexOf("\nGenerate the re")
  if (idx > 0) return raw.slice(0, idx).trimEnd()
  const idx2 = raw.indexOf("\n\nGenerate the re")
  if (idx2 > 0) return raw.slice(0, idx2).trimEnd()
  return raw
}

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

function getToolNames(options: LanguageModelV3CallOptions): string[] {
  if (!options.tools) return []
  return options.tools
    .filter((t): t is typeof t & { type: "function" } => t.type === "function")
    .map((t) => t.name)
    .sort()
}

/**
 * INVESTIGATION-ONLY (compaction rollover, step 1). Dumps the full shape of the
 * incoming model prompt so we can see how opencode's compaction boundary renders
 * into the AI-SDK messages the provider actually receives. We are hunting for a
 * durable, detectable signal that "a compaction just happened" — candidates:
 *   (a) the summary text appearing as the leading user/assistant message,
 *   (b) any part-level or message-level metadata (e.g. compaction_continue),
 *   (c) a sudden prompt-length shrink vs. session.messagesSent.
 * Gated behind CDP_COMPACT_DIAG=1 so it stays silent unless we're capturing.
 * DELETE THIS once the detection signal is confirmed.
 */
function dumpCompactionDiag(tag: string, options: LanguageModelV3CallOptions, extra: Record<string, unknown> = {}): void {
  if (process.env["CDP_COMPACT_DIAG"] !== "1") return
  const snip = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s)
  const lines: string[] = []
  lines.push(`\n──── CDP_COMPACT_DIAG [${tag}] promptLen=${options.prompt.length} ${JSON.stringify(extra)} ────`)
  options.prompt.forEach((msg, i) => {
    const m = msg as unknown as Record<string, any>
    const topKeys = Object.keys(m).filter((k) => k !== "content")
    const meta = m["metadata"] ?? m["providerOptions"] ?? m["providerMetadata"]
    lines.push(`  [${i}] role=${m["role"]} keys=${topKeys.join(",")}${meta ? ` meta=${snip(JSON.stringify(meta), 300)}` : ""}`)
    const content = m["content"]
    if (typeof content === "string") {
      lines.push(`       content(str): ${snip(content)}`)
    } else if (Array.isArray(content)) {
      content.forEach((part: Record<string, any>, j: number) => {
        const pKeys = Object.keys(part)
        const pMeta = part["metadata"] ?? part["providerOptions"] ?? part["providerMetadata"]
        const detail =
          part["type"] === "text"
            ? `text: ${snip(String(part["text"] ?? ""))}`
            : `keys=${pKeys.join(",")}`
        lines.push(`       part[${j}] type=${part["type"]} ${detail}${pMeta ? ` meta=${snip(JSON.stringify(pMeta), 200)}` : ""}`)
      })
    }
  })
  lines.push(`──── /CDP_COMPACT_DIAG [${tag}] ────`)
  dlog(lines.join("\n"))
}

/**
 * Distinctive phrases from opencode's built-in SUBAGENT system prompts. The
 * opencode system prompt is carried in options.prompt (even though cdp-web
 * replaces it with its own Copilot preamble), so we can detect the agent here.
 * When one of these is present, this turn is serving a subagent. Subagents must
 * never spawn further subagents, so we neither advertise nor honor `task` for
 * them. Extend this list if you add custom subagents with their own prompts.
 */
const SUBAGENT_PROMPT_SIGNATURES = [
  "You are a file search specialist", // explore
]

/**
 * Distinctive phrase from the title-generator agent's system prompt. When this
 * is present in options.prompt, the turn is a title request, not a coding turn.
 * We detect it here (provider-only) so we can send a lean, self-contained title
 * prompt instead of the full coding-agent preamble + tool manifest, and so the
 * ACTUAL conversation text is forwarded (formatInitialMessage would otherwise
 * grab only the "Generate a title for this conversation:" stub and stop).
 */
const TITLE_PROMPT_SIGNATURE = "You are a title generator"

function isTitleTurn(systemContent: string): boolean {
  return systemContent.includes(TITLE_PROMPT_SIGNATURE)
}

/**
 * Distinctive phrases from opencode's COMPACTION (summarizer) agent system
 * prompt. A /compact turn (and auto-overflow) runs this agent, which inherits
 * the active chat model and therefore lands on THIS Copilot tab. Detecting it
 * lets us (1) PIN the bound tab instead of rebinding on the changed fingerprint
 * and (2) send the summarizer instruction as a plain delta rather than the
 * coding-agent preamble. Detection signal locked from the 2026-08-07 capture.
 * See docs/cdp-web-unify-and-compact.md Part 0.
 */
const COMPACTION_PROMPT_SIGNATURES = [
  "You are an anchored context summarization assistant",
  "Summarize only the conversation history you are given",
]

function isCompactionTurn(systemContent: string): boolean {
  return COMPACTION_PROMPT_SIGNATURES.some((sig) => systemContent.includes(sig))
}

/**
 * Decide whether a doGenerate/doStream turn is serving a subagent. Two signals:
 *  1. Temporary/burner sessions: this repo routes every cdp-web subagent
 *     (explore) to the "-temp" model id, while the primary agent uses the
 *     tracked non-temp id. So temporary === subagent under the current config.
 *  2. Subagent prompt signature: defense in depth if a subagent is ever pointed
 *     at the tracked model id.
 * Erring toward "true" is safe: a false positive only costs the main agent the
 * convenience of launching a subagent, while a false negative reintroduces the
 * runaway subagent-spawns-subagent recursion this guards against.
 */
function isSubagentTurn(_temporary: boolean, systemContent: string): boolean {
  // IMPORTANT: `temporary` is NOT a reliable subagent signal here. Per the
  // product rule in CLAUDE.md ("All chats must be TEMPORARY"), the PRIMARY agent
  // also runs on a "-temp" model id, so `temporary === true` for it too. Keying
  // off it stripped/blocked `task` for the primary agent and broke its ability
  // to launch subagents at all. The reliable signal is the subagent's own
  // system-prompt signature (e.g. explore's "You are a file search specialist"),
  // which rides along in options.prompt and never matches the primary agent.
  return SUBAGENT_PROMPT_SIGNATURES.some((sig) => systemContent.includes(sig))
}

/**
 * Copilot model names selectable in the mode switcher, in the order we look for
 * them inside a model id. The FIRST match wins, so more specific names must come
 * before any that are substrings of another (none currently are). These map 1:1
 * to EFFORT_LABELS keys in driver-dom.ts.
 */
const MODEL_EFFORTS = ["opus", "sonnet"] as const

/**
 * Resolve which Copilot model/effort to select in the switcher for a given model
 * id. The model id is the primary signal (per-model selection): `cdp-web/sonnet`
 * -> "sonnet", `cdp-web/opus-dom` -> "opus". This mirrors how `-temp`/`-dom` are
 * already parsed from the id. Falls back to the provider-level `configEffort`
 * (opencode.jsonc options) when the id names no known model, preserving the old
 * provider-wide behavior for ids like `cdp-web/opus-temp` that don't need it and
 * for any custom effort value (auto/quick/think).
 */
function resolveEffort(modelId: string, configEffort: string): string {
  const id = modelId.toLowerCase()
  for (const name of MODEL_EFFORTS) {
    if (id.includes(name)) return name
  }
  return configEffort
}

/**
 * MIME types that should be attached as files (Copilot parses them natively)
 * rather than inlined as text in the prompt.
 */
const ATTACHMENT_MIMES = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  // PDFs
  "application/pdf",
  // Microsoft Office
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
])

/**
 * Check if a MIME type should be treated as a Copilot-native attachment.
 */
function isAttachmentMime(mediaType: string): boolean {
  if (ATTACHMENT_MIMES.has(mediaType)) return true
  // Catch-all for any image type
  if (mediaType.startsWith("image/")) return true
  return false
}

function mimeToExtension(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/msword": ".doc",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.ms-powerpoint": ".ppt",
  }
  return map[mediaType] || ".bin"
}

/**
 * Map file extensions back to MIME types (reverse of mimeToExtension).
 */
function extensionToMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
  }
  return map[ext] || "application/octet-stream"
}

/**
 * Extract file parts from user messages that should be attached via Copilot.
 * Handles both V3 format (type: "file") and legacy V2 format (type: "image").
 */
function extractAttachments(prompt: LanguageModelV3CallOptions["prompt"], fromIndex = 0): Array<{ data: string | Uint8Array | URL; mediaType: string; filename?: string }> {
  const attachments: Array<{ data: string | Uint8Array | URL; mediaType: string; filename?: string }> = []
  for (let i = fromIndex; i < prompt.length; i++) {
    const msg = prompt[i]
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<Record<string, any>>) {
      // V3 format: type "file" with mediaType
      if (part.type === "file" && part.mediaType && isAttachmentMime(part.mediaType)) {
        attachments.push({
          data: part.data,
          mediaType: part.mediaType,
          filename: part.filename,
        })
      }
      // Legacy V2 format: type "image" with image data (base64 or URL)
      if (part.type === "image") {
        const imageData = part.image // Could be Uint8Array, base64 string, or URL
        const mime = part.mimeType || "image/png"
        attachments.push({
          data: imageData,
          mediaType: mime,
          filename: part.filename || "image.png",
        })
      }
    }
  }
  return attachments
}

/** Regex to strip attachment reference placeholders like [PDF 1], [Image 1], etc. */
const ATTACHMENT_REF_RE = /\[(PDF|Image|File|Document|Audio|Video)\s+\d+\]\s*/gi

function stripAttachmentRefs(text: string): string {
  return text.replace(ATTACHMENT_REF_RE, "").trim()
}


/**
 * Build a lean, self-contained message for a title-generation turn. Unlike
 * formatInitialMessage this sends NO coding-agent preamble, NO tool manifest,
 * and NO project-manifest pointer. It also pulls the REAL conversation text out
 * of the prompt (skipping system rules and the "Generate a title..." stub) so
 * Copilot actually sees what it is supposed to title.
 */
function formatTitleMessage(options: LanguageModelV3CallOptions): string {
  const convo: string[] = []
  for (const msg of options.prompt) {
    if (msg.role === "system") continue
    const text = Array.isArray(msg.content)
      ? (msg.content as Array<Record<string, any>>)
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : String(msg.content)
    const cleaned = stripAttachmentRefs(text).trim()
    if (!cleaned) continue
    if (cleaned.startsWith("Generate a title for this conversation")) continue
    convo.push(cleaned)
  }
  const body = convo.join("\n").slice(0, 4000)

  return [
    "Generate a short title for a conversation that starts with the prompt below.",
    "Keep it under 10 words. Output only the title, nothing else.",
    "",
    "<prompt>",
    body,
    "</prompt>",
  ].join("\n")
}

/**
 * Build the delta message for a COMPACTION turn. Unlike formatInitialMessage
 * this sends NO coding-agent preamble and NO tool manifest — the Copilot tab
 * already holds the full conversation server-side, so we send ONLY the
 * summarizer instruction as a normal follow-up (delta). Copilot then summarizes
 * what it already has in context; we never re-upload history, so there is no
 * 128K input-limit risk. The instruction text is pulled verbatim from the
 * user message(s) in options.prompt (the real summarizer prompt opencode built).
 */
const SUMMARIZER_INSTRUCTION_SIGNATURE = "Create a new anchored summary from the conversation history"

function formatCompactionMessage(options: LanguageModelV3CallOptions): string {
  // Collect user-message texts in order.
  const userTexts: string[] = []
  for (const msg of options.prompt) {
    if (msg.role !== "user") continue
    const text = Array.isArray(msg.content)
      ? (msg.content as Array<Record<string, any>>)
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : String(msg.content)
    const cleaned = stripAttachmentRefs(text).trim()
    if (cleaned) userTexts.push(cleaned)
  }
  // Send ONLY the summarizer instruction (the last user message carrying the
  // anchored-summary directive). The pinned Copilot tab already holds the full
  // conversation server-side, so re-injecting earlier user turns (e.g. the
  // original "What is the time right now?") both duplicates context and, on a
  // long conversation, risks the 128K input limit the pin is meant to avoid.
  for (let i = userTexts.length - 1; i >= 0; i--) {
    if (userTexts[i].includes(SUMMARIZER_INSTRUCTION_SIGNATURE)) return userTexts[i]
  }
  // Fallback: no message matched the signature — use just the last user message
  // rather than concatenating the whole history.
  return userTexts.length ? userTexts[userTexts.length - 1] : ""
}

function formatInitialMessage(options: LanguageModelV3CallOptions, dropTask = false): string {
  const systemText = extractSystem(options.prompt)
  const workspaceRoot = extractWorkspaceRoot(systemText)
  const manifestPath = findManifestFile(workspaceRoot)
  const preamble = copilotPreamble(workspaceRoot, manifestPath)
  const tools = toolsBlock(options, workspaceRoot, dropTask)
  const sections: string[] = [preamble]

  if (tools) sections.push(tools)

  // Add the user's actual task message
  for (const msg of options.prompt) {
    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : String(msg.content)
      const cleaned = stripAttachmentRefs(text)
      if (cleaned) sections.push(`# Task\n${cleaned}`)
      break
    }
  }

  return sections.join("\n\n")
}

/** Max chars for a single delta message sent to Copilot (leaves headroom from 128K limit) */
const DELTA_CHAR_BUDGET = 100_000
/** Max chars for a single tool result before truncation */
const SINGLE_RESULT_MAX = 80_000

function truncateResult(text: string, max: number): string {
  if (text.length <= max) return text
  const truncated = text.slice(0, max)
  const totalLines = text.split("\n").length
  const keptLines = truncated.split("\n").length
  return (
    truncated +
    `\n\n[TRUNCATED — showing ${keptLines} of ${totalLines} lines (${max} of ${text.length} chars). ` +
    `Use offset/limit params on read, or narrow your grep pattern to get specific sections.]`
  )
}

function formatDeltaMessages(prompt: LanguageModelV3CallOptions["prompt"], startIndex: number): string {
  const parts: string[] = []
  let totalChars = 0

  for (let i = startIndex; i < prompt.length; i++) {
    const msg = prompt[i]
    if (msg.role === "system" || msg.role === "assistant") continue

    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : String(msg.content)
      if (text) {
        parts.push(text)
        totalChars += text.length
      }
    }

    if (msg.role === "tool") {
      const rawResults = Array.isArray(msg.content)
        ? (
            msg.content as Array<{
              type: string
              toolCallId?: string
              toolName?: string
              output?: { type: string; value: unknown } | unknown
              isError?: boolean
            }>
          ).map((p) => {
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
        : []

      if (rawResults.length > 0) {
        const remaining = DELTA_CHAR_BUDGET - totalChars
        const perResultBudget = Math.min(SINGLE_RESULT_MAX, Math.floor(remaining / rawResults.length))
        const truncatedResults = rawResults.map((r) => truncateResult(r, Math.max(perResultBudget, 2000)))
        const block = `[Tool Results]\n${truncatedResults.join("\n\n")}`
        parts.push(block)
        totalChars += block.length
      }
    }
  }

  return parts.join("\n\n")
}

export class CDPWebLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "cdp-web"
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportsStructuredOutputs = false
  readonly supportsImageUrls = false
  readonly supportedUrls = {} as const

  private readonly config: CDPWebModelConfig
  /**
   * Effective temporary/persistent mode for THIS model instance. Driven purely
   * by the model id: a "-temp" suffix means temporary (disposable) chats; any
   * other id means persistent (recoverable) chats. Lets the user keep two model
   * ids (e.g. "opus" and "opus-temp") and flip between them with /model.
   */
  private readonly temporary: boolean
  /**
   * Per-opencode-session state map. Since core caches one CDPWebLanguageModel
   * instance per model id, and the primary + explore subagent can share the same
   * id (e.g. opus-temp), each opencode session needs its own tab/conversation
   * binding. Keyed by opencode sessionID.
   */
  private sessions = new Map<string, { session: SessionState; fingerprint: string }>()

  /**
   * Set by waitForAuth the moment it detects login is required, and consumed by
   * doStream to surface an on-screen "login required" notice in the opencode
   * chat. This is how the user learns to go sign in — otherwise the turn just
   * appears to hang while waitForAuth silently polls. Cleared once emitted.
   */
  private authNoticePending = false
  private authNoticeText =
    "🔐 **Login required.** M365 Copilot needs you to sign in.\n\n" +
    "A browser window is open (or opening) — complete the Microsoft/Okta sign-in and MFA there. " +
    "I'll detect it automatically and continue this turn once you're signed in (waiting up to 5 minutes)."

  // ─── Cross-layer hooks (injected by session/llm.ts, mirrors GitLab model) ───
  /** The opencode SessionID this model is serving, if known. */
  sessionID?: string
  /**
   * Load a previously-persisted Copilot conversation ref for this opencode
   * session (from Session.Info.metadata). Returns null if none stored yet.
   */
  loadConversationRef?: () => Promise<{ id: string | null; title: string | null } | null>
  /**
   * Persist the Copilot conversation ref (GUID + title) onto this opencode
   * session's metadata so it survives an opencode restart.
   */
  saveConversationRef?: (ref: { id: string; title: string | null }) => Promise<void>
  /**
   * Load previously-persisted cumulative token totals for this opencode session.
   * Copilot keeps conversation history server-side, so on resume a fresh
   * SessionState would otherwise restart the counter at 0 and under-report the
   * true context size. Returns null if none stored yet.
   */
  loadTokenTotals?: () => Promise<{ input: number; output: number } | null>
  /**
   * Persist the cumulative token totals onto this opencode session's metadata so
   * the context-size estimate survives an opencode restart / conversation resume.
   */
  saveTokenTotals?: (totals: { input: number; output: number }) => Promise<void>

  constructor(modelId: string, config: CDPWebModelConfig) {
    this.modelId = modelId
    this.config = config
    // Mode is driven entirely by the model id: "-temp" suffix => temporary,
    // any other id => persistent. No provider-level default.
    this.temporary = modelId.includes("-temp")
  }

  private metadata(): SharedV3ProviderMetadata {
    return { "cdp-web": {} as JSONObject }
  }

  /**
   * Release and destroy the Copilot tab bound to the given opencode session.
   * Called by llm.ts when a session (especially a subagent) ends so the tab
   * doesn't linger indefinitely. Safe to call multiple times or with unknown ids.
   */
  async releaseSessionForSid(sid: string): Promise<void> {
    const entry = this.sessions.get(sid)
    if (!entry) return
    this.sessions.delete(sid)
    dlog(`[cdp-web] releaseSessionForSid: destroying session for sid=${sid} (conv=${entry.session.conversationId ?? "(none)"})`)
    await destroySession(entry.session.id)
  }

  /**
   * Ensure this opencode session (identified by `sid`) has a bound Copilot tab.
   * Each opencode session gets its own entry in the per-session map, so the
   * primary and explore subagent can run concurrently without stomping state.
   */
  private async ensureBoundSession(sid: string, fingerprint: string, isCompaction = false): Promise<SessionState> {
    // If we already have a bound session for this sid with matching fingerprint, reuse it
    const existing = this.sessions.get(sid)
    if (existing && existing.session.systemFingerprint === fingerprint && existing.session.authenticated) {
      acquireSession(existing.session)
      return existing.session
    }

    // COMPACTION PIN (load-bearing): a /compact turn carries a DIFFERENT system
    // prompt (the summarizer) and NO tools, so its fingerprint never matches the
    // coding turns. Rebinding here would move to a fresh tab that never saw the
    // conversation, so Copilot would greet instead of summarize. Reuse the
    // existing authenticated tab for this sid and IGNORE the fingerprint change
    // — the history we need to summarize lives on that exact tab. Do NOT update
    // systemFingerprint, so the next (coding) turn rebinds/deltas normally.
    if (isCompaction && existing && existing.session.authenticated && existing.session.client) {
      dlog(`[cdp-web] compaction turn: pinning bound tab for sid=${sid} (conv ${existing.session.conversationId ?? "(none)"}), ignoring fingerprint change`)
      acquireSession(existing.session)
      return existing.session
    }

    if (existing) dlog(`[cdp-web] rebinding sid=${sid}: fingerprint changed or session not authenticated, was on conv ${existing.session.conversationId ?? "(none)"}`)
    const prevConvId = existing?.session.conversationId ?? null
    const port = await ensureBrowser({ port: this.config.port, headless: this.config.headless, browser: this.config.browser, profileDir: this.config.profileDir, profileDirectory: this.config.profileDirectory })

    // First, try to find an existing Copilot tab that's already open
    // (e.g., the one opened by the browser launch itself)
    const session = createSession(fingerprint, this.temporary)
    const existingTab = await this.findUsableTab(port, sid, prevConvId)

    if (existingTab) {
      session.targetId = existingTab.id
      acquireSession(session)
      const wsUrl = existingTab.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
      await connectSession(session, wsUrl)
    } else {
      // No usable existing tab — open a genuinely NEW tab. Never hijack a tab
      // another live session claims. Prefer the reliable browser-level
      // Target.createTarget path; fall back to /json/new. Whatever we get, it
      // must NOT be in the live claimed-target set before we drive it.
      dlog("[cdp-web] no usable existing tab — creating a new one")
      const claimedNow = await claimedTargetIds()
      let tab = await createTabViaCDP(port, "https://m365.cloud.microsoft/chat")
      if (!tab || !tab.webSocketDebuggerUrl || claimedNow.has(tab.id)) {
        dlog(`[cdp-web] createTabViaCDP unusable (got=${tab?.id ?? "null"} claimed=${tab ? claimedNow.has(tab.id) : false}) — trying openCopilotTab`)
        tab = await openCopilotTab(port)
      }
      if (!tab || !tab.webSocketDebuggerUrl || claimedNow.has(tab.id)) {
        throw new CDPError(
          "cdp-web: could not open a new Copilot tab, and the only available tabs are in use by other sessions. " +
            "Open a new Copilot tab in the browser and resend.",
        )
      }
      dlog(`[cdp-web] opened new tab id=${tab.id}`)
      session.targetId = tab.id
      acquireSession(session)
      await new Promise((r) => setTimeout(r, 3000))
      const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
      await connectSession(session, wsUrl)
    }

    // Now wait for authentication to complete
    await this.waitForAuth(session)

    // Enable WebSocket capture for the WS path (non-dom model IDs)
    if (!this.modelId.includes("-dom") && session.client) {
      await enableWsCapture(session.client)
    }

    // Token-counter resume: seed the cumulative totals from persisted metadata
    // so the context-size estimate continues climbing instead of restarting at
    // 0 for this reopened conversation. Only meaningful for a freshly-created
    // SessionState (totals still 0); never clobber an in-flight counter.
    // Part A: runs for BOTH temp and tracked now — temp is "tracked but hidden",
    // so its context estimate must survive a restart just like tracked.
    if (session.cumulativeInputTokens === 0 && session.cumulativeOutputTokens === 0 && this.loadTokenTotals) {
      try {
        const totals = await this.loadTokenTotals()
        if (totals) {
          session.cumulativeInputTokens = totals.input
          session.cumulativeOutputTokens = totals.output
          dlog(`[cdp-web] resumed token totals: in=${totals.input} out=${totals.output}`)
        }
      } catch (e) {
        dlog("[cdp-web] loadTokenTotals failed:", (e as Error).message)
      }
    }

    // Conversation resume: if this opencode session previously stored a Copilot
    // conversation GUID, seed it so init reopens that chat instead of starting a
    // fresh one. This is the /session restart recovery path.
    // Part A: runs for BOTH modes now. A temp chat DOES have a real GUID and can
    // be reopened ("invisible but recoverable"); reopening promotes it to the
    // navbar, which is acceptable per the product rule (visibility on recovery).
    if (!session.conversationId && this.loadConversationRef) {
      try {
        const ref = await this.loadConversationRef(); dlog(`[cdp-web] loadConversationRef for ${sid} returned id=${ref?.id ?? "(null)"}`)
        if (ref?.id) {
          session.conversationId = ref.id
          session.conversationTitle = ref.title
          dlog(`[cdp-web] resumed stored conversation: id=${ref.id} title="${ref.title}"`)
        }
      } catch (e) {
        dlog("[cdp-web] loadConversationRef failed:", (e as Error).message)
      }
    }

    // Claim this tab by its CDP targetId in the cross-process registry. This
    // runs for BOTH temporary and persistent sessions and works even before a
    // conversation GUID exists — it's what stops another opencode process from
    // stealing the temp tab we're about to drive.
    if (session.targetId) {
      // Pass temporary so the claim gets a lastTouched stamp and the idle TTL.
      await writeTargetClaim(session.targetId, sid, session.temporary).catch((e) =>
        dlog("[cdp-web] writeTargetClaim failed:", (e as Error).message),
      )
    }

    this.sessions.set(sid, { session, fingerprint })
    return session
  }

  /**
   * Extract the Copilot conversation GUID from a tab URL, or null for a blank/
   * new-chat tab (which carries no conversation GUID and is always stealable).
   */
  private tabGuid(url: string | undefined): string | null {
    const m = (url || "").match(/\/chat\/conversation\/([0-9a-fA-F-]{36})/)
    return m ? m[1] : null
  }

  /**
   * Find an existing Copilot chat tab that is not in use by anyone.
   *
   * "Not in use" means: not claimed by another session in THIS process
   * (isTargetClaimed) AND not claimed by a live OTHER opencode process
   * (cross-process pid-keyed claim registry). A tab with no conversation GUID
   * (blank/new chat) is always stealable. This is the inverted match the user
   * asked for: "is there a tab that ISN'T on anyone's claimed list?"
   */
  private async findUsableTab(port: number, sid?: string, ownConversationId?: string | null) {
    const tabs = await findCopilotTabs(port)
    const claimedGuidSet = await claimedGuids(sid)
    const claimedTargetSet = await claimedTargetIds(sid)
    for (const tab of tabs) {
      // In-process guard (this process's own sessions).
      if (isTargetClaimed(tab.id)) continue
      // Cross-process tab-id guard: another live opencode process is driving
      // this exact tab (works for temp tabs that have no conversation GUID).
      if (claimedTargetSet.has(tab.id)) continue
      const guid = this.tabGuid(tab.url)
      // Cross-process GUID guard: another live process owns this conversation.
      // Blank tab (no guid) => stealable. Our own guid => fine to reuse.
      if (guid && claimedGuidSet.has(guid) && guid !== ownConversationId) continue
      return tab
    }
    return null
  }

  /**
   * Find any page target (for login redirect scenarios).
   */
  private async findAnyPageTab(port: number) {
    const targets = await listTargets(port)
    return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null
  }

  /**
   * Wait for the user to complete authentication.
   * Polls the tab until the composer appears, with a generous timeout.
   * Logs a message so the user knows we're waiting.
   */
  private async waitForAuth(session: SessionState): Promise<void> {
    const client = session.client
    if (!client) throw new CDPError("Session has no connected client")

    // Quick check — maybe we're already authenticated
    const ready = await checkAuth(client)
    if (ready) {
      session.authenticated = true
      return
    }

    // ─── AUTH GATE ───────────────────────────────────────────────────────────
    // Login/reauth is ALWAYS handled in a visible browser, regardless of the
    // headless config setting. If we are running headless, the steady-state
    // browser cannot show the Microsoft/Okta login, so surface it now: bring up
    // a headed window on the SAME profile so the user can complete sign-in, then
    // resume. (The headed-handoff swap is performed by ensureHeadedForAuth; in a
    // headed steady-state it is a no-op and we just poll the visible tab.)
    await this.ensureHeadedForAuth(session)

    // Signal doStream to surface an on-screen notice so the user knows to go
    // sign in (the turn would otherwise appear to hang silently here).
    this.authNoticePending = true

    // Prominent banner so the user understands WHY the turn paused. This goes to
    // the provider log; the in-chat notice is emitted by doStream (Layer 2).
    dlog(
      "════════════════════════════════════════════════════════════\n" +
        "  LOGIN REQUIRED — M365 Copilot needs you to sign in.\n" +
        "  A browser window is open. Complete the Microsoft/Okta login\n" +
        "  (and MFA) there. This turn will continue automatically once\n" +
        "  you are signed in. Waiting up to 5 minutes...\n" +
        "════════════════════════════════════════════════════════════",
    )

    // Wait for the user to log in. Give them up to 5 minutes to complete login.
    const authTimeout = 300_000
    const deadline = Date.now() + authTimeout
    const pollInterval = 2000
    const port = this.config.port
    let reconnectLogged = false
    // The login flow is a NAVIGATION STORM: the tab redirects chat -> AAD ->
    // Okta -> back. Each cross-origin navigation destroys the page's CDP target
    // and kills the WebSocket we were attached to, so the client we started with
    // is almost always dead by the time the user is mid-login. Therefore every
    // iteration must (1) ensure a LIVE client by reconnecting to whatever page
    // target currently exists (findAnyPageTab sees the login.microsoftonline.com
    // tab, which the chat-only findCopilotTabs filter does not), and (2) swallow
    // per-poll errors so a transient "Not connected" during a redirect means
    // "still logging in, keep waiting" rather than killing the turn.
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollInterval))
      try {
        // Ensure we have a live client. If ours is missing or its socket has
        // dropped (navigation), reconnect to the current page target.
        let c = session.client
        if (!c || !c.isConnected()) {
          if (!reconnectLogged) {
            dlog("[cdp-web] auth gate: client not connected (login navigation), reconnecting to live tab")
            reconnectLogged = true
          }
          if (c) {
            await c.disconnect().catch(() => {})
          }
          session.client = null
          const tab = await this.findAnyPageTab(port)
          if (!tab || !tab.webSocketDebuggerUrl) {
            // No page target right now (mid-navigation teardown). Try next tick.
            continue
          }
          session.targetId = tab.id
          const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
          await connectSession(session, wsUrl)
          c = session.client
          reconnectLogged = false
        }
        if (!c) continue

        // If the mid-session reauth popup is still visible on this (now-visible)
        // tab, auto-click Continue so the user only needs to complete the
        // Microsoft login/MFA, not hunt for the button. Safe every tick: once
        // clicked the tab navigates to login and the popup disappears.
        try {
          const rp = await checkReauth(c)
          if (rp.reauth && rp.hasContinue) {
            dlog("[cdp-web] auth gate: reauth popup on live tab, clicking Continue")
            await clickReauthContinue(c)
            await new Promise((r) => setTimeout(r, 1000))
            continue
          }
        } catch {}

        const authed = await checkAuth(c)
        if (authed) {
          // Auth looks good on the main tab — but if a login POPUP window is
          // still open, the token hasn't actually refreshed yet (the popup
          // opened when Continue was clicked; it closes itself after the user
          // finishes login+MFA). Gate on that popup being gone.
          const targets = await listTargets(port)
          const loginPopup = targets.find(t =>
            t.type === "page" &&
            ((t.url || "").includes("login.microsoftonline.com") || (t.url || "").includes("login.live.com"))
          )
          if (loginPopup) {
            dlog(`[cdp-web] auth gate: checkAuth passed but login popup still open (${loginPopup.url?.slice(0, 80)}) — waiting for it to close`)
            continue
          }
          // Settle: give the main page a moment to receive the token callback
          // from the just-closed popup before we resume the turn.
          await new Promise((r) => setTimeout(r, 2000))
          // Re-verify after settle (token callback may not have landed yet)
          const stillAuthed = await checkAuth(c).catch(() => false)
          if (!stillAuthed) {
            dlog("[cdp-web] auth gate: popup closed but checkAuth failed after settle — continuing to poll")
            continue
          }
          session.authenticated = true
          dlog("[cdp-web] auth gate cleared — user is signed in (popup closed, token refreshed).")
          // If we swapped headed just for login, return to headless steady-state.
          await this.restoreHeadlessAfterAuth(session).catch((e) =>
            dlog("[cdp-web] restoreHeadlessAfterAuth failed (continuing):", (e as Error).message),
          )
          dlog("[cdp-web] resuming turn after reauth.")
          return
        }
      } catch (e) {
        // Transient failure during the login navigation storm (dropped socket,
        // stale execution context, tab swap). Drop the client so the next tick
        // reconnects, and keep waiting — this is expected, not fatal.
        dlog("[cdp-web] auth gate poll error (expected during login nav, retrying):", (e as Error).message)
        const dead = session.client
        session.client = null
        if (dead) await dead.disconnect().catch(() => {})
      }
    }

    session.authenticated = false
    throw new CopilotReauthRequired()
  }

  /**
   * Ensure a VISIBLE browser is available for the login/reauth flow.
   *
   * Auth must always be headed. When the steady-state browser is already headed
   * (the default today), this is a no-op — the login page is already visible in
   * the session's tab and we just poll it.
   *
   * When running headless (config headless=true), the login cannot be shown in
   * the invisible browser. Layer 2 will implement the serialized swap here:
   *   quit headless → launch headed on the SAME profile → user logs in →
   *   quit headed → relaunch headless → resume.
   * Until that lands, we fail loudly rather than stranding the user behind an
   * invisible login wall.
   */
  private async ensureHeadedForAuth(session: SessionState): Promise<void> {
    const forceSwap = this.config.forceAuthSwap === true
    // Steady-state headed and not force-testing: login is already visible,
    // nothing to swap.
    if (!this.config.headless && !forceSwap) return

    // ─── LAYER 2: headless → headed swap for login ───────────────────────────
    // Two Chromium processes cannot share one --user-data-dir, so we cannot run
    // a headed login window alongside the headless working browser. Serialize:
    // close headless (release the profile lock), relaunch HEADED on the same
    // profile+port, then rebind this session to a fresh visible tab. waitForAuth
    // then polls that visible tab while the user signs in. restoreHeadlessAfter-
    // Auth() reverses this once auth clears.
    const port = this.config.port
    const runningHeadless = getLaunchedHeadless(port)
    // Normally, if the browser is already headed there is nothing to swap — just
    // rebind. But with forceAuthSwap we deliberately run the FULL close/relaunch/
    // rebind cycle even when already headed, to exercise and harden the swap path.
    if (runningHeadless === false && !forceSwap) {
      dlog("[cdp-web] ensureHeadedForAuth: browser already headed — rebinding only")
      await this.rebindToFreshTab(session, port)
      return
    }

    dlog(
      forceSwap
        ? "[cdp-web] ensureHeadedForAuth: forceAuthSwap — running full close/relaunch/rebind cycle (headed)"
        : "[cdp-web] ensureHeadedForAuth: closing headless browser to swap headed for login",
    )
    // Drop our dead client handle first; the browser is about to go away.
    if (session.client) {
      await session.client.disconnect().catch(() => {})
      session.client = null
    }
    const closed = await closeBrowser(port)
    if (!closed) {
      dlog("[cdp-web] ensureHeadedForAuth: closeBrowser timed out — profile may be locked; aborting swap")
      throw new CopilotReauthRequired()
    }

    // Relaunch HEADED on the same profile + port. ensureBrowser reuses the same
    // getProfileDir(browser) mapping, so the persisted session/cookies are intact.
    dlog("[cdp-web] ensureHeadedForAuth: relaunching headed for login")
    await ensureBrowser({ port, headless: false, browser: this.config.browser, profileDir: this.config.profileDir, profileDirectory: this.config.profileDirectory })
    await this.rebindToFreshTab(session, port)
  }

  /**
   * After auth clears, return to the configured steady-state mode. If we are
   * supposed to run headless but are currently headed (because we swapped for
   * login), close the headed browser and relaunch headless, then rebind. No-op
   * when steady-state is headed or already in the right mode.
   */
  private async restoreHeadlessAfterAuth(session: SessionState): Promise<void> {
    if (!this.config.headless) return
    const port = this.config.port
    if (getLaunchedHeadless(port) === true) return // already headless

    dlog("[cdp-web] restoreHeadlessAfterAuth: auth done — swapping back to headless")
    if (session.client) {
      await session.client.disconnect().catch(() => {})
      session.client = null
    }
    const closed = await closeBrowser(port)
    if (!closed) {
      dlog("[cdp-web] restoreHeadlessAfterAuth: closeBrowser timed out; staying headed for this turn")
      // Non-fatal: we can still serve the turn headed. Rebind and continue.
      await ensureBrowser({ port, headless: false, browser: this.config.browser, profileDir: this.config.profileDir, profileDirectory: this.config.profileDirectory })
      await this.rebindToFreshTab(session, port)
      return
    }
    await ensureBrowser({ port, headless: true, browser: this.config.browser, profileDir: this.config.profileDir, profileDirectory: this.config.profileDirectory })
    await this.rebindToFreshTab(session, port)
    // The relaunched headless browser is cold. Wait for it to load and prove it
    // is authenticated BEFORE returning, so the resumed doGenerate's immediate
    // pre-send checkAuth does not see a still-loading page and re-trigger the
    // whole auth swap (the two-window cascade).
    await this.waitForReady(session)
  }

  /**
   * Rebind a session onto a fresh usable tab on `port` after a browser swap.
   * Clears the stale client/target, finds or creates a tab, and connects. The
   * conversationId is preserved so the post-auth init path can reopen the same
   * Copilot conversation (persistent chats).
   */
  private async rebindToFreshTab(session: SessionState, port: number, sid?: string): Promise<void> {
    session.client = null
    session.targetId = null
    session.initialized = false // force re-init (reopen conversation) after swap

    let tab = await this.findUsableTab(port, sid, session.conversationId ?? undefined)
    if (!tab) {
      const created = await createTabViaCDP(port, "https://m365.cloud.microsoft/chat")
      tab = created ?? (await openCopilotTab(port))
    }
    if (!tab || !tab.webSocketDebuggerUrl) {
      throw new CDPError("cdp-web: could not acquire a tab after browser swap")
    }
    session.targetId = tab.id
    const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
    await connectSession(session, wsUrl)
    if (session.targetId && sid) {
      await writeTargetClaim(session.targetId, sid, session.temporary).catch(() => {})
    }
  }

  /**
   * After a browser relaunch/rebind, the new tab is COLD — it just launched,
   * navigated to /chat, and has not finished loading or applying the persisted
   * session cookies yet. Checking auth immediately (as the resumed doGenerate
   * does) sees a not-yet-ready page and wrongly declares a reauth, causing an
   * endless swap cascade. This polls checkAuth for up to timeoutMs so the cold
   * browser has time to settle and prove it is actually signed in before we hand
   * the session back. Returns true once ready, false on timeout.
   */
  private async waitForReady(session: SessionState, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const c = session.client
      if (c && c.isConnected()) {
        try {
          if (await checkAuth(c)) {
            session.authenticated = true
            dlog("[cdp-web] waitForReady: relaunched browser is ready and authenticated")
            return true
          }
        } catch {
          // page mid-load; keep polling
        }
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    dlog("[cdp-web] waitForReady: relaunched browser did not become ready within timeout")
    return false
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
    // Snapshot sessionID immediately — core mutates this.sessionID before each
    // call (llm.ts:228), so a concurrent subagent turn can overwrite it while
    // we're mid-await. The local `sid` stays stable for this entire turn.
    const sid = this.sessionID ?? `anon-${Date.now()}`
    const systemContent = extractSystem(options.prompt)
    const toolNames = getToolNames(options)
    const fingerprint = computeFingerprint(systemContent, toolNames)
    // INVESTIGATION (compaction rollover step 1): capture the prompt shape for
    // every turn so a /compact run reveals how the compaction boundary appears
    // to the provider. Also log the prior session's messagesSent (if this sid is
    // already bound) so we can see the prompt-length-shrink signal. Silent unless
    // CDP_COMPACT_DIAG=1. Remove once detection signal is confirmed.
    dumpCompactionDiag("doGenerate:in", options, {
      sid,
      priorMessagesSent: this.sessions.get(sid)?.session.messagesSent ?? null,
      priorConvId: this.sessions.get(sid)?.session.conversationId ?? null,
    })
    // Subagent turns (e.g. explore) must not advertise or execute the `task`
    // tool — otherwise a subagent can spawn another subagent, opening a runaway
    // cascade of Copilot tabs. Detected purely inside the provider.
    const isSubagent = isSubagentTurn(this.temporary, systemContent)
    // A /compact (or auto-overflow) turn runs the summarizer agent, which
    // inherits the active model and lands on THIS Copilot tab. It must PIN the
    // already-bound tab (the fingerprint changed, but the history to summarize
    // lives there) and send the summarizer as a plain delta. See Part 0 of
    // docs/cdp-web-unify-and-compact.md.
    const isCompaction = isCompactionTurn(systemContent)

    let session = await this.ensureBoundSession(sid, fingerprint, isCompaction)

    try {
      // This turn is activity: re-stamp the temp claim's idle TTL so an actively
      // used temp chat never ages out mid-conversation. No-op for tracked chats.
      if (session.targetId) {
        await touchTargetClaim(session.targetId).catch(() => {})
      }

      let messageToSend: string
      let isInitial = false
      // Set true when we reopen a pre-existing conversation on resume (used by
      // the resume path below; declared here so the whole method can see it).
      let resumedExisting = false

      if (isCompaction) {
        // Compaction turn: the pinned tab already holds the full conversation
        // server-side. Send ONLY the summarizer instruction as a delta (never a
        // fresh-start preamble), so Copilot summarizes what it already has. Keep
        // isInitial false so the init/openNewChat block is skipped and we do NOT
        // reseed history. If for some reason the tab was never initialized,
        // degrade gracefully rather than greeting (handled below).
        messageToSend = formatCompactionMessage(options)
        isInitial = false
        if (!messageToSend.trim()) {
          dlog("[cdp-web] compaction turn had no summarizer instruction text — falling back to delta")
          messageToSend = formatDeltaMessages(options.prompt, Math.max(0, options.prompt.length - 1))
        }
        dlog("[cdp-web] compaction turn: sending summarizer instruction as delta on pinned tab")
      } else if (!session.initialized || session.messagesSent >= options.prompt.length) {
        messageToSend = isTitleTurn(systemContent)
          ? formatTitleMessage(options)
          : formatInitialMessage(options, isSubagent)
        isInitial = true
      } else {
        messageToSend = formatDeltaMessages(options.prompt, session.messagesSent)
        if (!messageToSend.trim()) {
          const lastMsg = options.prompt[options.prompt.length - 1]
          if (lastMsg.role === "user" || lastMsg.role === "tool") {
            messageToSend = formatDeltaMessages(options.prompt, options.prompt.length - 1)
          } else {
            throw new CDPError("No new message to send to Copilot")
          }
        }
      }

      let client = session.client
      if (!client) throw new CDPError("Session has no connected client")

      // Check auth before proceeding. If auth dropped mid-session (token expiry
      // / Conditional Access), do NOT throw — open the auth gate, let the user
      // sign in via the visible browser, and resume this same turn automatically.
      // IMPORTANT: retry a few times before concluding reauth is needed. Right
      // after a browser relaunch/swap the page can be COLD (still loading, cookies
      // not applied yet); a single failed read here would wrongly re-enter the
      // auth gate and cause the swap cascade. A short retry absorbs that.
      let authed = await checkAuth(client)

      // ─── MID-SESSION REAUTH POPUP GATE ─────────────────────────────────────
      // Copilot can invalidate the session WITHOUT a URL redirect: it leaves the
      // composer mounted+enabled and the URL on /chat, then drops an
      // "Authentication required … Continue" alertdialog over the page (captured
      // 2026-08-10, cdp-auth-captures/reauth-2026-08-10T12-39-17-611Z.json).
      // checkAuth's URL/composer heuristics can miss that overlay, so probe for
      // it explicitly here. If it's up, click Continue to launch Microsoft's
      // re-auth and fall through to the auth gate (waitForAuth), which polls
      // until the user is signed back in and then resumes THIS turn. Note: an
      // embedded login iframe alone is NOT treated as reauth (routine silent SSO
      // uses it) — only the decisive popup blocks the send.
      const reauth = await checkReauth(client)
      if (reauth.reauth) {
        dlog(`[cdp-web] pre-send: mid-session reauth popup detected (continue=${reauth.hasContinue}, loginFrame=${reauth.loginFrame}) — clicking Continue, entering auth gate`)
        if (reauth.hasContinue) {
          await clickReauthContinue(client).catch((e) =>
            dlog("[cdp-web] clickReauthContinue failed (continuing to auth gate):", (e as Error).message),
          )
        }
        // Surface the on-screen "login required" notice via doStream so the turn
        // doesn't appear to hang while waitForAuth polls.
        this.authNoticePending = true
        authed = false
      }

      if (!authed) {
        for (let attempt = 0; attempt < 5 && !authed; attempt++) {
          await new Promise((r) => setTimeout(r, 1500))
          try {
            authed = client.isConnected() ? await checkAuth(client) : false
          } catch {
            authed = false
          }
          if (authed) dlog(`[cdp-web] pre-send auth check passed on retry ${attempt + 1} (page was cold)`)
        }
      }
      if (!authed) {
        dlog("[cdp-web] pre-send auth check failed after retries — entering auth gate")
        await this.waitForAuth(session)
        // waitForAuth may have swapped the client (headed handoff). Re-read it.
        client = session.client
        if (!client) throw new CDPError("Session has no connected client after reauth")
      }

      // Per-turn drift guard: for an established session, verify the tab still
      // shows OUR conversation. If it was stolen, idle-reset to /chat, or
      // navigated elsewhere, force re-init so the reopen block below re-navigates
      // to our GUID (opening/acquiring a fresh tab if ours is gone). Prevents
      // sending this turn into another session's conversation.
      // Part A: runs for BOTH modes now — temp has a GUID to compare against.
      if (!isInitial && session.initialized && session.conversationId) {
        const live = await getConversationInfo(client).catch(() => ({ id: null, title: null, url: "" }))
        const claimedByOther = session.targetId ? (await claimedTargetIds(sid)).has(session.targetId) : false
        if (live.id !== session.conversationId || claimedByOther) {
          dlog(`[cdp-web] drift: tab on ${live.id ?? "(none)"} but we own ${session.conversationId} (claimedByOther=${claimedByOther}) — re-acquiring our own tab`)
          this.sessions.delete(sid)
          session = await this.ensureBoundSession(sid, fingerprint)
          session.initialized = false
          client = session.client
          if (!client) throw new CDPError("Session has no connected client after drift re-acquire")
        }
      }

      // Initialize conversation if needed
      if (isInitial || !session.initialized) {
        dlog("[cdp-web] initializing: opening temp chat + setting effort")
        const hasComposer = await checkComposer(client)
        if (!hasComposer) {
          dlog("[cdp-web] NO COMPOSER FOUND — entering auth gate (likely reauth)")
          await this.waitForAuth(session)
          client = session.client
          if (!client) throw new CDPError("Session has no connected client after reauth")
        }

        // Always open a temporary chat for isolation and to avoid polluting history.
        // This is required even on fresh tabs (0 turns) because a fresh tab is
        // not in "temporary" mode by default.
        // Resume path: we have a stored Copilot GUID for this opencode session
        // (loaded in ensureBoundSession). Reopen that conversation instead of
        // starting a fresh one, so history/context is preserved across restarts.
        let reopened = false
        if (session.conversationId) {
          // Fast path: if we stole the tab already displaying this conversation
          // (findTabByConversationId), we're on the right page already — no nav.
          const cur = await getConversationInfo(client)
          if (cur.id === session.conversationId) {
            dlog(`[cdp-web] resume: tab already on conversation ${session.conversationId} — no nav needed`)
            reopened = true
            resumedExisting = true
          } else {
            dlog(`[cdp-web] resume: reopening conversation ${session.conversationId}`)
            reopened = await reopenConversation(client, {
              id: session.conversationId,
              title: session.conversationTitle,
            })
          }
          if (reopened) {
            await client.send("Runtime.enable", {})
            resumedExisting = true
            // Re-assert our claim now that we're driving this conversation again
            // (our pid changed across the restart, so refresh the registry).
            await writeClaim(session.conversationId, sid).catch((e) =>
              dlog("[cdp-web] writeClaim (resume) failed:", (e as Error).message),
            )
        } else {
          // Reopen failed. Do NOT silently start a fresh chat and replay the
          // original prompt (that resurrects the first message and drops all
          // context — the old fallback bug). Keep the stored GUID so a retry
          // can still re-enter this resume path. First try a manual "force"
          // adopt: if the user has navigated this tab to a real conversation
          // with a live composer, pick up wherever the tab currently is.
          const failedId = session.conversationId
          const cur = await getConversationInfo(client)
          const hasComposerNow = await checkComposer(client)
          if (cur.id && hasComposerNow) {
            dlog(`[cdp-web] resume reopen failed for ${failedId}, but tab is on ${cur.id} — adopting it`)
            session.conversationId = cur.id
            session.conversationTitle = cur.title
            reopened = true
            resumedExisting = true
            await client.send("Runtime.enable", {})
            await writeClaim(cur.id, sid).catch((e) =>
              dlog("[cdp-web] writeClaim (adopt) failed:", (e as Error).message),
            )
            if (this.saveConversationRef) {
              await this.saveConversationRef({ id: cur.id, title: cur.title }).catch((e) =>
                dlog("[cdp-web] saveConversationRef (adopt) failed:", (e as Error).message),
              )
            }
          } else if (session.temporary) {
            // Part A: temp reopen-failure degrade. A temp conversation has a
            // shorter, undocumented Microsoft TTL, so a stored temp GUID can age
            // out. Losing a temp conversation is the historical expectation, so
            // rather than hard-erroring the turn we silently start a FRESH temp
            // chat (the pre-unification temp behavior). Clear the dead ref so the
            // openNewChat path below runs and the GUID is re-captured post-send.
            dlog(`[cdp-web] temp reopen failed for ${failedId} (likely aged out) — degrading to a fresh temp chat`)
            session.conversationId = null
            session.conversationTitle = null
            reopened = false
            resumedExisting = false
          } else {
            throw new CDPError(
              `cdp-web: could not reopen conversation ${failedId}. ` +
                `Open that conversation in the Copilot browser tab this session is driving, then send your message again to reconnect.`,
            )
          }
        }
      }

        if (!reopened) {
          dlog(`[cdp-web] calling openNewChat (temporary=${this.temporary})`)
          await openNewChat(client, this.temporary)
        }
        dlog("[cdp-web] init nav done, waiting for UI settle before setEffort")
        await new Promise((r) => setTimeout(r, 1500))

        // Per-model selection: derive the Copilot model/effort from THIS model's
        // id (e.g. cdp-web/sonnet -> "sonnet"), falling back to the provider-level
        // default. Lets each model id own its switcher target instead of the whole
        // provider sharing one.
        const effort = resolveEffort(this.modelId, this.config.effort)
        dlog("[cdp-web] setting effort:", effort, `(modelId=${this.modelId})`)
        await setEffort(client, effort)

        // Verify effort stuck — Copilot may re-render and reset after navigation
        await new Promise((r) => setTimeout(r, 1000))
        const verifyLabel = await client.evaluate(
          `(document.getElementById('gptModeSwitcher')||{}).innerText||''`,
        ) as string
        const targetLabel = EFFORT_LABELS[effort] ?? effort
        if (verifyLabel && !verifyLabel.toLowerCase().startsWith(targetLabel.toLowerCase())) {
          dlog(`[cdp-web] effort NOT set! Switcher says "${verifyLabel.split("\n")[0]}", retrying...`)
          await new Promise((r) => setTimeout(r, 1000))
          await setEffort(client, effort)
        }

        session.initialized = true
        session.turnCount = 0
        dlog("[cdp-web] init complete")
      }

      // Resume with existing history: if we reopened a pre-existing conversation,
      // the Copilot chat already contains the full preamble/tools/prior turns.
      // Re-sending the initial payload would duplicate all of it, so replace it
      // with just the newest user/tool turn. Mark this as a non-initial turn so
      // the first-turn navigation handling below is skipped.
      if (resumedExisting) {
        const latest = formatDeltaMessages(options.prompt, Math.max(0, options.prompt.length - 1))
        if (latest.trim()) {
          messageToSend = latest
          isInitial = false
          session.turnCount = 1
          dlog("[cdp-web] resume: sending latest turn only, skipping initial preamble")
        }
      }

      // Handle file attachments (images, PDFs, Office docs)
      // These get uploaded via Copilot's native file handler.
      // Only extract from NEW messages to avoid re-uploading on follow-up turns.
      const attachFromIndex = isInitial ? 0 : (session.messagesSent || 0)
      dlog(`[cdp-web] attachment scan: isInitial=${isInitial}, attachFromIndex=${attachFromIndex}, promptLen=${options.prompt.length}, messagesSent=${session.messagesSent}`)
      dlog(`[cdp-web] prompt roles: ${options.prompt.map((m, i) => `${i}:${m.role}`).join(", ")}`)
      const attachments: Array<{ data: string | Uint8Array | URL; mediaType: string; filename?: string }> = [
        ...extractAttachments(options.prompt, attachFromIndex),
      ]
      dlog("[cdp-web] attachments extracted:", attachments.length,
        attachments.map(a => ({ mime: a.mediaType, hasData: !!a.data, dataType: typeof a.data })))
      // Debug: dump user message content types
      for (const msg of options.prompt) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue
        for (const part of msg.content as Array<Record<string, any>>) {
          dlog(`[cdp-web] user part: type=${part.type}, keys=${Object.keys(part).join(",")}`, part.type === "text" ? `text(first100)=${(part.text||'').slice(0,100)}` : "")
        }
      }
      // Debug: log what parts exist BEFORE extractAttachments filters them
      for (const msg of options.prompt) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue
        for (const part of msg.content as Array<Record<string, any>>) {
          if (part.type === "file" || part.type === "image") {
            dlog("[cdp-web] raw part in prompt:", { type: part.type, mediaType: part.mediaType, mimeType: part.mimeType, filename: part.filename })
          }
          if (part.type === "text" && (part.text?.includes("ERROR:") || part.text?.includes("[PDF"))) {
            dlog("[cdp-web] TEXT PART (likely stripped):", part.text.slice(0, 150))
          }
        }
      }
      // Detect file paths in the message text (e.g., pasted "C:\...\file.docx" or file:// URLs)
      // and add them to the attachment list for native upload
      const { paths: detectedPaths, cleaned: cleanedMessage } = extractFilePathsFromText(messageToSend)
      if (detectedPaths.length > 0) {
        const { readFile, stat } = await import("node:fs/promises")
        for (const filePath of detectedPaths) {
          try {
            const fileStat = await stat(filePath)
            if (!fileStat.isFile()) continue
            const ext = path.extname(filePath).toLowerCase()
            const mime = extensionToMime(ext)
            const data = await readFile(filePath)
            attachments.push({ data, mediaType: mime, filename: path.basename(filePath) })
            dlog(`[cdp-web] detected file path in text: ${filePath} (${fileStat.size} bytes, ${mime})`)
          } catch (e) {
            dlog(`[cdp-web] could not read detected file path: ${filePath}`, e)
          }
        }
      }

      if (attachments.length > 0) {
        await this.uploadAttachments(client, attachments)
        // Give Copilot a moment to process the attachments
        await new Promise((r) => setTimeout(r, 2000))
      }

      // Strip attachment refs and file paths from the message
      messageToSend = stripAttachmentRefs(detectedPaths.length > 0 ? cleanedMessage : messageToSend)

      // Count turns BEFORE sending (the response will be the next one)
      const turnsBefore = await getTurnCount(client)
      dlog(`[cdp-web] turnsBefore (pre-send): ${turnsBefore}, isInitial=${isInitial}`)

    // Arm WS capture BEFORE sending. The frame listeners drop any frame that
    // arrives while no handler is installed, so starting capture here (rather
    // than after sendPrompt + the ~seconds of GUID-wait/settle below) closes the
    // first-turn race where a fast Copilot reply — including its type=2 done
    // frame — would finish inside the setup window and be discarded, causing the
    // ~2-minute IDLE_MS hang + DOM fallback. See beginResponseCapture doc.
    const preferWs = !this.modelId.includes("-dom")
    const wsCapture = preferWs ? beginResponseCapture(client, options.abortSignal) : null

    await sendPrompt(client, messageToSend)
    session.messagesSent = options.prompt.length

    // For persistent chats, capture the conversation GUID + title on the first
    // turn. Copilot assigns these shortly after the first message is sent.
    // This GUID is the recovery key used to re-open the chat after a timeout.
    // Part A: runs for BOTH modes now — a temp chat has a real GUID too, and
    // capturing it (a passive read) is what makes temp "invisible but
    // recoverable." Capturing does NOT promote the chat; only a send does.
    if (!session.conversationId) {
        const info = await waitForConversationId(client, 20000)
      if (info.id) {
        session.conversationId = info.id
        session.conversationTitle = info.title
        dlog(`[cdp-web] captured conversation: id=${info.id} title="${info.title}"`)
        // Claim this tab in the cross-process registry so other live opencode
        // instances won't steal it while we're using it.
        await writeClaim(info.id, sid).catch((e) =>
          dlog("[cdp-web] writeClaim failed:", (e as Error).message),
        )
        // Persist onto the opencode session's metadata so it survives a
        // restart — this is what makes /session resume able to reopen it.
        if (this.saveConversationRef) {
          try {
            const existingRef = this.loadConversationRef ? await this.loadConversationRef().catch(() => null) : null; if (existingRef?.id && existingRef.id !== info.id && !resumedExisting) { dlog(`[cdp-web] NOT overwriting stored ref ${existingRef.id} with throwaway ${info.id}`); session.conversationId = existingRef.id; session.conversationTitle = existingRef.title } else { await this.saveConversationRef({ id: info.id, title: info.title }) }
            dlog(`[cdp-web] persisted conversation ref to opencode session ${sid}`)
          } catch (e) {
            dlog("[cdp-web] saveConversationRef failed:", (e as Error).message)
          }
        }
      } else {
        dlog("[cdp-web] no conversation GUID captured yet (may appear next turn)")
      }
    }

      // On the FIRST message in a conversation, Copilot navigates after Send,
      // invalidating the Runtime context. On subsequent messages (tool results),
      // it stays on the same page — no navigation, no context loss.
      if (session.turnCount === 0) {
        await new Promise((r) => setTimeout(r, 800))
        await client.send("Runtime.enable", {})
        await new Promise((r) => setTimeout(r, 500))
      } else {
        // Just a brief wait for the message to be processed
        await new Promise((r) => setTimeout(r, 500))
      }

      let finalText: string
      let gotViaWs = false

      if (preferWs) {
        // WebSocket capture path — SignalR frames have properly escaped JSON.
        // Capture was armed before sendPrompt (wsCapture); just await it here.
        try {
          finalText = await wsCapture!
          gotViaWs = true
          dlog(`[cdp-web ws] response (${finalText.length} chars): ${finalText.slice(0, 200)}`)
        } catch (wsErr) {
          // If WS capture fails (e.g. no Chathub WS detected), fall back to DOM
          dlog(`[cdp-web ws] capture failed, falling back to DOM: ${(wsErr as Error).message}`)
          let responseText: string
          try {
            responseText = await awaitResponse(client, turnsBefore, this.config.timeout, options.abortSignal)
          } catch (err) {
            if (err instanceof CopilotReauthRequired) {
              session.authenticated = false
            }
            throw err
          }
          const raw = await extractResponseRaw(client, turnsBefore)
          finalText = raw || responseText
        }
      } else {
        // DOM polling path — needs repair pipeline
        let responseText: string
        try {
          responseText = await awaitResponse(client, turnsBefore, this.config.timeout, options.abortSignal)
        } catch (err) {
          if (err instanceof CopilotReauthRequired) {
            session.authenticated = false
          }
          throw err
        }
        const raw = await extractResponseRaw(client, turnsBefore)
        finalText = raw || responseText
      }
      session.turnCount++

      // Strip Copilot footer for both paths (DOM parse.ts does it internally)
      if (gotViaWs) finalText = stripCopilotFooter(finalText)

      // Extract any commentary text before tool calls as reasoning
      let thinking: string | undefined
      if (gotViaWs) {
        const firstBrace = finalText.indexOf('{"type":"tool_call"')
        if (firstBrace > 0) {
          const prefix = finalText.slice(0, firstBrace).trim()
          if (prefix) thinking = prefix
        }
      }

      // WS capture has proper JSON escaping → clean parse; DOM needs repair
      const parsed = gotViaWs ? parseResponseClean(finalText, thinking) : parseResponse(finalText)

      // ─── Cumulative token accounting (CDP-Web only) ───
      // Unlike the shim providers, CDP sends only a delta each turn (Copilot
      // keeps history server-side). So we accumulate both sides on the session:
      //   context so far = every message we sent + every response we received.
      // Input: count messageToSend as-sent (initial preamble OR delta).
      // Output: count the RAW finalText, not the parsed payload — tool-call
      //   JSON is plaintext the model generated and is real output tokens.
      // Ephemeral reasoning tokens are intentionally ignored: they are not
      //   capturable and are discarded across turns, so they never accumulate
      //   into the ongoing context window.
      const turnInputTokens = countTokens(messageToSend)
      const turnOutputTokens = countTokens(finalText)
      session.cumulativeInputTokens += turnInputTokens
      session.cumulativeOutputTokens += turnOutputTokens
      dlog(`[cdp-web] tokens turn: in=${turnInputTokens} out=${turnOutputTokens} | cumulative: in=${session.cumulativeInputTokens} out=${session.cumulativeOutputTokens}`)
      // Persist the running totals so a /session resume after restart continues
      // the counter instead of restarting at 0.
      // Part A: runs for BOTH modes now — temp is tracked-but-hidden and its
      // context estimate must survive a restart just like tracked.
      if (this.saveTokenTotals) {
        await this.saveTokenTotals({
          input: session.cumulativeInputTokens,
          output: session.cumulativeOutputTokens,
        }).catch((e) => dlog("[cdp-web] saveTokenTotals failed:", (e as Error).message))
      }

      // Hard block: a subagent turn must never emit a `task` tool-call. Even
      // with task dropped from the advertised tools, Copilot can still emit one
      // (it saw the tool on an earlier turn, or hallucinated it). Filter those
      // out here so the recursion can never reach opencode core.
      const emittedCalls =
        parsed.type === "tool_calls"
          ? parsed.calls.filter((c) => {
              if (isSubagent && c.name === "task") {
                dlog(`[cdp-web] BLOCKED task tool-call from subagent (id=${c.id}) — subagents cannot spawn subagents`)
                return false
              }
              return true
            })
          : []
      const hasToolCalls = emittedCalls.length > 0

      const content: LanguageModelV3Content[] = []

      if (parsed.thinking) content.push({ type: "reasoning", text: parsed.thinking })

      if (hasToolCalls) {
        dlog(`[cdp-web] parsed ${emittedCalls.length} tool call(s): ${emittedCalls.map((c) => `${c.name}(${c.id})`).join(", ")}`)
        for (const call of emittedCalls) {
          dlog(`[cdp-web]   call ${call.name}: input=${call.input.slice(0, 200)}`)
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })
        }
      } else if (parsed.type === "tool_calls") {
        // Every tool-call this turn was blocked (a subagent tried to spawn a
        // subagent). End the turn as a clean stop so core does not wait on tool
        // results that will never arrive.
        content.push({ type: "text", text: "A nested subagent (task) call was blocked; subagents cannot spawn subagents." })
      } else {
        content.push({ type: "text", text: parsed.text })
      }

      // Subagent tab cleanup: when the subagent's final turn completes (no more
      // tool calls → finishReason "stop"), destroy its Copilot tab so it doesn't
      // linger. Primary sessions keep their tab for conversation continuity.
      if (isSubagent && !hasToolCalls) {
        dlog(`[cdp-web] subagent final turn (stop) — scheduling tab cleanup for sid=${sid}`)
        this.releaseSessionForSid(sid).catch((e) =>
          dlog(`[cdp-web] releaseSessionForSid failed: ${(e as Error).message}`),
        )
      }

      return {
        content,
        finishReason: {
          unified: hasToolCalls ? "tool-calls" : "stop",
          raw: hasToolCalls ? "tool_use" : "end_turn",
        },
        usage: {
          inputTokens: {
            total: session.cumulativeInputTokens,
            noCache: session.cumulativeInputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: session.cumulativeOutputTokens,
            text: session.cumulativeOutputTokens,
            reasoning: undefined,
          },
          raw: undefined,
        },
        providerMetadata: this.metadata(),
        request: { body: JSON.stringify({ message: messageToSend.slice(0, 500) + "..." }) },
        response: { timestamp: new Date(), modelId: this.modelId },
        warnings: [],
      }
    } finally {
      releaseSession(session)
    }
  }

  /**
   * Upload all file attachments to Copilot via DOM.setFileInputFiles.
   *
   * Writes binary data to temp files with correct extensions, then passes
   * native Windows paths to the hidden #upload-file-button input.
   * Works for images, PDFs, Office docs — everything the input accepts.
   * Fully parallelizable across tabs (no shared OS clipboard).
   */
  private async uploadAttachments(
    client: CDPClient,
    attachments: Array<{ data: string | Uint8Array | URL; mediaType: string; filename?: string }>,
  ): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const tmpDir = path.join(os.tmpdir(), "opencode-cdp-attachments")
    await mkdir(tmpDir, { recursive: true })

    const filePaths: string[] = []

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i]
      const ext = mimeToExtension(attachment.mediaType)
      // Sanitize filename: strip unsafe chars, ensure clean extension
      const rawName = attachment.filename || `attachment-${i}${ext}`
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60)
      const filename = safeName.endsWith(ext) ? safeName : `${safeName}${ext}`
      const filePath = path.join(tmpDir, `${Date.now()}-${filename}`)

      let buffer: Buffer
      if (attachment.data instanceof Uint8Array) {
        buffer = Buffer.from(attachment.data)
      } else if (typeof attachment.data === "string") {
        const match = attachment.data.match(/^data:[^;]+;base64,(.+)$/)
        buffer = match ? Buffer.from(match[1], "base64") : Buffer.from(attachment.data, "base64")
      } else if (attachment.data instanceof URL) {
        const res = await fetch(attachment.data.href)
        buffer = Buffer.from(await res.arrayBuffer())
      } else {
        continue
      }

      await writeFile(filePath, buffer)
      filePaths.push(filePath)
      // Log first 8 bytes as hex for PNG header validation (should be 89 50 4E 47 0D 0A 1A 0A)
      const header = buffer.slice(0, 8).toString("hex").match(/../g)?.join(" ") ?? ""
      dlog(`[cdp-web] wrote attachment: ${filePath} (${buffer.length} bytes, header: ${header})`)
    }

    if (filePaths.length > 0) {
      dlog(`[cdp-web] uploading ${filePaths.length} files via file input`)
      await attachFiles(client, filePaths)
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>
    request: { body: string }
    response: { headers: Record<string, string> }
  }> {
    // Kick off generation WITHOUT awaiting, so the stream can surface an
    // on-screen "login required" notice while doGenerate is still blocked inside
    // waitForAuth (up to 5 min). We poll authNoticePending and, if it flips,
    // emit the notice as visible text before the real answer streams in.
    this.authNoticePending = false
    const self = this
    const genPromise = this.doGenerate(options)

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] as SharedV3Warning[] })

        // Race the generation against the auth-notice signal. If doGenerate
        // enters the auth gate, authNoticePending flips true and we render the
        // notice on screen immediately, then keep waiting for generation.
        let noticeShown = false
        let done = false
        const result = await new Promise<Awaited<ReturnType<typeof self.doGenerate>>>(
          (resolve, reject) => {
            genPromise.then(
              (r) => { done = true; resolve(r) },
              (e) => { done = true; reject(e) },
            )
            const poll = () => {
              if (done) return
              if (self.authNoticePending && !noticeShown) {
                noticeShown = true
                self.authNoticePending = false
                controller.enqueue({ type: "text-start", id: "auth-notice" })
                controller.enqueue({ type: "text-delta", id: "auth-notice", delta: self.authNoticeText })
                controller.enqueue({ type: "text-end", id: "auth-notice" })
              }
              setTimeout(poll, 500)
            }
            poll()
          },
        )
        const providerMetadata = result.providerMetadata

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
      request: { body: "" },
      response: { headers: {} },
    }
  }
}
