/**
 * cdp-auth-probe.ts — Standalone auth-state diagnostic harness for the
 * CDP-Web (M365 Copilot) provider.
 *
 * PURPOSE
 * -------
 * The provider's auth detection (checkAuth in driver-dom.ts) is suspect. To fix
 * it we need to SEE exactly what the DOM/URL look like in the logged-out / FTU /
 * session-expired states. But logging out of the primary profile would kill the
 * very Copilot session we use to iterate. So this harness drives a SEPARATE,
 * throwaway profile on a SEPARATE debug port, leaving the primary provider
 * (port 9224, primary profile) completely untouched.
 *
 * KEY DIFFERENCE FROM THE PROVIDER
 * --------------------------------
 * findCopilotTabs() only matches Copilot chat URLs. When logged out, the tab
 * redirects to login.microsoftonline.com, which that filter REJECTS — so the
 * provider would find zero tabs in exactly the state we want to inspect. This
 * harness connects to ANY page target, so it works in the redirected state.
 *
 * USAGE (run from packages/opencode)
 * ----------------------------------
 *   # Launch the test browser (headed) on port 9225 with the test profile,
 *   # then dump a full auth-state diagnostic of the frontmost page target:
 *   bun run script/cdp-auth-probe.ts
 *
 *   # Just dump state against an already-running test browser (no launch):
 *   bun run script/cdp-auth-probe.ts --no-launch
 *
 *   # Run arbitrary JS in the page and print the result (interactive handle —
 *   # this is how a coding agent can probe the logged-out DOM live):
 *   bun run script/cdp-auth-probe.ts --eval "document.title"
 *   bun run script/cdp-auth-probe.ts --eval "location.href"
 *
 *   # Navigate the test tab somewhere (e.g. force the chat URL to trigger a
 *   # login redirect when logged out):
 *   bun run script/cdp-auth-probe.ts --goto "https://m365.cloud.microsoft/chat"
 *
 * OPTIONS
 *   --port <n>       CDP port for the TEST browser        (default 9225)
 *   --profile <dir>  user-data-dir for the TEST profile    (default: <appdata>/opencode/cdp-web-profile-test)
 *   --no-launch      do not spawn a browser; attach to an already-running one
 *   --eval <expr>    Runtime.evaluate this expression, print JSON result, exit
 *   --goto <url>     navigate the selected target to <url> before probing
 *   --raw            print the full raw diagnostic JSON (no pretty summary)
 *
 * SAFETY
 *   Defaults are chosen so this NEVER touches the primary profile or port.
 *   The test profile is a genuinely separate Chromium user-data-dir — log out
 *   of it, clear it, break it: your real M365 session is unaffected.
 */
import path from "path"
import os from "os"
import { ensureBrowser } from "../src/provider/cdp-web/browser"
import { CDPClient, listTargets, type CDPTarget } from "../src/provider/cdp-web/client"

// ─── Arg parsing (tiny, dependency-free) ─────────────────────────────────────

function parseArgs(argv: string[]) {
  const out: {
    port: number
    profile: string
    launch: boolean
    eval?: string
    goto?: string
    raw: boolean
  } = {
    port: 9225,
    profile: defaultTestProfileDir(),
    launch: true,
    raw: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--port":
        out.port = Number(argv[++i])
        break
      case "--profile":
        out.profile = argv[++i]
        break
      case "--no-launch":
        out.launch = false
        break
      case "--eval":
        out.eval = argv[++i]
        break
      case "--goto":
        out.goto = argv[++i]
        break
      case "--raw":
        out.raw = true
        break
      default:
        console.error(`Unknown arg: ${a}`)
        process.exit(2)
    }
  }
  return out
}

function defaultTestProfileDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "cdp-web-profile-test")
}

// ─── Target selection (connects to ANY page, not just Copilot) ───────────────

/**
 * Pick the most relevant page target. Preference order:
 *   1. a login/auth page (login.microsoftonline.com, login.live.com, oauth)
 *   2. an m365 / copilot page
 *   3. any page target at all
 * This ordering means that in the logged-out state we lock onto the login page
 * (exactly what we want to characterize), and otherwise onto the chat.
 */
function pickTarget(targets: CDPTarget[]): CDPTarget | null {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
  if (pages.length === 0) return null
  const isLogin = (u: string) =>
    /login\.microsoftonline\.com|login\.live\.com|\/oauth|\/common\/oauth2/i.test(u)
  const isCopilot = (u: string) =>
    /m365\.cloud\.microsoft|microsoft365\.com|copilot\.microsoft\.com/i.test(u)
  return (
    pages.find((t) => isLogin(t.url || "")) ||
    pages.find((t) => isCopilot(t.url || "")) ||
    pages[0]
  )
}

// ─── The diagnostic payload (the whole point) ────────────────────────────────

/**
 * One big Runtime.evaluate that captures every signal we might use to detect
 * auth state, so we can decide empirically which are reliable. Returns a JSON
 * string (evaluated in the page) that we parse back out.
 */
const DIAGNOSTIC_JS = `
  (() => {
    const q = (sel) => { try { return !!document.querySelector(sel); } catch { return false; } }
    const txt = (sel) => { try { const e = document.querySelector(sel); return e ? (e.innerText||'').slice(0,200) : null; } catch { return null; } }
    const url = location.href;
    const host = location.hostname;

    // URL-based signals
    const urlSignals = {
      isLoginMicrosoftonline: /login\\.microsoftonline\\.com/i.test(url),
      isLoginLive: /login\\.live\\.com/i.test(url),
      isOauth: /\\/oauth|\\/common\\/oauth2/i.test(url),
      isM365Chat: /m365\\.cloud\\.microsoft\\/chat/i.test(url),
      isM365: /m365\\.cloud\\.microsoft/i.test(url),
      isCopilotCom: /copilot\\.microsoft\\.com/i.test(url),
    };

    // Composer / ready signals (what checkAuth currently keys on)
    const readySignals = {
      composerById: q('#m365-chat-editor-target-element'),
      chatInputTestid: q('[data-testid="chat-input"]'),
      contenteditableTextbox: q('[contenteditable="true"][role="textbox"]'),
      anyContenteditable: q('div[contenteditable="true"]'),
      sessionExpiredTestid: q('[data-testid="session-expired"]'),
    };

    // Login-page DOM signals (candidates for a positive "needs auth" detector)
    const loginSignals = {
      // Microsoft AAD login form field ids/names (stable across years)
      emailInput: q('input[type="email"]') || q('input[name="loginfmt"]') || q('#i0116'),
      passwordInput: q('input[type="password"]') || q('input[name="passwd"]') || q('#i0118'),
      nextButton: q('#idSIButton9') || q('input[type="submit"]'),
      pickAccountTile: q('#tilesHolder') || q('[data-test-id="accountTile"]'),
      staySignedInHeader: (txt('#login_workload_logo_text') || '') ,
      msLogo: q('img[data-bind*="logo"]') || q('.login-paginated-page'),
      title: document.title || null,
      bodyTextSample: (document.body ? (document.body.innerText||'').slice(0,300) : null),
    };

    // Coarse classification suggestion (for eyeballing only)
    let suggested = 'unknown';
    if (urlSignals.isLoginMicrosoftonline || urlSignals.isLoginLive || urlSignals.isOauth) suggested = 'login';
    else if (readySignals.sessionExpiredTestid) suggested = 'expired';
    else if (readySignals.composerById || readySignals.chatInputTestid || readySignals.contenteditableTextbox) suggested = 'ready';
    else if (loginSignals.emailInput || loginSignals.passwordInput || loginSignals.pickAccountTile) suggested = 'login-dom';

    return JSON.stringify({
      url, host,
      title: document.title || null,
      readyState: document.readyState,
      urlSignals, readySignals, loginSignals,
      suggested,
    });
  })()
`

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  console.error(`[probe] test profile : ${opts.profile}`)
  console.error(`[probe] test port    : ${opts.port}`)
  console.error(`[probe] launch       : ${opts.launch}`)

  if (opts.launch) {
    // Reuses the SHIPPED launcher — same flags, same headed behavior — but
    // pointed at the isolated test profile + port. Never touches 9224/primary.
    const port = await ensureBrowser({ port: opts.port, profileDir: opts.profile })
    console.error(`[probe] browser ready on CDP port ${port}`)
    // Give the FTU/login redirect a moment to settle after cold launch.
    await new Promise((r) => setTimeout(r, 2500))
  }

  const targets = await listTargets(opts.port)
  if (targets.length === 0) {
    console.error(
      `[probe] no CDP targets on port ${opts.port}. Is the test browser running? ` +
        `Try without --no-launch, or check the port.`,
    )
    process.exit(1)
  }

  const target = pickTarget(targets)
  if (!target || !target.webSocketDebuggerUrl) {
    console.error(`[probe] no usable page target found. Raw targets:`)
    console.error(JSON.stringify(targets, null, 2))
    process.exit(1)
  }
  console.error(`[probe] selected target: ${target.url}`)

  const wsUrl = target.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
  const client = new CDPClient(wsUrl)
  await client.connect()
  await client.send("Runtime.enable", {}).catch(() => {})

  try {
    if (opts.goto) {
      console.error(`[probe] navigating to ${opts.goto}`)
      await client.evaluate(`location.href = ${JSON.stringify(opts.goto)}`)
      await new Promise((r) => setTimeout(r, 3500))
      await client.send("Runtime.enable", {}).catch(() => {})
    }

    if (opts.eval) {
      // Interactive passthrough: run arbitrary JS, print the result. This is the
      // handle a coding agent uses to probe the logged-out DOM live via me.
      const result = await client.evaluate(opts.eval)
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2))
      return
    }

    const raw = await client.evaluate(DIAGNOSTIC_JS)
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.error("[probe] diagnostic did not return valid JSON. Raw:")
      console.log(raw)
      return
    }

    if (opts.raw) {
      console.log(JSON.stringify(parsed, null, 2))
      return
    }

    // Pretty summary for quick eyeballing; full JSON still available via --raw.
    console.log("")
    console.log("══════════════ CDP AUTH-STATE PROBE ══════════════")
    console.log(`URL         : ${parsed.url}`)
    console.log(`Host        : ${parsed.host}`)
    console.log(`Title       : ${parsed.title}`)
    console.log(`readyState  : ${parsed.readyState}`)
    console.log(`SUGGESTED   : ${parsed.suggested}`)
    console.log("── URL signals ──")
    for (const [k, v] of Object.entries(parsed.urlSignals)) console.log(`  ${v ? "✓" : " "} ${k}`)
    console.log("── Ready/composer signals ──")
    for (const [k, v] of Object.entries(parsed.readySignals)) console.log(`  ${v ? "✓" : " "} ${k}`)
    console.log("── Login-DOM signals ──")
    for (const [k, v] of Object.entries(parsed.loginSignals)) {
      const shown = typeof v === "boolean" ? (v ? "✓" : " ") : v ? `\"${String(v).slice(0, 60)}\"` : "—"
      console.log(`  ${shown === " " ? " " : shown === "✓" ? "✓" : "·"} ${k}${typeof v !== "boolean" && v ? `: ${shown}` : ""}`)
    }
    console.log("═══════════════════════════════════════════════════")
    console.log("")
    console.log("(full JSON: re-run with --raw)")
  } finally {
    await client.disconnect()
  }
}

main().catch((e) => {
  console.error("[probe] fatal:", e?.stack || e?.message || String(e))
  process.exit(1)
})
