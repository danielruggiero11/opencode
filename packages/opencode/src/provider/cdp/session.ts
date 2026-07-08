/**
 * CDP Session Manager — tracks the state of persistent Copilot conversations.
 *
 * Each opencode session maps to one Copilot conversation. The session tracks:
 * - How many prompt messages have been "committed" (already sent to Copilot)
 * - The system prompt fingerprint (to detect new sessions)
 * - The CDP client connection
 *
 * Since M365Copilot.exe is a singleton (one composer), only one session is
 * active at a time. If a different opencode session tries to use the provider,
 * the existing conversation is abandoned and a new one starts.
 */
import { CDPClient, CDPError, findTargetWs } from "./client"

export interface SessionState {
  /** Fingerprint of the system prompt (to detect session changes) */
  systemFingerprint: string
  /** Number of prompt messages already sent to the Copilot conversation */
  messagesSent: number
  /** The CDP client for this session */
  client: CDPClient | null
  /** Whether the conversation has been initialized (new chat opened, effort set) */
  initialized: boolean
  /** Number of assistant turns completed in this conversation */
  turnCount: number
}

// Module-level singleton state. Only one session at a time.
let currentSession: SessionState | null = null

// Simple fingerprint: hash the system prompt content + tool names.
// If either changes, it's a new session.
export function computeFingerprint(systemContent: string, toolNames: string[]): string {
  // Use a simple checksum — we don't need crypto here, just change detection
  const input = systemContent + "\x00" + toolNames.join(",")
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return hash.toString(36)
}

export function getSession(): SessionState | null {
  return currentSession
}

export function createSession(fingerprint: string): SessionState {
  // Disconnect old session if exists
  if (currentSession?.client) {
    currentSession.client.disconnect().catch(() => {})
  }
  currentSession = {
    systemFingerprint: fingerprint,
    messagesSent: 0,
    client: null,
    initialized: false,
    turnCount: 0,
  }
  return currentSession
}

export function resetSession(): void {
  if (currentSession?.client) {
    currentSession.client.disconnect().catch(() => {})
  }
  currentSession = null
}

/**
 * Get or create a connected CDP client for the current session.
 * Reconnects if the connection was lost.
 */
export async function ensureClient(port: number): Promise<CDPClient> {
  if (!currentSession) throw new CDPError("No active CDP session")

  if (currentSession.client?.isConnected()) {
    return currentSession.client
  }

  // Need to (re)connect
  const wsUrl = await findTargetWs(port)
  if (!wsUrl) {
    throw new CDPError(`Copilot CDP endpoint not reachable on port ${port}. Is M365Copilot.exe running?`)
  }

  const client = new CDPClient(wsUrl)
  await client.connect()
  await client.send("Runtime.enable")
  await client.send("DOM.enable")
  await client.send("Page.enable")
  currentSession.client = client
  return client
}
