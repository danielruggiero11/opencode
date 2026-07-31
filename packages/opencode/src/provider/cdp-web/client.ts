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

  async connect(): Promise<void> {
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

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.ws || !this.connected) throw new CDPError("Not connected")
    const id = this.nextId++
    const msg = JSON.stringify({ id, method, params })
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

  async evaluate(expression: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })
    if (result?.exceptionDetails) {
      throw new CDPError(`JS exception: ${result.exceptionDetails.text}`)
    }
    return result?.result?.value
  }

  async evaluateAsync(expression: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result?.exceptionDetails) {
      throw new CDPError(`JS exception: ${result.exceptionDetails.text}`)
    }
    return result?.result?.value
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text })
  }

  async pressKey(key: string, code: string, keyCode: number): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    })
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    })
  }

  async grantClipboard(origin: string): Promise<void> {
    await this.send("Browser.grantPermissions", {
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      origin,
    })
  }

  /**
   * Click the center of an element found by CSS selector using real CDP mouse events.
   * Fluent UI menus require Input.dispatchMouseEvent — synthetic .click() is ignored.
   * Returns true if the element was found and clicked.
   */
  async clickSelector(selector: string): Promise<boolean> {
    const rect = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || !(el.offsetWidth || el.offsetHeight)) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `)
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
