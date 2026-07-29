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
import { countTokens } from "../shim/tokenizer"
import {
  createSession,
  acquireSession,
  releaseSession,
  connectSession,
  computeFingerprint,
  isTargetClaimed,
  type SessionState,
} from "./session"
import {
  checkAuth,
  checkComposer,
  openNewChat,
  setEffort,
  sendPrompt,
  getTurnCount,
  awaitResponse,
  extractResponseRaw,
  attachFiles,
  CopilotReauthRequired,
} from "./driver"
import { extractFilePathsFromText } from "./extract-paths"
import { CDPClient, CDPError, findCopilotTabs, listTargets } from "./client"
import { ensureBrowser, openCopilotTab } from "./browser"
import path from "path"
import os from "os"
import { formatCopilotTools } from "./tool-manifest"

interface CDPWebModelConfig {
  port: number
  effort: string
  timeout: number
}

/**
 * Extract the workspace root from the system prompt ("Working directory: ...").
 */
function extractWorkspaceRoot(systemText: string): string {
  const match = systemText.match(/Working directory:\s*(.+)/)
  return match?.[1]?.trim() || process.cwd()
}

/**
 * Build the Copilot system preamble — replaces the generic opencode system prompt.
 */
function copilotPreamble(workspaceRoot: string): string {
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
    '',
    `Workspace: ${workspaceRoot}`,
  ].join('\n')
}

/**
 * Format tool definitions using the curated Copilot manifest.
 */
function toolsBlock(options: LanguageModelV3CallOptions, workspaceRoot: string): string {
  if (!options.tools?.length || options.toolChoice?.type === "none") return ""
  return formatCopilotTools(options.tools as Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>, workspaceRoot)
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


function formatInitialMessage(options: LanguageModelV3CallOptions): string {
  const systemText = extractSystem(options.prompt)
  const workspaceRoot = extractWorkspaceRoot(systemText)
  const preamble = copilotPreamble(workspaceRoot)
  const tools = toolsBlock(options, workspaceRoot)
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
  /** This instance's bound session — provides conversation affinity */
  private boundSession: SessionState | null = null

  constructor(modelId: string, config: CDPWebModelConfig) {
    this.modelId = modelId
    this.config = config
  }

  private metadata(): SharedV3ProviderMetadata {
    return { "cdp-web": {} as JSONObject }
  }

  /**
   * Ensure this instance has a bound session. Each CDPWebLanguageModel instance
   * owns exactly one browser tab/conversation for its lifetime, providing
   * session affinity so concurrent opencode sessions never cross-contaminate.
   *
   * If the fingerprint changes (system prompt or tools changed), the old
   * session is abandoned and a new tab is opened.
   */
  private async ensureBoundSession(fingerprint: string): Promise<SessionState> {
    // If we already have a bound session with matching fingerprint, reuse it
    if (this.boundSession && this.boundSession.systemFingerprint === fingerprint && this.boundSession.authenticated) {
      acquireSession(this.boundSession)
      return this.boundSession
    }

    const port = await ensureBrowser({ port: this.config.port })

    // First, try to find an existing Copilot tab that's already open
    // (e.g., the one opened by the browser launch itself)
    const session = createSession(fingerprint)
    const existingTab = await this.findUsableTab(port)

    if (existingTab) {
      session.targetId = existingTab.id
      acquireSession(session)
      const wsUrl = existingTab.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
      await connectSession(session, wsUrl)
    } else {
      // No existing Copilot tab — try to create one
      const tab = await openCopilotTab(port)
      if (!tab || !tab.webSocketDebuggerUrl) {
        // Even /json/new failed — try connecting to whatever page target exists
        // (the browser may have a login page open that will redirect to chat)
        const fallback = await this.findAnyPageTab(port)
        if (!fallback) {
          throw new CDPError("No browser tabs available. Is the browser running?")
        }
        session.targetId = fallback.id
        acquireSession(session)
        const wsUrl = fallback.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
        await connectSession(session, wsUrl)
      } else {
        session.targetId = tab.id
        acquireSession(session)
        await new Promise((r) => setTimeout(r, 3000))
        const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
        await connectSession(session, wsUrl)
      }
    }

    // Now wait for authentication to complete
    await this.waitForAuth(session)

    this.boundSession = session
    return session
  }

  /**
   * Find an existing Copilot chat tab that isn't already claimed by another session.
   */
  private async findUsableTab(port: number) {
    const tabs = await findCopilotTabs(port)
    for (const tab of tabs) {
      if (!isTargetClaimed(tab.id)) return tab
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
    if (ready) return

    // Not authenticated — wait for the user to log in
    // Give them up to 5 minutes to complete login
    const authTimeout = 300_000
    const deadline = Date.now() + authTimeout
    const pollInterval = 2000

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollInterval))
      const authed = await checkAuth(client)
      if (authed) return
    }

    session.authenticated = false
    throw new CopilotReauthRequired()
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

    const session = await this.ensureBoundSession(fingerprint)

    try {
      let messageToSend: string
      let isInitial = false

      if (!session.initialized || session.messagesSent >= options.prompt.length) {
        messageToSend = formatInitialMessage(options)
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

      const client = session.client
      if (!client) throw new CDPError("Session has no connected client")

      // Check auth before proceeding
      const authed = await checkAuth(client)
      if (!authed) {
        session.authenticated = false
        throw new CopilotReauthRequired()
      }

      // Initialize conversation if needed
      if (isInitial || !session.initialized) {
        console.error("[cdp-web] initializing: opening temp chat + setting effort")
        const hasComposer = await checkComposer(client)
        if (!hasComposer) {
          console.error("[cdp-web] NO COMPOSER FOUND — reauth required")
          session.authenticated = false
          throw new CopilotReauthRequired()
        }

        // Always open a temporary chat for isolation and to avoid polluting history.
        // This is required even on fresh tabs (0 turns) because a fresh tab is
        // not in "temporary" mode by default.
        console.error("[cdp-web] calling openNewChat (temp chat)")
        await openNewChat(client)
        console.error("[cdp-web] openNewChat done, setting effort:", this.config.effort)

        await setEffort(client, this.config.effort)
        session.initialized = true
        session.turnCount = 0
        console.error("[cdp-web] init complete")
      }

      // Handle file attachments (images, PDFs, Office docs)
      // These get uploaded via Copilot's native file handler.
      // Only extract from NEW messages to avoid re-uploading on follow-up turns.
      const attachFromIndex = isInitial ? 0 : (session.messagesSent || 0)
      console.error(`[cdp-web] attachment scan: isInitial=${isInitial}, attachFromIndex=${attachFromIndex}, promptLen=${options.prompt.length}, messagesSent=${session.messagesSent}`)
      console.error(`[cdp-web] prompt roles: ${options.prompt.map((m, i) => `${i}:${m.role}`).join(", ")}`)
      const attachments: Array<{ data: string | Uint8Array | URL; mediaType: string; filename?: string }> = [
        ...extractAttachments(options.prompt, attachFromIndex),
      ]
      console.error("[cdp-web] attachments extracted:", attachments.length,
        attachments.map(a => ({ mime: a.mediaType, hasData: !!a.data, dataType: typeof a.data })))
      // Debug: dump user message content types
      for (const msg of options.prompt) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue
        for (const part of msg.content as Array<Record<string, any>>) {
          console.error(`[cdp-web] user part: type=${part.type}, keys=${Object.keys(part).join(",")}`, part.type === "text" ? `text(first100)=${(part.text||'').slice(0,100)}` : "")
        }
      }
      // Debug: log what parts exist BEFORE extractAttachments filters them
      for (const msg of options.prompt) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue
        for (const part of msg.content as Array<Record<string, any>>) {
          if (part.type === "file" || part.type === "image") {
            console.error("[cdp-web] raw part in prompt:", { type: part.type, mediaType: part.mediaType, mimeType: part.mimeType, filename: part.filename })
          }
          if (part.type === "text" && (part.text?.includes("ERROR:") || part.text?.includes("[PDF"))) {
            console.error("[cdp-web] TEXT PART (likely stripped):", part.text.slice(0, 150))
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
            console.error(`[cdp-web] detected file path in text: ${filePath} (${fileStat.size} bytes, ${mime})`)
          } catch (e) {
            console.error(`[cdp-web] could not read detected file path: ${filePath}`, e)
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
      console.error(`[cdp-web] turnsBefore (pre-send): ${turnsBefore}, isInitial=${isInitial}`)

      await sendPrompt(client, messageToSend)
      session.messagesSent = options.prompt.length

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
      const finalText = raw || responseText
      session.turnCount++

      const parsed = parseResponse(finalText)
      const inputTokens = countTokens(messageToSend)
      const content: LanguageModelV3Content[] = []
      let outputTokens = 0

      if (parsed.thinking) content.push({ type: "reasoning", text: parsed.thinking })

      if (parsed.type === "tool_calls") {
        console.error(`[cdp-web] parsed ${parsed.calls.length} tool call(s): ${parsed.calls.map((c) => `${c.name}(${c.id})`).join(", ")}`)
        outputTokens = countTokens(parsed.calls.map((c) => c.input).join(""))
        for (const call of parsed.calls) {
          console.error(`[cdp-web]   call ${call.name}: input=${call.input.slice(0, 200)}`)
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
      console.error(`[cdp-web] wrote attachment: ${filePath} (${buffer.length} bytes, header: ${header})`)
    }

    if (filePaths.length > 0) {
      console.error(`[cdp-web] uploading ${filePaths.length} files via file input`)
      await attachFiles(client, filePaths)
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>
    request: { body: string }
    response: { headers: Record<string, string> }
  }> {
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
