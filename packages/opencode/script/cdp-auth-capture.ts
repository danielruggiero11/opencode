/**
 * cdp-auth-capture.ts - Production reauth-state capture tool.
 *
 * PURPOSE
 * -------
 * The mid-session "you need to authenticate" popup is server-driven (token
 * expiry / Conditional Access) and effectively random. It cannot be reliably
 * reproduced in a test rig. So instead of simulating it, this tool CAPTURES it
 * the moment it happens in real usage: run one command and it snapshots every
 * browser target, descends into child frames, watches the network for a few
 * seconds, flags anything auth-related, and writes a timestamped JSON dump to
 * disk for later analysis.
 *
 * ============================================================================
 * FINDINGS LOG (read before changing detection logic)
 * ============================================================================
 * CAPTURE #1 - reauth-2026-08-07T13-25-24-441Z.json
 *   The top document looked FULLY HEALTHY during the reauth:
 *     classification="ready", composer=true, genericDialog=false,
 *     sessionExpired=false, bodyHasReauthWord=false, URL still
 *     m365.cloud.microsoft/chat (no redirect).
 *   => The existing checkAuth() in driver-dom.ts returns TRUE on this page
 *      (composer present, not a login URL), so the auth gate never opens.
 *   The ONLY auth artifact was a hidden iframe:
 *     login.microsoftonline.com/savedusers?...&idpflag=proxy
 *   That is MSAL's SILENT token-renewal iframe. It appears during perfectly
 *   healthy sessions too, so "a login iframe exists" is NOT a reliable reauth
 *   signal on its own. Capture #1 did not contain a decisive signal because
 *   the original SIGNAL_JS never looked where the signal actually lives.
 *
 * USER REPORT (grounding for this rewrite):
 *   The real mid-session reauth is a VISIBLE POPUP whose text is roughly
 *   "You need to authenticate". So the decisive signal is popup/dialog TEXT,
 *   which the original phrase regex did not include and which may be rendered
 *   inside a dialog / overlay / shadow root rather than plain document.body.
 *
 * WHAT THIS REWRITE ADDS (so we actually catch it next time):
 *   1. Expanded reauth phrase list (incl. "you need to authenticate").
 *   2. Deep popup scan: walks [role=dialog]/[role=alertdialog], fixed/high
 *      z-index overlays, AND open shadow roots; records matched text, button
 *      labels, and a selector hint so we can later target it for auto-resume.
 *   3. Child execution contexts: enables Runtime and probes EVERY execution
 *      context (same-process login iframes) with the AAD-form battery.
 *   4. Cross-origin/OOPIF login targets: probes non-page targets (type
 *      "iframe", or any target whose URL is an auth host) that expose their
 *      own webSocketDebuggerUrl.
 *   5. Page.getFrameTree dump: full frame hierarchy with URLs.
 *   6. Network watch: records requests/responses to login.microsoftonline.com
 *      / login.live.com / okta during an observation window, flagging
 *      interaction_required / login_required (the unambiguous "needs UI"
 *      outcome of a failed silent renewal).
 *   7. Two snapshots (A immediately, B after --watch seconds) to catch the
 *      transition if the popup is still animating in.
 *   8. composerEnabled (not just composerPresent) - a frozen-but-present
 *      composer is a corroborating signal.
 *
 * HOW THIS FEEDS THE FIX (unified pause, same message as FTU):
 *   The pause/resume machinery ALREADY EXISTS and is origin-agnostic:
 *     - waitForAuth()            model.ts ~750  (polls up to 5 min, resumes turn)
 *     - authNoticeText banner    model.ts ~535  (the on-screen "Login required")
 *     - pre-send checkAuth gate  model.ts ~1072 (mid-turn entry point)
 *   Today that gate only opens when checkAuth() returns false, and checkAuth()
 *   returns TRUE during this popup. Plan: add checkReauth() keyed on the popup
 *   text/signals this tool confirms, and OR it into the model.ts ~1072 gate so
 *   the SAME waitForAuth pause + banner + auto-resume fires for mid-session
 *   reauth exactly as it does for first-time login.
 * ============================================================================
 *
 * USAGE (run from packages/opencode)
 * ----------------------------------
 *   # When you see the reauth popup in production, just run:
 *   bun run script/cdp-auth-capture.ts
 *
 *   # Point at a specific CDP port (production provider default is 9224):
 *   bun run script/cdp-auth-capture.ts --port 9224
 *
 *   # Observe the network / re-scan for N seconds (default 4) to catch the
 *   # popup transition and any interaction_required response:
 *   bun run script/cdp-auth-capture.ts --watch 6
 *
 *   # Also drop a full per-target DOM/text dump (heavier, more detail):
 *   bun run script/cdp-auth-capture.ts --deep
 *
 *   # Change where dumps are written (default: ./cdp-auth-captures):
 *   bun run script/cdp-auth-capture.ts --out C:\\some\\dir
 *
 * OUTPUT
 *   Writes cdp-auth-captures/reauth-<timestamp>.json containing, per target:
 *   url, host, title, classification, the top-doc signal battery, a deep popup
 *   scan, per-execution-context probes, the frame tree, and a network log of
 *   auth-host traffic. Snapshots A and B bracket the observation window.
 *
 * SAFETY
 *   Read-only. It inspects the DOM via Runtime.evaluate and listens to Network
 *   events; it does NOT click, navigate, or submit anything. Safe to run
 *   against your live session.
 */
import path from "path"
import { mkdir, writeFile } from "node:fs/promises"
import { CDPClient, listTargets, type CDPTarget } from "../src/provider/cdp-web/client"

interface Args {
  port: number
  out: string
  deep: boolean
  watch: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    port: 9224,
    out: path.join(process.cwd(), "cdp-auth-captures"),
    deep: false,
    watch: 4,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--port") out.port = Number(argv[++i])
    else if (a === "--out") out.out = argv[++i]
    else if (a === "--watch") out.watch = Number(argv[++i])
    else if (a === "--deep") out.deep = true
    else {
      console.error("Unknown arg: " + a)
      process.exit(2)
    }
  }
  return out
}

/** Auth hosts we care about for target selection + network filtering. */
const AUTH_HOST_RE = /login\.microsoftonline\.com|login\.live\.com|okta\.com|okta-emea|oktapreview|msauth|msftauth/i

/**
 * Signal battery evaluated inside a document/context. Captures URL/host, the
 * AAD login form, an Okta page, an in-page "you need to authenticate" popup
 * (via a deep scan that walks dialogs, fixed overlays, AND open shadow roots),
 * composer presence + enabled-state, and child-frame srcs.
 *
 * NOTE: reauth phrase list is intentionally broad and INCLUDES the user-
 * reported "you need to authenticate". If you see a new wording in a capture,
 * add it here.
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

    // AAD login form
    const aadEmail = has('input[type=\"email\"]') || has('input[name=\"loginfmt\"]') || has('#i0116');
    const aadPassword = has('input[type=\"password\"]') || has('input[name=\"passwd\"]') || has('#i0118');
    const aadNext = has('#idSIButton9');
    const pickAccount = has('#tilesHolder') || has('[data-test-id=\"accountTile\"]');

    // Okta form
    const oktaForm = has('#okta-sign-in') || has('form[data-se=\"o-form\"]') || has('input[name=\"identifier\"]');

    // ── Reauth phrase battery (USER-REPORTED wording included) ──────────────
    const reauthWord = /you need to authenticate|you need to sign ?in|authentication required|authenticate again|re-?authenticate|session (has )?expired|your session (has )?ended|you.?re signed out|you have been signed out|please sign ?in|verify your identity|sign ?in again|token expired/i;

    // ── Deep popup scan: dialogs, fixed/high-z overlays, and shadow roots ───
    // Returns the reauth-matching popups we can find anywhere in the render
    // tree, with enough detail (text, buttons, selector hint) to later target
    // the popup for auto-resume.
    const cssPath = (el) => {
      try {
        const parts = [];
        let e = el;
        for (let depth = 0; e && e.nodeType === 1 && depth < 5; depth++) {
          let s = e.tagName.toLowerCase();
          if (e.id) { s += '#' + e.id; parts.unshift(s); break; }
          const dt = e.getAttribute && (e.getAttribute('data-testid') || e.getAttribute('data-test-id'));
          if (dt) s += '[data-testid=\"' + dt + '\"]';
          const role = e.getAttribute && e.getAttribute('role');
          if (role) s += '[role=\"' + role + '\"]';
          parts.unshift(s);
          e = e.parentElement;
        }
        return parts.join(' > ');
      } catch { return null; }
    };
    const buttonsIn = (el) => {
      try {
        return [...el.querySelectorAll('button, a[role=\"button\"], [role=\"button\"], input[type=\"submit\"]')]
          .map(b => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim())
          .filter(Boolean).slice(0, 8);
      } catch { return []; }
    };
    const scanRoot = (root, acc, depth) => {
      if (!root || depth > 8) return;
      let candidates = [];
      try {
        candidates = [...root.querySelectorAll(
          '[role=\"dialog\"],[role=\"alertdialog\"],[aria-modal=\"true\"],.ms-Dialog,.ms-Modal,.fui-DialogSurface'
        )];
      } catch {}
      // Also consider fixed / very-high z-index overlays (popup containers).
      try {
        for (const el of root.querySelectorAll('div,section')) {
          const cs = getComputedStyle(el);
          const z = parseInt(cs.zIndex || '0', 10);
          if ((cs.position === 'fixed' || cs.position === 'absolute') && z >= 1000 && el.offsetParent !== null) {
            candidates.push(el);
          }
        }
      } catch {}
      for (const el of candidates) {
        const text = (el.innerText || '').trim();
        if (!text) continue;
        const matched = reauthWord.test(text);
        // Record any modal-ish thing, but flag whether it matched a reauth phrase.
        acc.push({
          matched,
          role: el.getAttribute('role') || (getComputedStyle(el).position === 'fixed' ? 'overlay' : 'block'),
          text: text.slice(0, 300),
          buttons: buttonsIn(el),
          selector: cssPath(el),
          zIndex: parseInt(getComputedStyle(el).zIndex || '0', 10) || 0,
        });
      }
      // Descend into open shadow roots (Fluent/web-components render here).
      try {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) scanRoot(el.shadowRoot, acc, depth + 1);
        }
      } catch {}
    };
    const popups = [];
    try { scanRoot(document, popups, 0); } catch (e) {}
    // De-dupe by text, keep matched ones first.
    const seen = new Set();
    const dedupPopups = [];
    for (const p of popups.sort((a,b) => (b.matched?1:0)-(a.matched?1:0))) {
      const k = p.text.slice(0, 80);
      if (seen.has(k)) continue;
      seen.add(k);
      dedupPopups.push(p);
      if (dedupPopups.length >= 8) break;
    }
    const reauthPopups = dedupPopups.filter(p => p.matched);

    // Legacy flat signals (kept for continuity with capture #1).
    const sessionExpired = has('[data-testid=\"session-expired\"]');
    const genericDialog = has('[role=\"dialog\"]') || has('[role=\"alertdialog\"]');
    const dialogText = t('[role=\"dialog\"]') || t('[role=\"alertdialog\"]');
    const bodyText = document.body ? (document.body.innerText||'') : '';
    const bodyHasReauthWord = reauthWord.test(bodyText);
    const dialogHasReauthWord = !!dialogText && reauthWord.test(dialogText);

    // Ready (authed) signal — present AND enabled.
    const composerEl = document.getElementById('m365-chat-editor-target-element')
      || document.querySelector('[data-testid=\"chat-input\"]')
      || document.querySelector('[contenteditable=\"true\"][role=\"textbox\"]');
    const composer = !!composerEl;
    let composerEnabled = false;
    try {
      if (composerEl) {
        const ce = composerEl.getAttribute('contenteditable');
        const disabled = composerEl.getAttribute('aria-disabled') === 'true' || ce === 'false';
        const sendBtn = document.querySelector('button[aria-label*=\"Send\" i]');
        const sendDisabled = sendBtn ? (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') : false;
        composerEnabled = !disabled && !sendDisabled;
      }
    } catch {}

    // Child frames (reauth sometimes lives in an iframe the top doc cannot query)
    const frameCount = window.frames.length;
    const frameSrcs = [];
    try {
      const ifr = [...document.querySelectorAll('iframe')];
      for (const f of ifr) frameSrcs.push(f.src || '(no src)');
    } catch (e) {}

    // Coarse classification (reauth-popup now wins when phrase text is found).
    let classification = 'unknown';
    if (reauthPopups.length > 0) classification = 'reauth-popup';
    else if (isMsLogin || isMsaLogin) classification = 'ms-login';
    else if (isOkta || oktaForm) classification = 'okta-login';
    else if (sessionExpired || dialogHasReauthWord) classification = 'reauth-modal';
    else if (bodyHasReauthWord) classification = 'reauth-text';
    else if (pickAccount) classification = 'pick-account';
    else if (composer && composerEnabled) classification = 'ready';
    else if (composer && !composerEnabled) classification = 'ready-but-frozen';

    return JSON.stringify({
      url, host, title: document.title || null, readyState: document.readyState,
      classification,
      signals: {
        isMsLogin, isMsaLogin, isOkta, isM365,
        aadEmail, aadPassword, aadNext, pickAccount,
        oktaForm,
        sessionExpired, genericDialog, bodyHasReauthWord, dialogHasReauthWord,
        composer, composerEnabled,
        frameCount,
      },
      dialogText,
      reauthPopups,
      popups: dedupPopups,
      frameSrcs,
      bodySample: bodyText.slice(0, 400),
    });
  })()
`

function classifyTargetUrl(u: string): string {
  const s = (u || "").toLowerCase()
  if (/login\.microsoftonline\.com|login\.live\.com/.test(s)) return "login"
  if (/okta/.test(s)) return "okta"
  if (/m365\.cloud\.microsoft|microsoft365\.com|copilot\.microsoft\.com/.test(s)) return "copilot"
  return "other"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Run the signal battery in a specific execution context (or the top doc). */
async function probeContext(client: CDPClient, contextId?: number): Promise<unknown> {
  const params: Record<string, unknown> = {
    expression: SIGNAL_JS,
    returnByValue: true,
    awaitPromise: false,
  }
  if (contextId !== undefined) params.contextId = contextId
  const res = await client.send("Runtime.evaluate", params)
  const raw = res?.result?.value
  try {
    return JSON.parse(raw)
  } catch {
    return { probeRaw: raw ?? null }
  }
}

/**
 * Probe a single target: connect, enable Runtime/Page/Network with listeners,
 * take snapshot A, observe for `watch` seconds (collecting auth-host network
 * traffic and re-scanning), take snapshot B, dump exec-context probes + frame
 * tree, then disconnect.
 */
async function probeTarget(tg: CDPTarget, args: Args): Promise<Record<string, unknown>> {
  const entry: Record<string, unknown> = {
    targetId: tg.id,
    targetType: tg.type,
    targetUrl: tg.url,
    targetTitle: tg.title,
    urlClass: classifyTargetUrl(tg.url),
  }
  const wsUrl = tg.webSocketDebuggerUrl!.replace("localhost", "127.0.0.1")
  const client = new CDPClient(wsUrl)

  // Collectors for events.
  const execContexts: Array<{ id: number; origin: string; name: string; frameId?: string }> = []
  const network: Array<Record<string, unknown>> = []
  const requestsById = new Map<string, Record<string, unknown>>()

  const onCtx = (p: any) => {
    const c = p?.context
    if (!c) return
    execContexts.push({ id: c.id, origin: c.origin, name: c.name, frameId: c.auxData?.frameId })
  }
  const onReq = (p: any) => {
    const url: string = p?.request?.url || ""
    if (!AUTH_HOST_RE.test(url)) return
    const rec: Record<string, unknown> = {
      requestId: p.requestId,
      phase: "request",
      method: p?.request?.method,
      url: url.slice(0, 300),
      // The interaction_required / login_required outcome sometimes rides in the
      // redirect/query of the silent-renew request.
      interactionRequired: /error=interaction_required|error=login_required|prompt=login|reason=/i.test(url),
    }
    requestsById.set(p.requestId, rec)
    network.push(rec)
  }
  const onResp = (p: any) => {
    const url: string = p?.response?.url || ""
    if (!AUTH_HOST_RE.test(url)) return
    network.push({
      requestId: p.requestId,
      phase: "response",
      status: p?.response?.status,
      statusText: p?.response?.statusText,
      url: url.slice(0, 300),
      interactionRequired: /error=interaction_required|error=login_required/i.test(url),
    })
  }

  try {
    await client.connect()

    // Register listeners BEFORE enabling domains so the enable-time replay of
    // executionContextCreated is captured.
    client.on("Runtime.executionContextCreated", onCtx)
    client.on("Network.requestWillBeSent", onReq)
    client.on("Network.responseReceived", onResp)

    await client.send("Runtime.enable", {}).catch(() => {})
    await client.send("Page.enable", {}).catch(() => {})
    await client.send("Network.enable", {}).catch(() => {})
    await sleep(400) // let context replay land

    // Snapshot A — top document, immediately.
    entry.snapshotA = await probeContext(client).catch((e) => ({ error: (e as Error).message }))

    // Frame tree (URLs of every child frame, incl. the login iframe).
    try {
      const tree = await client.send("Page.getFrameTree", {})
      entry.frameTree = summarizeFrameTree(tree?.frameTree)
    } catch (e) {
      entry.frameTreeError = (e as Error).message
    }

    // Observation window: catch the popup transition + network outcome.
    await sleep(Math.max(0, args.watch) * 1000)

    // Snapshot B — top document, after the window.
    entry.snapshotB = await probeContext(client).catch((e) => ({ error: (e as Error).message }))

    // Probe EVERY execution context (same-process login iframes show up here).
    const ctxProbes: Array<Record<string, unknown>> = []
    for (const ctx of execContexts) {
      const probe = await probeContext(client, ctx.id).catch((e) => ({ error: (e as Error).message }))
      ctxProbes.push({ context: ctx, probe })
    }
    entry.contextProbes = ctxProbes
    entry.network = network

    if (args.deep) {
      entry.deepHtmlHead = await client
        .evaluate("document.documentElement.outerHTML.slice(0, 6000)")
        .catch(() => null)
    }
  } catch (e) {
    entry.error = (e as Error).message
  } finally {
    client.off("Runtime.executionContextCreated", onCtx)
    client.off("Network.requestWillBeSent", onReq)
    client.off("Network.responseReceived", onResp)
    await client.disconnect().catch(() => {})
  }
  return entry
}

/** Flatten Page.getFrameTree into {url, name, childFrames} we can read at a glance. */
function summarizeFrameTree(node: any): unknown {
  if (!node) return null
  const f = node.frame || {}
  return {
    url: (f.url || "").slice(0, 200),
    name: f.name || null,
    securityOrigin: f.securityOrigin || null,
    childFrames: Array.isArray(node.childFrames) ? node.childFrames.map(summarizeFrameTree) : [],
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  console.error("[capture] port  : " + args.port)
  console.error("[capture] out   : " + args.out)
  console.error("[capture] watch : " + args.watch + "s")

  const targets = await listTargets(args.port)
  // Probe page targets AND any auth-host / iframe targets that expose their own
  // ws url (cross-origin OOPIF login frames land here, not in the page's own
  // Runtime contexts).
  const probeable = targets.filter((tg) => {
    if (!tg.webSocketDebuggerUrl) return false
    if (tg.type === "page") return true
    if (tg.type === "iframe") return true
    return AUTH_HOST_RE.test(tg.url || "")
  })

  if (probeable.length === 0) {
    console.error("[capture] no probeable targets on port " + args.port + ". Is the browser running on that port?")
    process.exit(1)
  }
  console.error("[capture] found " + probeable.length + " target(s); probing each (this takes ~" + (args.watch + 1) + "s each)...")

  const results: Array<Record<string, unknown>> = []
  for (const tg of probeable) {
    results.push(await probeTarget(tg, args))
  }

  await mkdir(args.out, { recursive: true })
  const file = path.join(args.out, "reauth-" + stamp + ".json")
  await writeFile(
    file,
    JSON.stringify({ capturedAt: stamp, port: args.port, watchSeconds: args.watch, results }, null, 2),
    "utf8",
  )

  // ── Console summary ──────────────────────────────────────────────────────
  console.log("")
  console.log("============== REAUTH CAPTURE ==============")
  let sawReauth = false
  for (const r of results) {
    const a = r.snapshotA as any
    const b = r.snapshotB as any
    const cls = (b && b.classification) || (a && a.classification) || "(probe failed)"
    console.log("- [" + r.urlClass + "/" + r.targetType + "] " + cls + "  <- " + String(r.targetUrl).slice(0, 70))

    const popups = (b && b.reauthPopups) || (a && a.reauthPopups) || []
    for (const p of popups) {
      sawReauth = true
      console.log("    POPUP TEXT : " + String(p.text).replace(/\\n/g, " ").slice(0, 120))
      if (p.buttons && p.buttons.length) console.log("    POPUP BTNS : " + p.buttons.join(" | "))
      if (p.selector) console.log("    SELECTOR   : " + p.selector)
    }

    const ctxs = (r.contextProbes as any[]) || []
    for (const c of ctxs) {
      const cp = c.probe || {}
      if (cp.classification && cp.classification !== "ready" && cp.classification !== "unknown") {
        console.log("    CTX [" + (c.context?.origin || "?") + "] -> " + cp.classification)
      }
    }

    const net = (r.network as any[]) || []
    const ir = net.filter((n) => n.interactionRequired)
    if (ir.length) {
      sawReauth = true
      console.log("    NET interaction_required x" + ir.length + " (see network[] in dump)")
    } else if (net.length) {
      console.log("    NET auth-host requests: " + net.length)
    }
  }
  console.log("============================================")
  console.log(sawReauth ? "DECISIVE SIGNAL captured ✅" : "No decisive reauth signal in this run ⚠️  (was the popup showing?)")
  console.log("saved: " + file)
  console.log("")
  console.log("Send me that file and I'll wire checkReauth() into the model.ts pre-send gate.")
}

main().catch((e) => {
  console.error("[capture] fatal: " + (e?.stack || e?.message || String(e)))
  process.exit(1)
})
