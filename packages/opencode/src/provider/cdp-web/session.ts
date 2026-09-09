/**
 * CDP-Web Session Pool — manages multiple concurrent Copilot conversations,
 * each in its own browser tab.
 *
 * Unlike the app-based CDP provider (singleton), this pool allows unlimited
 * parallel sessions. Each session owns one browser tab with an independent
 * Copilot conversation.
 */
import { CDPClient } from "./client"
import { releaseClaim, releaseTargetClaim } from "./claims"

export interface SessionState {
  /** Unique ID for this session */
  id: string
  /** Fingerprint of the system prompt (to detect session changes) */
  systemFingerprint: string
  /** Number of prompt messages already sent to the Copilot conversation */
  messagesSent: number
  /** The CDP client for this session's tab */
  client: CDPClient | null
  /** The CDP target ID for this tab */
  targetId: string | null
  /**
   * Word engine only: the CDP sessionId of the resolved Copilot OOPIF (the
   * out-of-process iframe whose document holds the BizChat composer). Set once
   * the pane is opened and the frame is found; used as the client's
   * defaultSessionId so the top-target driver functions drive the frame. Null
   * for the m365 engine (flat page, no OOPIF).
   */
  frameSessionId: string | null
  /** Whether the conversation has been initialized (new chat opened, effort set) */
  initialized: boolean
  /**
   * Word engine only. True when this sid was bound to a Word tab before (a tab
   * affinity record existed at bind time), so this turn is a RESUME: word init
   * must continue the pane's current conversation in place instead of clicking
   * New Chat and wiping it. False for a brand-new sid (clean chat wanted).
   */
  resumeInPlace: boolean
  /** Number of assistant turns completed in this conversation */
  turnCount: number
  /** Cumulative input tokens sent to Copilot across all turns (estimate) */
  cumulativeInputTokens: number
  /** Cumulative output tokens received from Copilot across all turns (estimate) */
  cumulativeOutputTokens: number
  /**
   * Word engine only. cumulativeInputTokens+cumulativeOutputTokens total at the
   * last time the coding-agent reminder was injected into a delta message (0 =
   * never sent one yet this conversation). Used to fire the reminder every
   * `reminderTokenInterval` tokens rather than on a fixed turn count.
   */
  tokensAtLastReminder: number
  /** Whether this session is currently in use */
  busy: boolean
  /** Whether auth is valid for this tab */
  authenticated: boolean
  /** Whether this session runs in temporary (non-persisted) mode */
  temporary: boolean
  /** Copilot-generated conversation GUID (persistent chats only) — the recovery key */
  conversationId: string | null
  /** Copilot-generated conversation title (for sidebar-match fallback) */
  conversationTitle: string | null
}

// All active sessions keyed by ID
const sessions = new Map<string, SessionState>()
let nextSessionId = 0

export function computeFingerprint(systemContent: string, toolNames: string[]): string {
  const input = systemContent + "\x00" + toolNames.join(",")
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return hash.toString(36)
}

/**
 * Create a new session (new tab will be opened).
 */
export function createSession(fingerprint: string, temporary = true): SessionState {
  const id = `cdp-web-${++nextSessionId}`
  const session: SessionState = {
    id,
    systemFingerprint: fingerprint,
    messagesSent: 0,
    client: null,
    targetId: null,
    frameSessionId: null,
    initialized: false,
    resumeInPlace: false,
    turnCount: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    tokensAtLastReminder: 0,
    busy: false,
    authenticated: true,
    temporary,
    conversationId: null,
    conversationTitle: null,
  }
  sessions.set(id, session)
  return session
}

/**
 * Get an existing session by ID.
 */
export function getSession(id: string): SessionState | undefined {
  return sessions.get(id)
}

/**
 * Check if a target ID is already claimed by any existing session.
 * Prevents two model instances from fighting over the same tab.
 */
export function isTargetClaimed(targetId: string): boolean {
  for (const session of sessions.values()) {
    if (session.targetId === targetId) return true
  }
  return false
}

/**
 * Find a free session with matching fingerprint, or return null.
 */
export function findFreeSession(fingerprint: string): SessionState | null {
  for (const session of sessions.values()) {
    if (!session.busy && session.systemFingerprint === fingerprint && session.authenticated) {
      return session
    }
  }
  return null
}

/**
 * Mark a session as busy (in use by a doGenerate call).
 */
export function acquireSession(session: SessionState): void {
  session.busy = true
}

/**
 * Release a session back to the pool.
 */
export function releaseSession(session: SessionState): void {
  session.busy = false
}

/**
 * Destroy a session and close its tab connection.
 */
export async function destroySession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  // Best-effort release of our cross-process tab claims (pid-liveness is the
  // real backstop, so failure here is harmless).
  if (session.conversationId) {
    await releaseClaim(session.conversationId).catch(() => {})
  }
  if (session.targetId) {
    await releaseTargetClaim(session.targetId).catch(() => {})
  }
  if (session.client) {
    await session.client.disconnect().catch(() => {})
  }
  sessions.delete(id)
}

/**
 * Destroy all sessions.
 */
export async function destroyAllSessions(): Promise<void> {
  for (const session of sessions.values()) {
    if (session.conversationId) {
      await releaseClaim(session.conversationId).catch(() => {})
    }
    if (session.targetId) {
      await releaseTargetClaim(session.targetId).catch(() => {})
    }
    if (session.client) {
      await session.client.disconnect().catch(() => {})
    }
  }
  sessions.clear()
}

/**
 * Get pool stats.
 */
export function getPoolStats(): { total: number; busy: number; free: number; unauthenticated: number } {
  let busy = 0
  let free = 0
  let unauthenticated = 0
  for (const session of sessions.values()) {
    if (!session.authenticated) unauthenticated++
    else if (session.busy) busy++
    else free++
  }
  return { total: sessions.size, busy, free, unauthenticated }
}

/**
 * Connect a session's CDP client to a specific tab's WebSocket URL.
 */
export async function connectSession(session: SessionState, wsUrl: string, opts?: { autoAttach?: boolean }): Promise<CDPClient> {
  if (session.client?.isConnected()) return session.client

  const client = new CDPClient(wsUrl)
  // The word engine opts into flattened OOPIF auto-attach so the nested Copilot
  // iframe attaches onto this socket; m365 never passes autoAttach (byte-identical).
  await client.connect({ autoAttach: opts?.autoAttach })
  await client.send("Runtime.enable")
  await client.send("DOM.enable")
  await client.send("Page.enable")
  session.client = client
  return client
}
