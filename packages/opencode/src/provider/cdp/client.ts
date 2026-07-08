/**
 * Low-level Chrome DevTools Protocol client over WebSocket.
 * Connects to a single CDP target and provides evaluate/click/insertText primitives.
 */
import WebSocket from "ws"

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

  constructor(private readonly wsUrl: string) {}

  async connect(): Promise<void> {
    if (this.connected) return
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 20 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => {
        this.connected = true
        resolve()
      })
      this.ws!.once("error", reject)
    })
    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(new CDPError(`CDP error ${msg.error.code}: ${msg.error.message}`))
          } else {
            p.resolve(msg.result)
          }
        }
      } catch {}
    })
    this.ws.on("close", () => {
      this.connected = false
      for (const p of this.pending.values()) {
        p.reject(new CDPError("WebSocket closed"))
      }
      this.pending.clear()
    })
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
      this.ws!.send(msg, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(new CDPError(`WebSocket send failed: ${err.message}`))
        }
      })
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
}

/**
 * Discover a page target's WebSocket URL from the CDP /json endpoint.
 */
export async function findTargetWs(port = 9223): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
    const targets: Array<{ type: string; title: string; url: string; webSocketDebuggerUrl?: string }> = await res.json()
    for (const t of targets) {
      if (t.type === "page" && t.webSocketDebuggerUrl) {
        const titleLower = (t.title || "").toLowerCase()
        const urlLower = (t.url || "").toLowerCase()
        if (titleLower.includes("copilot") || urlLower.includes("microsoft365.com")) {
          return t.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
        }
      }
    }
    return null
  } catch {
    return null
  }
}
