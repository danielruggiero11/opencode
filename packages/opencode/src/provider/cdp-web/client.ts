/**
 * Low-level Chrome DevTools Protocol client over native WebSocket.
 * Extended for web-based multi-tab usage: can discover multiple Copilot tabs,
 * create new tabs, and connect to specific targets.
 *
 * Uses the native WebSocket API (available in Bun and Node 22+).
 */

export class CDPError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CDPError"
  }
}

export class CDPClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private connected = false
  private listeners = new Map<string, Set<(params: any) => void>>()

  /**
   * OOPIF support (opt-in, word engine only). When auto-attach is enabled at
   * connect() time, every nested cross-origin iframe/worker target that attaches
   * to this socket is tracked here, keyed by its CDP sessionId -> targetInfo.
   * Commands can then be routed into a specific frame by passing its sessionId
   * to send()/evaluate(). For the web engine this map stays empty and unused, so
   * that path is byte-identical to before.
   */
  readonly sessions = new Map<string, any>()
  private autoAttach = false

  /**
   * OOPIF routing default (word engine only). When set to a frame's CDP
   * sessionId, every session-aware helper (evaluate/insertText/pressKey/
   * clickXY/clickSelector/setFileInput) and send() itself transparently address
   * that frame unless an explicit sessionId is passed. This lets the existing
   * top-target driver functions (checkComposer, sendPrompt, awaitResponse, …)
   * drive the Copilot OOPIF unchanged once the frame is resolved. Pass the
   * sentinel "" as an explicit sessionId to force the TOP target even while this
   * is set (used for browser-level commands like Browser.grantPermissions). Left
   * undefined for the m365 engine, so that path is byte-identical to before.
   */
  defaultSessionId?: string

  constructor(private readonly wsUrl: string) {}

  /** Subscribe to a CDP event (e.g. "Network.webSocketFrameReceived"). */
  on(event: string, handler: (params: any) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
  }

  /** Unsubscribe from a CDP event. */
  off(event: string, handler: (params: any) => void): void {
    this.listeners.get(event)?.delete(handler)
  }

  async connect(options?: { autoAttach?: boolean }): Promise<void> {
    if (this.connected) return
    this.ws = new WebSocket(this.wsUrl)
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.connected = true
        resolve()
      }
      this.ws!.onerror = (ev) => {
        reject(new CDPError(`WebSocket connection failed: ${ev.type}`))
      }
    })
    this.ws.onmessage = (ev) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data)
        const msg = JSON.parse(data)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(new CDPError(`CDP error ${msg.error.code}: ${msg.error.message}`))
          } else {
            p.resolve(msg.result)
          }
        } else if (msg.method) {
          // CDP event — dispatch to registered listeners
          const handlers = this.listeners.get(msg.method)
          if (handlers) {
            for (const handler of handlers) handler(msg.params)
          }
        }
      } catch {}
    }
    this.ws.onclose = () => {
      this.connected = false
      for (const p of this.pending.values()) {
        p.reject(new CDPError("WebSocket closed"))
      }
      this.pending.clear()
      this.sessions.clear()
    }

    // OOPIF support (opt-in). Word Online embeds the editor + Copilot pane in
    // nested cross-origin out-of-process iframes that do NOT surface as
    // execution contexts on the top page's socket. Flattened auto-attach pulls a
    // session for every nested frame/worker onto THIS one socket; we then route
    // Runtime.evaluate / Input.* into a frame via its sessionId. Guarded so the
    // web engine (which never passes autoAttach) is completely unaffected.
    if (options?.autoAttach) {
      await this.enableAutoAttach()
    }
  }

  /**
   * Turn on flattened, recursive Target auto-attach for this connection so that
   * nested OOPIFs (e.g. the Word editor frame and the Copilot app frame inside
   * it) attach onto this single socket. Each newly-attached target is tracked in
   * `sessions` and has auto-attach re-enabled on it, so attachment recurses all
   * the way down. Idempotent. Only used by the word engine.
   */
  async enableAutoAttach(): Promise<void> {
    if (this.autoAttach) return
    this.autoAttach = true

    // Track sessions as targets attach/detach, and recurse into each new target
    // so its own children also flatten onto this socket. The recursive
    // setAutoAttach is fire-and-forget (a detached/short-lived target may reject).
    this.on("Target.attachedToTarget", (params: any) => {
      const sid = params?.sessionId
      if (!sid) return
      this.sessions.set(sid, params.targetInfo)
      this.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sid,
      ).catch(() => {})
    })
    this.on("Target.detachedFromTarget", (params: any) => {
      const sid = params?.sessionId
      if (!sid) return
      this.sessions.delete(sid)
      // Word engine stale-frame recovery: if the currently-routed Copilot OOPIF
      // detaches (pane closed, frame re-render, navigation), immediately drop the
      // routing target so the next probe does not keep sending Runtime/Input
      // commands into a dead sessionId.
      if (this.defaultSessionId === sid) {
        this.defaultSessionId = undefined
      }
    })

    // Kick off attachment from the top target. Child attachedToTarget events
    // arrive asynchronously; callers should give them a beat (or use
    // waitForFrameSession) before enumerating `sessions`.
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
  }

  /**
   * Find the attached OOPIF whose document satisfies `testExpression` (a JS
   * expression evaluated inside each candidate frame that returns truthy on a
   * match). Used to locate the Copilot composer frame, e.g.
   *   `!!document.querySelector('#m365-chat-editor-target-element')`
   * Enables Runtime per candidate session (attached frames start without it) and
   * returns the first matching sessionId, or null. Only iframe/page/webview
   * targets are probed; workers and other target types are skipped.
   */
  async findFrameSession(testExpression: string): Promise<string | null> {
    for (const [sid, info] of this.sessions) {
      const type = info?.type
      if (type !== "iframe" && type !== "page" && type !== "webview") continue
      try {
        await this.send("Runtime.enable", undefined, sid)
        const matched = await this.evaluate(testExpression, sid)
        if (matched) return sid
      } catch {
        // Frame may have navigated/detached mid-probe; skip it.
        continue
      }
    }
    return null
  }

  /**
   * Wait up to `timeoutMs` for `findFrameSession(testExpression)` to resolve a
   * matching OOPIF, polling as child targets attach asynchronously after
   * auto-attach is enabled. Returns the sessionId or null on timeout.
   */
  async waitForFrameSession(testExpression: string, timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const sid = await this.findFrameSession(testExpression)
      if (sid) return sid
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (!this.ws || !this.connected) throw new CDPError("Not connected")
    const id = this.nextId++
    const envelope: Record<string, unknown> = { id, method, params }
    // Route into the OOPIF frame by default (word engine) unless the caller
    // passed an explicit sessionId. The sentinel "" forces the TOP target even
    // when a frame default is set (browser-level commands).
    const sid = sessionId === "" ? undefined : (sessionId ?? this.defaultSessionId)
    if (sid) envelope.sessionId = sid
    const msg = JSON.stringify(envelope)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws!.send(msg)
      } catch (err: any) {
        this.pending.delete(id)
        reject(new CDPError(`WebSocket send failed: ${err?.message || err}`))
      }
    })
  }

  async evaluate(expression: string, sessionId?: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }, sessionId)
    if (result?.exceptionDetails) {
      throw new CDPError(`JS exception: ${result.exceptionDetails.text}`)
    }
    return result?.result?.value
  }

  async evaluateAsync(expression: string, sessionId?: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId)
    if (result?.exceptionDetails) {
      throw new CDPError(`JS exception: ${result.exceptionDetails.text}`)
    }
    return result?.result?.value
  }

  async insertText(text: string, sessionId?: string): Promise<void> {
    await this.send("Input.insertText", { text }, sessionId)
  }

  async pressKey(key: string, code: string, keyCode: number, sessionId?: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    }, sessionId)
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    }, sessionId)
  }

  async grantClipboard(origin: string): Promise<void> {
    // Browser-level command — force the TOP/browser target ("" sentinel) so a
    // frame default (word engine) never routes it into an OOPIF, which rejects it.
    await this.send("Browser.grantPermissions", {
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      origin,
    }, "")
  }

  /**
   * Click the center of an element found by CSS selector using real CDP mouse events.
   * Fluent UI menus require Input.dispatchMouseEvent — synthetic .click() is ignored.
   * Returns true if the element was found and clicked.
   */
  async clickSelector(selector: string, sessionId?: string): Promise<boolean> {
    const rect = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || !(el.offsetWidth || el.offsetHeight)) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `, sessionId)
    if (!rect) return false
    await this.clickXY(rect.x, rect.y)
    return true
  }

  /**
   * Dispatch a real left-click at viewport coordinates via CDP Input domain.
   */
  async clickXY(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      })
    }
  }

  /**
   * Set files on a (possibly hidden) <input type="file"> via DOM.setFileInputFiles.
   * Mirrors Lumen's CDPSession.set_file_input exactly.
   */
  async setFileInput(selector: string, paths: string[]): Promise<void> {
    const doc = await this.send("DOM.getDocument", { depth: 0 })
    const root = doc?.root?.nodeId
    if (!root) throw new CDPError("DOM.getDocument returned no root nodeId")
    const found = await this.send("DOM.querySelector", { nodeId: root, selector })
    const nodeId = found?.nodeId
    if (!nodeId) throw new CDPError(`file input not found: ${selector}`)
    await this.send("DOM.setFileInputFiles", { files: paths, nodeId })
  }
}

// ─── Target Discovery (multi-tab aware) ──────────────────────────────────────

export interface CDPTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * List all page targets from the CDP /json endpoint.
 */
export async function listTargets(port: number): Promise<CDPTarget[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
    return await res.json()
  } catch {
    return []
  }
}

/**
 * Find all Copilot/M365 chat tabs.
 */
export async function findCopilotTabs(port: number): Promise<CDPTarget[]> {
  const targets = await listTargets(port)
  return targets.filter((t) => {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) return false
    const urlLower = (t.url || "").toLowerCase()
    return (
      urlLower.includes("microsoft365.com/chat") ||
      urlLower.includes("m365.cloud.microsoft/chat") ||
      urlLower.includes("copilot.microsoft.com")
    )
  })
}

/**
 * Find all Word Online tabs (parking docs for the word engine). Word routes
 * Copilot through its own token allocation, so we drive the BizChat pane
 * embedded in a Word Online tab rather than the general chat surface. Matches
 * the same host set the Python prototype's `_looks_like_word` used.
 */
export async function findWordTabs(port: number): Promise<CDPTarget[]> {
  const targets = await listTargets(port)
  return targets.filter((t) => {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) return false
    const urlLower = (t.url || "").toLowerCase()
    const titleLower = (t.title || "").toLowerCase()
    return (
      urlLower.includes("word.cloud.microsoft") ||
      urlLower.includes("officeapps.live.com") ||
      urlLower.includes("sharepoint.com") ||
      urlLower.includes(".docx") ||
      titleLower.includes(".docx")
    )
  })
}

/**
 * Find a single available Copilot tab's WebSocket URL (for backward compat).
 */
export async function findTargetWs(port: number): Promise<string | null> {
  const tabs = await findCopilotTabs(port)
  if (tabs.length === 0) return null
  return tabs[0].webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
}

/**
 * Create a new tab by navigating to a URL via the CDP /json/new endpoint.
 * Returns the new target info.
 */
export async function createNewTab(port: number, url: string): Promise<CDPTarget | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, {
      signal: AbortSignal.timeout(10000),
    })
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Create a new tab reliably via the browser-level CDP endpoint
 * (Target.createTarget). Unlike GET /json/new, this works even when Chrome's
 * HTTP new-tab endpoint is disabled or when we attached to a user-launched
 * browser. Returns the new tab's CDPTarget (with a page-level ws url) or null.
 */
export async function createTabViaCDP(port: number, url: string): Promise<CDPTarget | null> {
  try {
    const verRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })
    const ver = await verRes.json() as { webSocketDebuggerUrl?: string }
    const browserWs = ver.webSocketDebuggerUrl?.replace("localhost", "127.0.0.1")
    if (!browserWs) return null
    const browser = new CDPClient(browserWs)
    await browser.connect()
    let newTargetId: string | undefined
    try {
      const created = await browser.send("Target.createTarget", { url }) as { targetId?: string }
      newTargetId = created?.targetId
    } finally {
      await browser.disconnect()
    }
    if (!newTargetId) return null
    // Resolve the fresh target's page ws url from /json, retrying briefly since
    // the new target may take a moment to appear in the list.
    for (let attempt = 0; attempt < 10; attempt++) {
      const targets = await listTargets(port)
      const match = targets.find((t) => t.id === newTargetId)
      if (match && match.webSocketDebuggerUrl) return match
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  } catch {
    return null
  }
}

/**
 * Close a tab by target ID.
 */
export async function closeTab(port: number, targetId: string): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(5000),
    })
    return true
  } catch {
    return false
  }
}
