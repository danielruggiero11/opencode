/**
 * driver-ws.ts – WebSocket-based response capture for Copilot.
 *
 * Instead of polling the DOM, this listens for SignalR WebSocket frames
 * via CDP's Network.webSocketFrameReceived event. The frames contain
 * properly JSON-encoded text, eliminating all escaping/repair issues.
 *
 * Exports:
 *   • enableWsCapture(client)       – enable Network domain for WS events
 *   • awaitResponseWs(client)       – wait for Copilot response via WS frames
 */

import { CDPClient } from "./client"

/* ────────────────────────────────────────────────────────── constants ── */
const CHATHUB_URL_MARKER = "m365Copilot/Chathub"
const TIMEOUT_MS = 180_000 // 3 min max wait
const SETTLE_MS = 2_000   // Wait 2s after isLastUpdate before resolving (catches multi-segment responses)

/* ────────────────────────────────────────────────── types ── */

interface SignalRMessage {
  type: number
  target?: string
  invocationId?: string
  arguments?: SignalRArgument[]
  item?: SignalRItem
}

interface SignalRArgument {
  messages?: SignalRBotMessage[]
  isLastUpdate?: boolean
  requestId?: string
  cursor?: unknown
  patches?: unknown[]
  nonce?: string
}

interface SignalRBotMessage {
  text?: string
  author?: string
  contentOrigin?: string
  messageType?: string
  turnState?: string
}

interface SignalRItem {
  messages?: SignalRBotMessage[]
  turnState?: string
  result?: { value?: string; message?: string }
}

/* ────────────────────────────────────────────────── state ── */

/**
 * Per-client listener state. We track active WebSocket requestIds
 * that match the Chathub URL pattern.
 */
interface WsListenerState {
  chathubRequestIds: Set<string>
  frameHandler: ((payload: string, requestId: string) => void) | null
}

const clientState = new WeakMap<CDPClient, WsListenerState>()

/* ────────────────────────────────────────────────── public ── */

/**
 * Enable Network domain and register WebSocket event listeners.
 * Call once per CDPClient after connecting.
 */
export async function enableWsCapture(client: CDPClient): Promise<void> {
  await client.send("Network.enable", {})

  const state: WsListenerState = {
    chathubRequestIds: new Set(),
    frameHandler: null,
  }
  clientState.set(client, state)

  client.on("Network.webSocketCreated", (params: { requestId: string; url: string }) => {
    if (params.url.includes(CHATHUB_URL_MARKER)) {
      state.chathubRequestIds.add(params.requestId)
      console.error(`[cdp-web ws] tracked Chathub WS: ${params.requestId}`)
    }
  })

  client.on("Network.webSocketClosed", (params: { requestId: string }) => {
    state.chathubRequestIds.delete(params.requestId)
  })

  client.on("Network.webSocketFrameReceived", (params: { requestId: string; response: { payloadData: string } }) => {
    if (!state.chathubRequestIds.has(params.requestId)) return
    if (!state.frameHandler) return
    state.frameHandler(params.response.payloadData, params.requestId)
  })

  // Also capture WebSocket frames sent BY the page (outgoing). Copilot sends
  // invocation requests via WS; monitoring these helps us correlate responses.
  client.on("Network.webSocketFrameSent", (params: { requestId: string; response: { payloadData: string } }) => {
    // If this requestId sends to a Chathub URL, track it
    // (handles case where WS was created before Network.enable)
    if (!state.chathubRequestIds.has(params.requestId)) return
    // Could log outgoing for debug if needed
  })
}

/**
 * Wait for Copilot's full response via WebSocket frames.
 * Returns the final bot message text (with JSON escaping intact).
 */
export function awaitResponseWs(client: CDPClient, signal?: AbortSignal): Promise<string> {
  const state = clientState.get(client)
  if (!state) return Promise.reject(new Error("WebSocket capture not enabled. Call enableWsCapture first."))

  return new Promise((resolve, reject) => {
    let accumulatedText = ""
    let resolved = false

    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      state.frameHandler = null
      if (accumulatedText) resolve(accumulatedText)
      else reject(new Error("WebSocket response timeout: no frames received within " + TIMEOUT_MS + "ms"))
    }, TIMEOUT_MS)

    // Respect caller's AbortSignal
    if (signal) {
      if (signal.aborted) {
        resolved = true
        clearTimeout(timer)
        state.frameHandler = null
        reject(signal.reason || new Error("Aborted"))
        return
      }
      signal.addEventListener("abort", () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        state.frameHandler = null
        reject(signal.reason || new Error("Aborted"))
      }, { once: true })
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null

    state.frameHandler = (payload: string) => {
      if (resolved) return

      const messages = parseSignalRPayload(payload)
      for (const msg of messages) {
        // Type 1: streaming update
        if (msg.type === 1 && msg.arguments) {
          for (const arg of msg.arguments) {
            if (arg.messages) {
              for (const m of arg.messages) {
                if (m.author === "bot" && m.text && isChatContent(m)) {
                  accumulatedText = m.text
                  // New content arrived — cancel any pending settle timer
                  if (settleTimer) {
                    clearTimeout(settleTimer)
                    settleTimer = null
                  }
                }
              }
            }

            // isLastUpdate: start a settle window instead of resolving immediately.
            // If more frames arrive within SETTLE_MS, the timer resets above.
            if (arg.isLastUpdate && accumulatedText) {
              if (!settleTimer) {
                settleTimer = setTimeout(() => {
                  settleTimer = null
                  finish()
                }, SETTLE_MS)
              }
            }
          }
        }

        // Type 2: invocation complete — authoritative done signal
        if (msg.type === 2 && msg.item) {
          const botMsg = msg.item.messages?.filter(
            m => m.author === "bot" && m.text && isChatContent(m)
          ).pop()
          if (botMsg?.text) accumulatedText = botMsg.text
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
          finish()
          return
        }
      }
    }

    function finish() {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      state!.frameHandler = null
      resolve(accumulatedText)
    }
  })
}

/* ────────────────────────────────────────────────── internal ── */

/**
 * Parse a SignalR WebSocket payload. SignalR uses \x1e (record separator)
 * to delimit multiple JSON messages in a single frame.
 */
function parseSignalRPayload(payload: string): SignalRMessage[] {
  const results: SignalRMessage[] = []
  const parts = payload.split("\x1e").filter(Boolean)

  for (const part of parts) {
    try {
      results.push(JSON.parse(part))
    } catch {
      // Some frames have trailing separators or non-JSON; skip
    }
  }

  return results
}

/**
 * Determine if a bot message is actual chat content (not progress/suggestion).
 */
function isChatContent(msg: SignalRBotMessage): boolean {
  if (msg.messageType === "Progress") return false
  if (msg.messageType === "Suggestion") return false
  if (msg.messageType === "HintInvocation") return false
  if (msg.messageType === "ReferencesListComplete") return false
  if (msg.contentOrigin === "EarlyProgress") return false
  if (msg.contentOrigin === "SuggestionsProviderService") return false
  if (msg.contentOrigin === "ExtensibleHintGenerator") return false
  return true
}
