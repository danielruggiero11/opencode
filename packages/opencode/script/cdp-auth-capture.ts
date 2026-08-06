/**
 * cdp-auth-capture.ts - Production reauth-state capture tool.
 *
 * PURPOSE
 * -------
 * The mid-session "you need to authenticate again" popup is server-driven
 * (token expiry / Conditional Access) and effectively random. It cannot be
 * reliably reproduced in a test rig. So instead of simulating it, this tool
 * lets you CAPTURE it the moment it happens in real usage: run one command and
 * it snapshots every browser target, flags anything auth-related, and writes a
 * timestamped JSON dump to disk for later analysis.
 *
 * It scans ALL page targets (not just Copilot chat URLs) because the reauth may
 * appear as: an in-page modal on the chat tab, a full-page redirect, OR a
 * separate popup window/tab. We do not know which yet - so we capture all.
 *
 * USAGE (run from packages/opencode)
 * ----------------------------------
 *   # When you see the reauth popup in production, just run:
 *   bun run script/cdp-auth-capture.ts
 *
 *   # Point at a specific CDP port (production provider default is 9224):
 *   bun run script/cdp-auth-capture.ts --port 9224
 *
 *   # Also drop a full per-target DOM/text dump (heavier, more detail):
 *   bun run script/cdp-auth-capture.ts --deep
 *
 *   # Change where dumps are written (default: ./cdp-auth-captures):
 *   bun run script/cdp-auth-capture.ts --out C:\\some\\dir
 *
 * OUTPUT
 *   Writes cdp-auth-captures/reauth-<timestamp>.json containing, per target:
 *   url, host, title, classification, and a battery of auth-signal booleans.
 *   Prints a short summary to the console so you know it captured something.
 *
 * SAFETY
 *   Read-only. It inspects the DOM via Runtime.evaluate; it does NOT click,
 *   navigate, or submit anything. Safe to run against your live session.
 */
import path from "path"
import os from "os"
import { mkdir, writeFile } from "node:fs/promises"
import { CDPClient, listTargets, type CDPTarget } from "../src/provider/cdp-web/client"

interface Args {
  port: number
  out: string
  deep: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    port: 9224,
    out: path.join(process.cwd(), "cdp-auth-captures"),
    deep: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--port") out.port = Number(argv[++i])
    else if (a === "--out") out.out = argv[++i]
    else if (a === "--deep") out.deep = true
    else {
      console.error("Unknown arg: " + a)
      process.exit(2)
    }
  }
  return out
}

/**
 * Signal battery evaluated inside each page. Captures the full range of things
 * that might identify a reauth prompt - URL/host, the AAD login form, an Okta
 * page, an in-page "session expired" modal, a generic sign-in modal, and any
 * child frames (mid-session reauth is sometimes rendered in an iframe).
 */
const SIGNAL_JS = `
  (() => {
    const has = (sel) => { try { return !!document.querySelector(sel); } catch { return false; } }
    const t = (sel) => { try { const e = document.querySelector(sel); return e ? (e.innerText||'').slice(0,160) : null; } catch { return null; } }
    const host = location.hostname;
    const url = location.href;

    const isMsLogin = /login\\.microsoftonline\\.com/i.test(host);
    const isMsaLogin = /login\\.live\\.com/i.test(host);
    const isOkta = /okta\\.com|okta-emea|oktapreview/i.test(host);
    const isM365 = /m365\\.cloud\\.microsoft/i.test(host);

    // AAD login form (top document)
    const aadEmail = has('input[type="email"]') || has('input[name="loginfmt"]') || has('#i0116');
    const aadPassword = has('input[type="password"]') || has('input[name="passwd"]') || has('#i0118');
    const aadNext = has('#idSIButton9');
    const pickAccount = has('#tilesHolder') || has('[data-test-id="accountTile"]');

    // Okta form
    const oktaForm = has('#okta-sign-in') || has('form[data-se="o-form"]') || has('input[name="identifier"]');

    // In-page reauth / session modals (candidates - we are still learning these)
    const sessionExpired = has('[data-testid="session-expired"]');
    const genericDialog = has('[role="dialog"]');
    const dialogText = t('[role="dialog"]');
    const reauthWord = /sign in again|reauthenticate|re-authenticate|session (has )?expired|you.?re signed out|please sign in|authenticate again/i;
    const bodyText = document.body ? (document.body.innerText||'') : '';
    const bodyHasReauthWord = reauthWord.test(bodyText);
    const dialogHasReauthWord = !!dialogText && reauthWord.test(dialogText);

    // Ready (authed) signal
    const composer = has('#m365-chat-editor-target-element');

    // Child frames (reauth sometimes lives in an iframe the top doc cannot query)
    const frameCount = window.frames.length;
    const frameSrcs = [];
    try {
      const ifr = [...document.querySelectorAll('iframe')];
      for (const f of ifr) frameSrcs.push(f.src || '(no src)');
    } catch (e) {}

    // Coarse classification
    let classification = 'unknown';
    if (composer && !genericDialog) classification = 'ready';
    else if (isMsLogin || isMsaLogin) classification = 'ms-login';
    else if (isOkta || oktaForm) classification = 'okta-login';
    else if (sessionExpired || dialogHasReauthWord || (isM365 && genericDialog && bodyHasReauthWord)) classification = 'reauth-modal';
    else if (pickAccount) classification = 'pick-account';

    return JSON.stringify({
      url, host, title: document.title || null, readyState: document.readyState,
      classification,
      signals: {
        isMsLogin, isMsaLogin, isOkta, isM365,
        aadEmail, aadPassword, aadNext, pickAccount,
        oktaForm,
        sessionExpired, genericDialog, bodyHasReauthWord, dialogHasReauthWord,
        composer,
        frameCount,
      },
      dialogText,
      frameSrcs,
      bodySample: bodyText.slice(0, 400),
    });
  })()
`

function classifyTargetUrl(u: string): string {
  const s = (u || "").toLowerCase()
  if (/login\\.microsoftonline\\.com|login\\.live\\.com/.test(s)) return "login"
  if (/okta/.test(s)) return "okta"
  if (/m365\\.cloud\\.microsoft|microsoft365\\.com|copilot\\.microsoft\\.com/.test(s)) return "copilot"
  return "other"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  console.error("[capture] port : " + args.port)
  console.error("[capture] out  : " + args.out)

  const targets = await listTargets(args.port)
  const pages = targets.filter((tg) => tg.type === "page" && tg.webSocketDebuggerUrl)
  if (pages.length === 0) {
    console.error("[capture] no page targets on port " + args.port + ". Is the browser running on that port?")
    process.exit(1)
  }
  console.error("[capture] found " + pages.length + " page target(s); probing each...")

  const results: Array<Record<string, unknown>> = []

  for (const tg of pages) {
    const entry: Record<string, unknown> = {
      targetId: tg.id,
      targetUrl: tg.url,
      targetTitle: tg.title,
      urlClass: classifyTargetUrl(tg.url),
    }
    const wsUrl = tg.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
    const client = new CDPClient(wsUrl)
    try {
      await client.connect()
      await client.send("Runtime.enable", {}).catch(() => {})
      const raw = await client.evaluate(SIGNAL_JS)
      try {
        entry.probe = JSON.parse(raw)
      } catch {
        entry.probeRaw = raw
      }
      if (args.deep) {
        entry.deepHtmlHead = await client
          .evaluate("document.documentElement.outerHTML.slice(0, 4000)")
          .catch(() => null)
      }
    } catch (e) {
      entry.error = (e as Error).message
    } finally {
      await client.disconnect().catch(() => {})
    }
    results.push(entry)
  }

  await mkdir(args.out, { recursive: true })
  const file = path.join(args.out, "reauth-" + stamp + ".json")
  await writeFile(file, JSON.stringify({ capturedAt: stamp, port: args.port, results }, null, 2), "utf8")

  // Console summary
  console.log("")
  console.log("============== REAUTH CAPTURE ==============")
  for (const r of results) {
    const probe = r.probe as any
    const cls = probe ? probe.classification : "(probe failed)"
    console.log("- [" + r.urlClass + "] " + cls + "  <- " + String(r.targetUrl).slice(0, 70))
    if (probe && probe.classification === "reauth-modal") {
      console.log("    dialogText: " + (probe.dialogText || "(none)"))
    }
  }
  console.log("============================================")
  console.log("saved: " + file)
  console.log("")
  console.log("Send me that file (or paste it) and I'll characterize the reauth DOM.")
}

main().catch((e) => {
  console.error("[capture] fatal: " + (e?.stack || e?.message || String(e)))
  process.exit(1)
})
