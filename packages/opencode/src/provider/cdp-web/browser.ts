/**
 * Browser launcher and lifecycle manager.
 *
 * Launches Chrome (preferred) or Edge with:
 * - --remote-debugging-port (for CDP access)
 * - --user-data-dir (persistent profile so auth cookies survive)
 *
 * The user logs in once manually; subsequent launches reuse the session.
 */
import path from "path"
import os from "os"
import { CDPClient, listTargets, type CDPTarget } from "./client"

const DEFAULT_PORT = 9224 // Use different port than desktop app (9223)
const COPILOT_URL = "https://m365.cloud.microsoft/chat"

// Tracks the headless/headed mode the CURRENTLY-running browser was launched in,
// per port. This is the source of truth for the Layer 2 auth swap: when a
// headless working browser needs an (always-headed) login, we compare desired vs
// actual mode to decide whether a close+relaunch swap is required. null = we did
// not launch it / mode unknown.
const launchedHeadlessByPort = new Map<number, boolean>()

// Where we store the browser profile for persistent auth
function getProfileDir(browser: BrowserChoice = "chrome"): string {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config")
  // Chrome and Edge profiles are NOT interchangeable formats, so key the default
  // dir on the browser. This also means switching to Chrome automatically starts
  // from a clean, separate profile instead of reusing the Edge-shaped one — no
  // manual deletion needed for a from-scratch FTU.
  const dir = browser === "edge" ? "cdp-web-profile-edge" : "cdp-web-profile-chrome"
  return path.join(base, "opencode", dir)
}

/**
 * Find the Edge or Chrome executable path.
 */
async function findBrowserPath(choice: BrowserChoice = "chrome"): Promise<string | null> {
  const edge: string[] = []
  const chrome: string[] = []

  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files"
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")

    edge.push(
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    )
    chrome.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    )
  } else if (process.platform === "darwin") {
    edge.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
    chrome.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  } else {
    edge.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable")
    chrome.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    )
  }

  // Order candidates by the requested choice. "chrome" and "auto" both prefer
  // Chrome (clean identity isolation); "edge" prefers Edge. The other browser
  // remains a fallback so a missing preferred browser still launches something.
  const candidates = choice === "edge" ? [...edge, ...chrome] : [...chrome, ...edge]

  const { access } = await import("node:fs/promises")
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

let browserProc: { kill: () => void } | null = null
let browserPort: number = DEFAULT_PORT

export type BrowserChoice = "chrome" | "edge" | "auto"

export interface BrowserLaunchOptions {
  port?: number
  headless?: boolean
  profileDir?: string
  /**
   * Optional Chrome/Edge --profile-directory value (e.g. "Default"). Only
   * meaningful when profileDir points at a real browser User Data root that
   * contains named profiles. Lets us target the user's real trusted profile.
   */
  profileDirectory?: string
  /**
   * Which browser to launch. Defaults to "chrome" for clean identity isolation:
   * Edge silently adopts the machine's Windows/Microsoft identity (WAM token
   * broker), which pollutes the automation profile with the wrong account and
   * synced extensions. Chrome has no such OS integration, so a fresh profile
   * genuinely starts empty. "auto" also prefers Chrome.
   */
  browser?: BrowserChoice
}

/**
 * Check if a browser with CDP is already running on the given port.
 */
export async function isBrowserRunning(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const targets = await listTargets(port)
    return targets.length > 0
  } catch {
    return false
  }
}

/**
 * Launch the browser if not already running.
 * Returns the CDP port to connect to.
 */
export async function ensureBrowser(options: BrowserLaunchOptions = {}): Promise<number> {
  const port = options.port || DEFAULT_PORT
  browserPort = port

  // Check if already running
  if (await isBrowserRunning(port)) return port

  const choice: BrowserChoice = options.browser || "chrome"
  const browserPath = await findBrowserPath(choice)
  if (!browserPath) {
    throw new Error(
      "Could not find Chrome or Edge. Install Google Chrome or Microsoft Edge.",
    )
  }

  const profileDir = options.profileDir || getProfileDir(choice)
  // Ensure profile dir exists
  const { mkdir } = await import("node:fs/promises")
  await mkdir(profileDir, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    ...(options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    // Identity/profile isolation: keep the automation profile clean and
    // deterministic. --disable-sync stops the browser hydrating the user's
    // synced account + extensions; --disable-extensions keeps the DOM free of
    // third-party content scripts that could alter Copilot's page and break
    // selectors. Both are stable, well-supported flags on Chrome and Edge.
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    COPILOT_URL,
  ]

  if (options.headless) {
    args.unshift("--headless=new")
  }

  const { spawn } = await import("node:child_process")
  const proc = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  })
  proc.unref()
  browserProc = proc

  // Wait for CDP to become available
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await isBrowserRunning(port)) {
      launchedHeadlessByPort.set(port, !!options.headless)
      return port
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(`Browser launched but CDP not available on port ${port} within 15s`)
}

/**
 * The headless/headed mode the running browser on `port` was launched in, or
 * null if we did not launch it (mode unknown). Used by the Layer 2 auth swap.
 */
export function getLaunchedHeadless(port = DEFAULT_PORT): boolean | null {
  return launchedHeadlessByPort.has(port) ? launchedHeadlessByPort.get(port)! : null
}

/**
 * Gracefully close the browser on `port` and WAIT until the debug port is dead
 * and the profile lock is released.
 *
 * Why graceful (CDP Browser.close) rather than proc.kill(): a SIGKILL can leave
 * the Chromium profile lock (SingletonLock / LOCK) held for a moment and risks
 * not flushing cookies — exactly the auth state we are trying to preserve across
 * the swap. Browser.close asks Chromium to shut down cleanly. We still kill the
 * tracked process as a backstop, then poll the port until it stops answering and
 * add a short delay so the OS releases the profile directory lock before any
 * relaunch reuses the same --user-data-dir.
 */
export async function closeBrowser(port = DEFAULT_PORT): Promise<boolean> {
  // Phase 1: ask Chromium to shut down GRACEFULLY and WAIT for it to exit.
  // Browser.close only ACKS the command; Chromium then needs time to flush its
  // durable state (crucially the persistent auth cookie, e.g. ESTSAUTHPERSISTENT)
  // to the profile on disk before the process exits. Previously we fired
  // proc.kill() immediately after Browser.close, hard-killing Chromium mid-flush
  // — that produced the "browser closed unexpectedly" crash bubble AND lost the
  // auth cookie, forcing reauth on every relaunch. So here we send Browser.close
  // and then POLL the port until it dies on its own, giving the flush time to
  // complete. We only escalate to kill() if graceful exit does not happen.
  let gracefulRequested = false
  try {
    const verRes = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })
    const ver = (await verRes.json()) as { webSocketDebuggerUrl?: string }
    const browserWs = ver.webSocketDebuggerUrl?.replace("localhost", "127.0.0.1")
    if (browserWs) {
      const client = new CDPClient(browserWs)
      await client.connect()
      try {
        await client.send("Browser.close")
        gracefulRequested = true
      } finally {
        await client.disconnect().catch(() => {})
      }
    }
  } catch {
    // Graceful path unavailable (browser already gone, or no browser ws).
  }

  // If we asked Chromium to close, wait UP TO 12s for it to exit cleanly on its
  // own. A clean exit is what flushes cookies and avoids the crash bubble.
  if (gracefulRequested) {
    const gentleDeadline = Date.now() + 12000
    while (Date.now() < gentleDeadline) {
      if (!(await isBrowserRunning(port))) {
        // Clean exit. Drop our handle (do NOT kill), let the OS release the
        // profile lock, then report success.
        browserProc = null
        launchedHeadlessByPort.delete(port)
        await new Promise((r) => setTimeout(r, 2000))
        return true
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    // Fell through: graceful close did not exit in time. Escalate below.
  }

  // Phase 2: escalation. Only reached if graceful close was unavailable or did
  // not exit in time. Kill the process we spawned as a last resort. This path
  // risks an unflushed cookie, but it is strictly better than hanging.
  if (browserProc) {
    try {
      browserProc.kill()
    } catch {
      // ignore
    }
    browserProc = null
  }

  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (!(await isBrowserRunning(port))) {
      launchedHeadlessByPort.delete(port)
      await new Promise((r) => setTimeout(r, 2000))
      return true
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  // Port still answering — report failure so the caller can abort the swap
  // rather than launch a second browser onto a locked profile.
  return false
}

/**
 * Open a new tab to the Copilot chat URL.
 * Returns the target info for the new tab.
 */
export async function openCopilotTab(port = DEFAULT_PORT): Promise<CDPTarget | null> {
  // Chrome's /json/new endpoint reads the raw URL after the "?"
  // Do NOT encodeURIComponent — Chrome expects the literal URL
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/json/new?${COPILOT_URL}`,
      { signal: AbortSignal.timeout(10000) },
    )
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Get the current CDP port.
 */
export function getBrowserPort(): number {
  return browserPort
}

/**
 * Kill the browser process (for cleanup).
 */
export function killBrowser(): void {
  if (browserProc) {
    browserProc.kill()
    browserProc = null
  }
}
