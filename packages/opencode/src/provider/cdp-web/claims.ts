/**
 * claims.ts — Cross-process, cross-platform tab-claim registry for cdp-web.
 *
 * Problem: after an opencode restart the in-memory session pool is empty, so
 * `isTargetClaimed` (which only knows this process's sessions) can't tell which
 * Copilot tabs are in use by OTHER live opencode instances. Blindly reusing a
 * tab another instance is actively driving would cross-contaminate conversations.
 *
 * Design (agreed with the user, hardened from the AHK approach):
 *   - Liveness is a PID, never a flag someone has to remember to clear. When an
 *     opencode window is X'd there is no clean shutdown hook (index.ts just calls
 *     process.exit()), so any "I'm done" file would leak. Instead we ask the OS
 *     `process.kill(pid, 0)` whether the owner is still alive — which is truthful
 *     even after a hard kill, and identical on Windows / macOS / Linux.
 *   - Each bind writes a claim file keyed by the Copilot conversation GUID:
 *       <state>/cdp-web-claims/<guid>.json = { guid, pid, sessionID, boundAt }
 *   - A tab is "available" iff its GUID has no claim owned by a LIVE pid.
 *     Dead-pid claims are ignored and lazily deleted. Blank/GUID-less tabs are
 *     always stealable.
 *   - The whole read-scan-pick-write step runs inside Flock.withLock so two
 *     instances booting simultaneously can't grab the same tab (race the user
 *     explicitly called out).
 *
 * No AHK, no Python, no window-title scraping — so it also works when opencode
 * runs embedded (e.g. inside VSCode) where there is no "OC | <title>" terminal.
 */
import path from "path"
import os from "os"
import { readdir, readFile, writeFile, rm, mkdir } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"

export interface TabClaim {
  /** Copilot conversation GUID this claim covers */
  guid: string
  /** PID of the owning opencode process (liveness key) */
  pid: number
  /** Hostname of the owner — guards against PID reuse across machines */
  hostname: string
  /** opencode SessionID that bound the tab (for diagnostics) */
  sessionID?: string
  /** ISO timestamp when the claim was written */
  boundAt: string
  /**
   * ISO timestamp of last activity. Only set on temp (targetId) claims, where it
   * drives the idle TTL. Re-stamped every turn. Absent on tracked/persistent
   * claims, which never expire (their GUID keeps them recoverable regardless).
   */
  lastTouched?: string
}

const CLAIMS_DIR = path.join(Global.Path.state, "cdp-web-claims")
// Separate dir for tab-id (targetId) claims. Unlike GUIDs, a targetId exists
// for EVERY tab immediately at bind time — including temporary chats that never
// get a conversation GUID. This is what protects temp tabs across processes.
const TARGET_CLAIMS_DIR = path.join(Global.Path.state, "cdp-web-target-claims")
const LOCK_KEY = "cdp-web-tab-claims"
const HOSTNAME = os.hostname()

// Temp (targetId) claims expire after this much IDLE time. "Idle 4h" is not "4h
// old": lastTouched is re-stamped every turn via touchTargetClaim, so an actively
// used temp chat never ages out. Roughly matches Copilot's own idle-revert
// window, by which point the tab is a blank /chat corpse anyway. Tracked claims
// carry no lastTouched and never expire.
const TEMP_CLAIM_IDLE_TTL_MS = 4 * 60 * 60 * 1000

// A temp claim is honored only while its idle TTL is fresh. No lastTouched means
// it's a tracked claim (no TTL). An unparseable stamp is treated as fresh so a
// bad write never silently drops a live claim.
function isTempClaimExpired(claim: TabClaim): boolean {
  if (!claim.lastTouched) return false
  const touched = Date.parse(claim.lastTouched)
  if (Number.isNaN(touched)) return false
  return Date.now() - touched > TEMP_CLAIM_IDLE_TTL_MS
}

function claimPath(guid: string): string {
  // GUIDs are filesystem-safe (hex + hyphens), but guard anyway.
  const safe = guid.replace(/[^0-9a-fA-F-]/g, "")
  return path.join(CLAIMS_DIR, `${safe}.json`)
}

function targetClaimPath(targetId: string): string {
  // CDP target ids are hex; sanitize defensively.
  const safe = targetId.replace(/[^0-9a-fA-F]/g, "")
  return path.join(TARGET_CLAIMS_DIR, `${safe}.json`)
}

/**
 * Is a process alive? `process.kill(pid, 0)` sends no signal but performs the
 * permission/existence check. ESRCH => dead. EPERM => alive but owned by another
 * user (still counts as alive). Works on Windows, macOS, Linux.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    return false
  }
}

async function readClaim(file: string): Promise<TabClaim | null> {
  try {
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw) as TabClaim
    if (!parsed || typeof parsed.guid !== "string" || typeof parsed.pid !== "number") return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Read every claim currently owned by a LIVE pid on THIS host. Dead-pid claim
 * files are deleted as a side effect (lazy cleanup — the X-button case).
 */
export async function liveClaims(): Promise<Map<string, TabClaim>> {
  const out = new Map<string, TabClaim>()
  let files: string[]
  try {
    files = await readdir(CLAIMS_DIR)
  } catch {
    return out // dir doesn't exist yet => no claims
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue
    const file = path.join(CLAIMS_DIR, name)
    const claim = await readClaim(file)
    if (!claim) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }
    // Only trust liveness for claims from this machine (PIDs aren't unique across hosts).
    const alive = claim.hostname === HOSTNAME ? isPidAlive(claim.pid) : true
    if (alive && !isTempClaimExpired(claim)) {
      out.set(claim.guid, claim)
    } else {
      await rm(file, { force: true }).catch(() => {})
    }
  }
  return out
}

/**
 * Given the GUIDs currently open in the browser, return the set of GUIDs that
 * are claimed by a live OTHER process (i.e. not stealable). Runs under the lock.
 */
export async function claimedGuids(exceptSessionID?: string): Promise<Set<string>> {
  return Flock.withLock(LOCK_KEY, async () => {
    const claims = await liveClaims()
    const out = new Set<string>()
    for (const [guid, claim] of claims) { if (exceptSessionID && claim.sessionID === exceptSessionID) continue; out.add(guid) }
    return out
  })
}

/**
 * Write (or overwrite) the claim for a GUID on behalf of this process.
 * Called when a session binds/creates a persistent conversation.
 */
export async function writeClaim(guid: string, sessionID?: string): Promise<void> {
  await Flock.withLock(LOCK_KEY, async () => {
    await mkdir(CLAIMS_DIR, { recursive: true })
    const claim: TabClaim = {
      guid,
      pid: process.pid,
      hostname: HOSTNAME,
      sessionID,
      boundAt: new Date().toISOString(), lastTouched: new Date().toISOString(),
    }
    await writeFile(claimPath(guid), JSON.stringify(claim, null, 2))
  })
}

// ─── TargetId (tab-id) claims — protect temp tabs that have no GUID ──────────

/**
 * Read every targetId claim owned by a LIVE pid on this host. Dead-pid claims
 * are deleted lazily, same as the GUID path.
 */
async function liveTargetClaims(): Promise<Map<string, TabClaim>> {
  const out = new Map<string, TabClaim>()
  let files: string[]
  try {
    files = await readdir(TARGET_CLAIMS_DIR)
  } catch {
    return out
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue
    const file = path.join(TARGET_CLAIMS_DIR, name)
    const claim = await readClaim(file)
    if (!claim) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }
    const alive = claim.hostname === HOSTNAME ? isPidAlive(claim.pid) : true
    if (!alive) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }
    // Temp claims also expire on idle. A live pid can still be holding a tab
    // Copilot already idle-reverted to a blank /chat (conversation gone). Drop
    // the claim so the tab is reusable instead of protecting a corpse.
    if (isTempClaimExpired(claim)) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }
    out.set(claim.guid, claim)
  }
  return out
}

/**
 * Set of CDP targetIds currently claimed by a live process. Runs under the lock.
 * (We reuse TabClaim.guid to carry the targetId string.)
 */
export async function claimedTargetIds(exceptSessionID?: string): Promise<Set<string>> {
  return Flock.withLock(LOCK_KEY, async () => {
    const claims = await liveTargetClaims()
    const out = new Set<string>()
    for (const [tid, claim] of claims) { if (exceptSessionID && claim.sessionID === exceptSessionID) continue; out.add(tid) }
    return out
  })
}

/**
 * Claim a CDP tab by its targetId for this process. Written at bind time for
 * BOTH temporary and persistent sessions — this is the cross-process guard that
 * stops another instance from stealing a tab we're actively driving.
 */
export async function writeTargetClaim(targetId: string, sessionID?: string, temporary = false): Promise<void> {
  await Flock.withLock(LOCK_KEY, async () => {
    await mkdir(TARGET_CLAIMS_DIR, { recursive: true })
    const now = new Date().toISOString()
    const claim: TabClaim = {
      guid: targetId, // reuse the field to carry the targetId
      pid: process.pid,
      hostname: HOSTNAME,
      sessionID,
      boundAt: now,
      // Only temp claims get a TTL. lastTouched is re-stamped each turn via
      // touchTargetClaim so an active temp chat keeps resetting its idle clock.
      lastTouched: now,
    }
    await writeFile(targetClaimPath(targetId), JSON.stringify(claim, null, 2))
  })
}

/**
 * Re-stamp lastTouched on a temp targetId claim we own, marking this turn as
 * activity so the idle TTL resets. No-op if the claim is missing, not ours, or
 * carries no TTL (a tracked claim). Best-effort: never throws into the turn.
 */
export async function touchTargetClaim(targetId: string): Promise<void> {
  await Flock.withLock(LOCK_KEY, async () => {
    const file = targetClaimPath(targetId)
    const existing = await readClaim(file)
    if (!existing) return
    if (existing.pid !== process.pid || existing.hostname !== HOSTNAME) return
    existing.lastTouched = new Date().toISOString()
    await writeFile(file, JSON.stringify(existing, null, 2)).catch(() => {})
  }).catch(() => {})
}

/**
 * Best-effort release of a targetId claim we own.
 */
export async function releaseTargetClaim(targetId: string): Promise<void> {
  try {
    const existing = await readClaim(targetClaimPath(targetId))
    if (existing && existing.pid !== process.pid) return
    await rm(targetClaimPath(targetId), { force: true })
  } catch {
    // ignore
  }
}

/**
 * Best-effort release of a claim we own (used on graceful disposal). The pid
 * liveness check is the real backstop, so this is only an optimization to keep
 * the directory tidy — never relied upon for correctness.
 */
export async function releaseClaim(guid: string): Promise<void> {
  try {
    const existing = await readClaim(claimPath(guid))
    if (existing && existing.pid !== process.pid) return // not ours
    await rm(claimPath(guid), { force: true })
  } catch {
    // ignore
  }
}

/**
 * Release every claim owned by this process. Wire this into graceful shutdown.
 */
export async function releaseOwnClaims(): Promise<void> {
  for (const dir of [CLAIMS_DIR, TARGET_CLAIMS_DIR]) {
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith(".json")) continue
      const file = path.join(dir, name)
      const claim = await readClaim(file)
      if (claim && claim.pid === process.pid && claim.hostname === HOSTNAME) {
        await rm(file, { force: true }).catch(() => {})
      }
    }
  }
}
