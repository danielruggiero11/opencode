/**
 * Browser launcher and lifecycle manager.
 *
 * Launches Edge or Chrome with:
 * - --remote-debugging-port (for CDP access)
 * - --user-data-dir (persistent profile so auth cookies survive)
 *
 * The user logs in once manually; subsequent launches reuse the session.
 */
import path from "path"
import os from "os"
import { listTargets, type CDPTarget } from "./client"

const DEFAULT_PORT = 9224 // Use different port than desktop app (9223)
const COPILOT_URL = "https://m365.cloud.microsoft/chat"

// Where we store the browser profile for persistent auth
function getProfileDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "cdp-web-profile")
}

/**
 * Find the Edge or Chrome executable path.
 */
async function findBrowserPath(): Promise<string | null> {
  const candidates: string[] = []

  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files"
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")

    candidates.push(
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    )
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    )
  }

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

export interface BrowserLaunchOptions {
  port?: number
  headless?: boolean
  profileDir?: string
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

  const browserPath = await findBrowserPath()
  if (!browserPath) {
    throw new Error(
      "Could not find Edge or Chrome. Install Microsoft Edge or Google Chrome.",
    )
  }

  const profileDir = options.profileDir || getProfileDir()
  // Ensure profile dir exists
  const { mkdir } = await import("node:fs/promises")
  await mkdir(profileDir, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
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
    if (await isBrowserRunning(port)) return port
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(`Browser launched but CDP not available on port ${port} within 15s`)
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
