/**
 * affinity.ts — Word engine tab affinity (sid → CDP targetId).
 *
 * The m365 engine anchors a session to a Copilot conversation GUID that lives in
 * the tab URL (`/chat/conversation/<guid>`), so it can always re-find "its" tab.
 * The Word engine has no such anchor: a Word Copilot conversation lives only in
 * the pane's in-memory history, and the tab URL is just the (single, shared)
 * parking doc — `copilot.docx` for every conversation. The URL therefore emits
 * nothing that distinguishes one Word conversation from another.
 *
 * So Word affinity is deliberately simple and tab-shaped, not conversation-shaped:
 * we remember which CDP tab (targetId) an opencode session last drove. CDP
 * targetIds are assigned by Chrome and stay stable for the browser's lifetime —
 * across opencode restarts — so a resumed session can re-adopt the exact tab it
 * was using, even though opencode's in-memory session pool was wiped.
 *
 * Two things the record gives us:
 *   1. Routing: when several Word tabs are open, adopt the one THIS sid used,
 *      not just "the first unclaimed Word tab".
 *   2. Resume signal: the mere existence of a record means "we've bound this sid
 *      to a tab before" → this turn is a RESUME, so init must continue the pane's
 *      current conversation in place rather than clicking New Chat and wiping it.
 *
 * Conversations are treated as ephemeral (they are private chats, so Word still
 * tracks them, but we don't try to programmatically reopen a specific one —
 * there is no CDP handle for that). Manual recovery is the accepted path: open a
 * Word tab, navigate to the conversation in the pane, open opencode to the right
 * session, and continue as if we never left. This record is what makes that
 * "continue in place" behavior fire.
 */
import path from "path"
import os from "os"
import { readFile, writeFile, rm, mkdir } from "fs/promises"
import { Global } from "@opencode-ai/core/global"

const AFFINITY_DIR = path.join(Global.Path.state, "cdp-web-affinity")
const HOSTNAME = os.hostname()

export interface TabAffinity {
  /** opencode sessionID this record belongs to */
  sid: string
  /** CDP targetId of the Word tab this sid last drove */
  targetId: string
  /** Hostname of the writer (targetIds are only meaningful on the same browser/host) */
  hostname: string
  /** ISO timestamp of the last bind */
  updatedAt: string
}

function affinityPath(sid: string): string {
  // opencode sids are word chars + a few separators; sanitize to a safe basename.
  const safe = sid.replace(/[^A-Za-z0-9_-]/g, "_")
  return path.join(AFFINITY_DIR, `${safe}.json`)
}

/**
 * Load the tab-affinity record for an opencode session, or null if this sid has
 * never bound a Word tab (i.e. a brand-new session). Records written on another
 * host are ignored — a targetId only means something on the browser that minted
 * it.
 */
export async function loadTabAffinity(sid: string): Promise<TabAffinity | null> {
  try {
    const raw = await readFile(affinityPath(sid), "utf8")
    const parsed = JSON.parse(raw) as TabAffinity
    if (!parsed || typeof parsed.targetId !== "string") return null
    if (parsed.hostname && parsed.hostname !== HOSTNAME) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist (or refresh) the sid → targetId binding for a Word session. Called at
 * bind time. Best-effort: a failed write only costs us the resume optimization,
 * never correctness of the current turn.
 */
export async function saveTabAffinity(sid: string, targetId: string): Promise<void> {
  try {
    await mkdir(AFFINITY_DIR, { recursive: true })
    const record: TabAffinity = {
      sid,
      targetId,
      hostname: HOSTNAME,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(affinityPath(sid), JSON.stringify(record, null, 2))
  } catch {
    // ignore — resume is an optimization, not a requirement
  }
}

/**
 * Forget a session's tab affinity (called when its tab is destroyed). Keeping a
 * stale record is harmless — it's always validated against live tabs before use —
 * so this is just tidiness.
 */
export async function clearTabAffinity(sid: string): Promise<void> {
  await rm(affinityPath(sid), { force: true }).catch(() => {})
}
