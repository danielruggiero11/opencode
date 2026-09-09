/**
 * sidecar.ts — Non-agentic HTTP front door for the cdp-web Copilot driver.
 *
 * Lumen talks to M365 Copilot two ways: the in-house desktop CDP driver
 * (services/copilot, port 9223) for non-agentic calls, and this cdp-web driver
 * (port 9224) for agentic runs. This sidecar lets the SAME cdp-web browser also
 * serve non-agentic calls, so both use cases share one Chrome / one M365 login.
 *
 * It is a THIN entry point: it owns the browser and wraps the portable driver
 * primitives (browser.ts / client.ts / session.ts / driver.ts). It deliberately
 * does NOT touch the opencode agent runtime, the AI-SDK adapter (model.ts), the
 * tool-call parser, or the cross-process claims registry — those belong to the
 * agentic path. A non-agentic call is just: prompt in, answer text out.
 *
 * Run in dev:  bun run ./src/provider/cdp-web/sidecar.ts [--port 9224] [--http-port 9725]
 * Compiled:    `opencode sidecar [--port 9224] [--http-port 9725]` — the
 *              `cli/cmd/sidecar.ts` subcommand calls runSidecar(). It rides
 *              index.ts's import graph, so `bun build` bundles it into the
 *              shipped opencode binary automatically (no separate entrypoint).
 *
 * HTTP surface (v1):
 *   POST /ask      {prompt, effort?, work_grounding?, temporary?, files?, image_b64?, image_mime?, timeout?} -> {answer}
 *   GET  /health   -> {ok, browser_up, authenticated, engine:"web", port}
 *
 * Contract note: /ask mirrors services/copilot.session.ask() 1:1 so Lumen's
 * _call_copilot can swap desktop<->web behind a per-provider toggle with no
 * shape change. `work_grounding` is accepted for parity but is inherently on:
 * m365.cloud.microsoft/chat is the Work-grounded surface, so True is the native
 * default and False is not separately toggleable on web (documented, not silent).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { writeFile, unlink, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Log } from "@opencode-ai/core/util/log"
import { ensureBrowser, isBrowserRunning, openCopilotTab } from "./browser"
import { createTabViaCDP, listTargets, type CDPTarget } from "./client"
import { CDPClient, CDPError } from "./client"
import {
  checkAuth,
  checkReauth,
  clickReauthContinue,
  openNewChat,
  setEffort,
  sendPrompt,
  getTurnCount,
  awaitResponse,
  extractResponseRaw,
  attachFiles,
  pasteImageAttachment,
  enableWsCapture,
  beginResponseCapture,
  CopilotReauthRequired,
} from "./driver"

const log = Log.create({ service: "cdp-web-sidecar" })

const COPILOT_URL = "https://m365.cloud.microsoft/chat"
const DEFAULT_CDP_PORT = 9224
const DEFAULT_HTTP_PORT = 9725

// ─── runtime config ──────────────────────────────────────────────────────────
// Ports/headless are module-level `let`s so both entry paths can set them before
// the server starts: `bun run sidecar.ts --port …` (reads argv) and the compiled
// `opencode sidecar` subcommand (passes opts to runSidecar). Handlers close over
// these and read them at request time, so assigning them in runSidecar() before
// createServer() is safe.
let CDP_PORT = DEFAULT_CDP_PORT
let HTTP_PORT = DEFAULT_HTTP_PORT
let HEADLESS = false

function argVal(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10)
    if (!Number.isNaN(n)) return n
  }
  return fallback
}

// ─── browser ownership ───────────────────────────────────────────────────────
// The sidecar is the stable browser owner. First-up launches Chrome on the port
// (persistent profile); the agentic provider attaches to it. If Chrome is
// already up (agentic launched first), ensureBrowser attaches instead — either
// order works, one profile / one login.

async function ensureBrowserUp(): Promise<number> {
  const already = await isBrowserRunning(CDP_PORT)
  if (already) {
    log.info(`cdp-web sidecar: attaching to existing browser on CDP port ${CDP_PORT}`)
    return CDP_PORT
  }
  log.info(`cdp-web sidecar: no browser on CDP port ${CDP_PORT} — launching a new one`)
  try {
    return await ensureBrowser({ port: CDP_PORT, headless: HEADLESS })
  } catch (e) {
    throw new CDPError(
      `${(e as Error).message}. If a Chrome window from a previous sidecar is still ` +
      `open, it is holding the profile lock but no longer serving the debug port ` +
      `(closing the sidecar terminal tore it down). Close that Chrome window and retry — ` +
      `or run the sidecar as a persistent background service so it isn't killed with the terminal.`,
    )
  }
}

// ─── warm-tab pool ────────────────────────────────────────────────────────────
// v1 opened+closed a fresh tab per /ask, which churned the browser (closing the
// last tab can tear down the context → the next call reconnects to a dead socket
// and throws "Not connected"), paid the full auth/effort cost every time, and hit
// the first-turn navigation on every call. Instead we keep a small pool of warm
// tabs and REUSE them: each /ask acquires a free slot, opens a FRESH temporary
// chat on that existing tab (no history bleeds between calls), runs its turn, and
// releases the slot with the tab still open. A slot is destroyed only if its turn
// actually errors (poisoned tab), never on the happy path.

interface AskRequest {
  prompt: string
  effort?: string
  work_grounding?: boolean
  temporary?: boolean
  files?: string[]
  image_b64?: string
  image_mime?: string
  timeout?: number
}

interface Slot {
  id: number
  client: CDPClient | null
  targetId: string
  wsUrl: string
  busy: boolean
  wsCaptureEnabled: boolean
}

const MAX_SLOTS = 4
const pool: Slot[] = []
let nextSlotId = 0

async function openTab(port: number): Promise<CDPTarget> {
  let tab = await createTabViaCDP(port, COPILOT_URL)
  if (!tab || !tab.webSocketDebuggerUrl) {
    tab = await openCopilotTab(port)
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new CDPError("cdp-web sidecar: could not open a Copilot tab")
  }
  return tab
}

/** Acquire a free warm slot, or open a new tab (up to MAX_SLOTS), else wait. */
async function acquireSlot(port: number): Promise<Slot> {
  while (true) {
    const free = pool.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return free
    }
    if (pool.length < MAX_SLOTS) {
      const tab = await openTab(port)
      const slot: Slot = {
        id: ++nextSlotId,
        client: null,
        targetId: tab.id,
        wsUrl: tab.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1"),
        busy: true,
        wsCaptureEnabled: false,
      }
      pool.push(slot)
      // Give a brand-new tab a beat to load before the first CDP call.
      await new Promise((r) => setTimeout(r, 1500))
      return slot
    }
    // All busy and at cap — wait briefly and retry.
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Ensure the slot's CDP client is live, reconnecting a dropped socket. */
async function ensureSlotClient(slot: Slot): Promise<CDPClient> {
  if (slot.client?.isConnected()) return slot.client
  if (slot.client) await slot.client.disconnect().catch(() => {})
  slot.client = await connectClient(slot.wsUrl)
  slot.wsCaptureEnabled = false // a fresh client needs capture re-armed
  return slot.client
}

function releaseSlot(slot: Slot): void {
  slot.busy = false
}

/**
 * Recover a slot after its turn errored WITHOUT closing its tab.
 *
 * Load-bearing for auth: closing a tab (and especially the last tab) makes Chrome
 * drop or fully exit, which loses the M365 session cookies → a forced re-login on
 * the next call. The whole point of the warm pool is that once the user signs in,
 * the tab (and its auth) stays alive. So on error we drop the CDP client and let
 * ensureSlotClient reconnect to the SAME tab next time; openNewChat resets the
 * conversation. The tab is never closed here.
 */
async function resetSlot(slot: Slot): Promise<void> {
  if (slot.client) await slot.client.disconnect().catch(() => {})
  slot.client = null
  slot.wsCaptureEnabled = false
  slot.busy = false
}

/** Connect a fresh CDP client to a wsUrl with the core domains enabled. */
async function connectClient(wsUrl: string): Promise<CDPClient> {
  const client = new CDPClient(wsUrl)
  await client.connect()
  await client.send("Runtime.enable")
  await client.send("DOM.enable")
  await client.send("Page.enable")
  return client
}

/**
 * Ensure the slot's tab is authenticated, AUTO-CONTINUING through the login like
 * the agentic driver does — so the user only completes the Microsoft/Okta sign-in
 * and the same call finishes (no tool retry, no lost turn).
 *
 * Two things make this "smart" vs the old naive poll:
 *  1. Auto-click the reauth "Continue" popup so the user goes straight to login.
 *  2. Reconnect through the login NAVIGATION STORM. Each cross-origin redirect
 *     (chat → AAD → Okta → back) destroys the page's CDP target and kills our
 *     socket, so every tick re-attaches to whatever page target currently exists
 *     (findAnyPageTab sees the login.microsoftonline.com tab that the chat-only
 *     filter would miss) and swallows transient per-poll errors.
 *
 * On success, slot.client is a LIVE authenticated client (possibly reconnected to
 * a new target), and slot.targetId/wsUrl point at it.
 */
async function waitForAuth(slot: Slot): Promise<void> {
  if (slot.client && (await checkAuth(slot.client).catch(() => false))) return

  log.warn(
    "cdp-web sidecar: LOGIN REQUIRED — a browser window is open; complete the " +
    "M365/Okta sign-in. This call continues automatically once you're signed in. " +
    "Waiting up to 5 minutes.",
  )
  try { await slot.client?.send("Page.bringToFront", {}) } catch { /* best effort */ }

  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      // Ensure a LIVE client — login navigation frequently kills the socket.
      let c = slot.client
      if (!c || !c.isConnected()) {
        if (c) await c.disconnect().catch(() => {})
        slot.client = null
        const targets = await listTargets(CDP_PORT)
        const tab = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
        if (!tab || !tab.webSocketDebuggerUrl) continue // mid-navigation teardown
        slot.targetId = tab.id
        slot.wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
        slot.wsCaptureEnabled = false
        c = await connectClient(slot.wsUrl)
        slot.client = c
      }

      // Auto-click the reauth "Continue" so the user only does the MS login/MFA.
      try {
        const rp = await checkReauth(c)
        if (rp.reauth && rp.hasContinue) {
          await clickReauthContinue(c)
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }
      } catch { /* popup check is best-effort */ }

      if (await checkAuth(c)) return
    } catch {
      // transient during login navigation — keep waiting
    }
  }
  throw new CopilotReauthRequired()
}

/** Write image_b64 to a temp file so it rides the same attachFiles path as files. */
async function stageImage(image_b64: string, image_mime: string): Promise<string> {
  const ext = image_mime.includes("jpeg") || image_mime.includes("jpg") ? "jpg"
    : image_mime.includes("webp") ? "webp"
    : image_mime.includes("gif") ? "gif" : "png"
  const dir = await mkdtemp(path.join(tmpdir(), "cdp-web-img-"))
  const file = path.join(dir, `paste.${ext}`)
  await writeFile(file, Buffer.from(image_b64, "base64"))
  return file
}

/**
 * Run ONE turn on a slot's tab.
 *   initial=true  → open a fresh chat + set effort (first turn of a /ask or a
 *                   session's /session/start).
 *   initial=false → send into the SAME conversation as a delta (/session/reply).
 * Copilot keeps history server-side per tab, so a reply just sends + captures.
 */
async function runTurn(slot: Slot, req: AskRequest, initial: boolean): Promise<string> {
  const timeout = req.timeout || 180
  await ensureSlotClient(slot)
  // Auth may reconnect the client to a different target (login navigation), so
  // read slot.client AFTER waiting rather than before.
  await waitForAuth(slot)
  const client = slot.client!
  if (!slot.wsCaptureEnabled) {
    await enableWsCapture(client)
    slot.wsCaptureEnabled = true
  }

  if (initial) {
    // Fresh chat on this (possibly reused) tab — no history from a prior call
    // bleeds in. Effort is set once, at conversation start.
    await openNewChat(client, req.temporary !== false)
    await new Promise((r) => setTimeout(r, 1500))
    await setEffort(client, req.effort || "auto")
    await new Promise((r) => setTimeout(r, 800))
  }

  const tmpImages: string[] = []
  try {
    // Attachments: explicit file paths + an optional inline image (staged to disk
    // so both take the native DOM.setFileInputFiles path).
    const files = [...(req.files || [])]
    if (req.image_b64) {
      const staged = await stageImage(req.image_b64, req.image_mime || "image/png")
      tmpImages.push(staged)
      files.push(staged)
    }
    if (files.length) {
      await attachFiles(client, files)
      await new Promise((r) => setTimeout(r, 2000))
    }

    const turnsBefore = await getTurnCount(client)
    const wsCapture = beginResponseCapture(client)
    await sendPrompt(client, req.prompt)

    // The first send in a conversation navigates and invalidates the Runtime
    // context — re-enable it before we read anything back. (Harmless on replies.)
    await new Promise((r) => setTimeout(r, 800))
    await client.send("Runtime.enable", {})
    await new Promise((r) => setTimeout(r, 500))

    try {
      return await wsCapture
    } catch (wsErr) {
      log.error("cdp-web sidecar: WS capture failed, DOM fallback: " + (wsErr as Error).message)
      const text = await awaitResponse(client, turnsBefore, timeout)
      const raw = await extractResponseRaw(client, turnsBefore)
      return raw || text
    }
  } finally {
    for (const f of tmpImages) {
      await unlink(f).catch(() => {})
      await unlink(path.dirname(f)).catch(() => {})
    }
  }
}

/** One-shot: acquire a warm slot, run a single initial turn, release it. */
async function ask(req: AskRequest): Promise<string> {
  const port = await ensureBrowserUp()
  const slot = await acquireSlot(port)
  let ok = false
  try {
    const answer = await runTurn(slot, req, true)
    ok = true
    return answer
  } finally {
    // Either way the tab stays OPEN (auth persists). Happy path: release it warm.
    // Error path: reset (reconnect fresh next time) but never close the tab.
    if (ok) releaseSlot(slot)
    else await resetSlot(slot)
  }
}

// ─── multi-turn sessions (parity with services/copilot/sessions.py) ───────────
// A session pins its own warm slot across turns (never returned to the free pool
// until it ends), so a conversation stays on ONE tab. Mirrors the desktop
// sessions API used by internal_search --conversational — except concurrent
// (each session its own tab) instead of single-flight.

interface WSession {
  id: string
  slot: Slot
  lastUsed: number
}
const wsessions = new Map<string, WSession>()
let nextSessionId = 0
const SESSION_IDLE_MS = 600_000 // end a session after 10 min idle

async function startSession(req: AskRequest): Promise<{ session_id: string; answer: string }> {
  const port = await ensureBrowserUp()
  const slot = await acquireSlot(port) // stays busy for the session's whole life
  let answer: string
  try {
    answer = await runTurn(slot, req, true)
  } catch (e) {
    await resetSlot(slot) // keep the tab (and its auth) — never close it
    throw e
  }
  const id = `ws-${++nextSessionId}`
  wsessions.set(id, { id, slot, lastUsed: Date.now() })
  return { session_id: id, answer }
}

async function replySession(id: string, req: AskRequest): Promise<{ session_id: string; answer: string }> {
  const s = wsessions.get(id)
  if (!s) throw new CDPError(`cdp-web sidecar: unknown session ${id}`)
  s.lastUsed = Date.now()
  let answer: string
  try {
    answer = await runTurn(s.slot, req, false)
  } catch (e) {
    // A poisoned session tab can't recover its conversation — end it.
    await endSession(id)
    throw e
  }
  s.lastUsed = Date.now()
  return { session_id: id, answer }
}

async function endSession(id: string): Promise<void> {
  const s = wsessions.get(id)
  if (!s) return
  wsessions.delete(id)
  // Return the tab to the warm pool for reuse — do NOT close it (closing would
  // drop the shared browser's auth). The next call opens a fresh chat on it.
  await resetSlot(s.slot)
}

// Reap idle sessions so a dropped client doesn't leak a tab forever.
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of wsessions) {
    if (now - s.lastUsed > SESSION_IDLE_MS) {
      log.info(`cdp-web sidecar: reaping idle session ${id}`)
      void endSession(id)
    }
  }
}, 60_000).unref?.()

// ─── HTTP server ─────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

async function handleHealth(res: ServerResponse): Promise<void> {
  // NON-launching: /health must never open Chrome. The browser is lazy — it
  // launches on the first real /ask or /session/start, not on a status poll.
  // So we only report whether Chrome is ALREADY up, and probe auth only if so.
  let authenticated = false
  let browserUp = false
  try {
    browserUp = await isBrowserRunning(CDP_PORT)
    if (browserUp) {
      // Probe auth on an existing free slot only; don't open a new tab here.
      const free = pool.find((s) => !s.busy)
      if (free) {
        free.busy = true
        try {
          const client = await ensureSlotClient(free)
          authenticated = await checkAuth(client)
        } finally {
          releaseSlot(free)
        }
      }
    }
  } catch (e) {
    log.error("cdp-web sidecar: health probe failed: " + (e as Error).message)
  }
  send(res, 200, {
    ok: true,
    browser_up: browserUp,
    authenticated,
    engine: "web",
    port: CDP_PORT,
    pool: pool.length,
    sessions: wsessions.size,
  })
}

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AskRequest
  try {
    body = JSON.parse(await readBody(req)) as AskRequest
  } catch {
    return send(res, 400, { error: "invalid JSON body" })
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return send(res, 400, { error: "prompt is required" })
  }
  try {
    const answer = await ask(body)
    send(res, 200, { answer })
  } catch (e) {
    const reauth = e instanceof CopilotReauthRequired
    log.error("cdp-web sidecar: /ask failed: " + (e as Error).message)
    send(res, reauth ? 503 : 500, { error: (e as Error).message, reauth })
  }
}

async function handleSessionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AskRequest
  try {
    body = JSON.parse(await readBody(req)) as AskRequest
  } catch {
    return send(res, 400, { error: "invalid JSON body" })
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return send(res, 400, { error: "prompt is required" })
  }
  try {
    send(res, 200, await startSession(body))
  } catch (e) {
    const reauth = e instanceof CopilotReauthRequired
    log.error("cdp-web sidecar: /session/start failed: " + (e as Error).message)
    send(res, reauth ? 503 : 500, { error: (e as Error).message, reauth })
  }
}

async function handleSessionReply(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AskRequest & { session_id?: string }
  try {
    body = JSON.parse(await readBody(req)) as AskRequest & { session_id?: string }
  } catch {
    return send(res, 400, { error: "invalid JSON body" })
  }
  if (!body.session_id) return send(res, 400, { error: "session_id is required" })
  if (!body.prompt || typeof body.prompt !== "string") {
    return send(res, 400, { error: "prompt is required" })
  }
  try {
    send(res, 200, await replySession(body.session_id, body))
  } catch (e) {
    log.error("cdp-web sidecar: /session/reply failed: " + (e as Error).message)
    send(res, 500, { error: (e as Error).message })
  }
}

async function handleSessionEnd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { session_id?: string }
  try {
    body = JSON.parse(await readBody(req)) as { session_id?: string }
  } catch {
    return send(res, 400, { error: "invalid JSON body" })
  }
  if (!body.session_id) return send(res, 400, { error: "session_id is required" })
  await endSession(body.session_id).catch(() => {})
  send(res, 200, { ok: true })
}

export interface SidecarOptions {
  cdpPort?: number
  httpPort?: number
  headless?: boolean
}

/**
 * Start the sidecar HTTP server. Both entry paths call this:
 *   - `bun run sidecar.ts …` via the `import.meta.main` block below (argv → opts)
 *   - the compiled `opencode sidecar` subcommand (cli/cmd/sidecar.ts) with opts
 *
 * Kept dependency-free of the opencode runtime: it only imports the portable
 * driver primitives, inits its own logger, and owns its own process signals.
 */
export function runSidecar(opts: SidecarOptions = {}): void {
  CDP_PORT = opts.cdpPort ?? argVal("--port", DEFAULT_CDP_PORT)
  HTTP_PORT = opts.httpPort ?? argVal("--http-port", DEFAULT_HTTP_PORT)
  HEADLESS = opts.headless ?? process.argv.includes("--headless")

  // print:true → logs go to stderr so an operator can see attach-vs-launch, auth
  // waits, and per-turn progress. Guarded: when invoked as the `opencode sidecar`
  // subcommand the CLI runtime has already initialised logging, and a second
  // Log.init would throw.
  try {
    Log.init({ print: true })
  } catch {
    /* already initialised by the host CLI runtime */
  }

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {})
    const url = (req.url || "").split("?")[0]
    if (req.method === "GET" && url === "/health") return void handleHealth(res)
    if (req.method === "POST" && url === "/ask") return void handleAsk(req, res)
    if (req.method === "POST" && url === "/session/start") return void handleSessionStart(req, res)
    if (req.method === "POST" && url === "/session/reply") return void handleSessionReply(req, res)
    if (req.method === "POST" && url === "/session/end") return void handleSessionEnd(req, res)
    send(res, 404, { error: "not found" })
  })

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        `cdp-web sidecar: port ${HTTP_PORT} is already in use — another sidecar is ` +
        `probably still running. Stop it first (or pass --http-port <n>).`,
      )
    } else {
      log.error("cdp-web sidecar: server error: " + err.message)
    }
    process.exit(1)
  })

  server.listen(HTTP_PORT, "127.0.0.1", () => {
    // Lazy browser: do NOT launch Chrome here. The server is cheap to keep alive;
    // the browser opens only on the first /ask or /session/start (and the user
    // authenticates then). This lets Lumen supervise the sidecar process without
    // popping Chrome on Lumen startup.
    log.info(`cdp-web sidecar listening on http://127.0.0.1:${HTTP_PORT} (CDP port ${CDP_PORT}, headless=${HEADLESS}); browser is lazy`)
  })

  process.on("SIGINT", () => { server.close(); process.exit(0) })
  process.on("SIGTERM", () => { server.close(); process.exit(0) })
}

// Direct execution: `bun run ./src/provider/cdp-web/sidecar.ts [--port …] [--http-port …]`
if (import.meta.main) runSidecar()
