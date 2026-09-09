/**
 * driver-word.ts – Word Online Copilot bootstrap (engine="word").
 *
 * Word Online embeds the Copilot ("Chat with Copilot") pane in a nested
 * cross-origin OOPIF. These helpers open that pane on the top document, resolve
 * the Copilot frame's CDP sessionId, and drive frame-local actions that the
 * shared driver-dom functions don't cover (new chat). Once the frame is
 * resolved and set as the client's `defaultSessionId`, the SAME driver-dom
 * functions (checkComposer, sendPrompt, awaitResponse, extractResponseRaw) run
 * against the Copilot OOPIF unchanged — see model.ts.
 *
 * All selectors are identical to the m365/desktop BizChat component; the only
 * difference is that they resolve INSIDE the Copilot OOPIF rather than the top
 * document. Empirically proven Sep 4 2026 on a live Word tab (plan doc §
 * "Empirically Proven").
 */
import { CDPClient } from "./client"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "cdp-web" })
function _fmt(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}
function dlog(...args: unknown[]): void {
  log.error(args.map(_fmt).join(" "))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** The BizChat composer id — present only inside the Copilot OOPIF once mounted. */
export const COPILOT_COMPOSER_ID = "m365-chat-editor-target-element"

/**
 * JS expression (truthy on match) used with client.waitForFrameSession to find
 * the Copilot OOPIF: the frame whose document holds the BizChat composer.
 */
export const COPILOT_FRAME_PROBE = `!!document.querySelector('#${COPILOT_COMPOSER_ID}')`

/**
 * JS expression (truthy on match) that finds the Word editor frame — the one
 * holding the "Chat with Copilot" ribbon entry point. IMPORTANT: this button is
 * NOT on the top SharePoint document; the Word editor is itself an OOPIF
 * (WacFrame_Word_0 → officeapps.live.com/we/wordeditorframe.aspx), so the button
 * lives inside that frame. We therefore search the attached frame sessions for
 * it, not the top document.
 */
export const WORD_SHELL_PROBE = `!!(document.querySelector('#CopilotDAB') || document.querySelector('[aria-label="Chat with Copilot"]'))`

/**
 * Dump every attached OOPIF session (type + url + whether it holds the shell
 * button or the Copilot composer) to the log. Invaluable when a selector or the
 * frame topology shifts — the next run shows exactly what frames exist.
 */
export async function dumpFrames(client: CDPClient): Promise<void> {
  const lines: string[] = []
  for (const [sid, info] of client.sessions) {
    const type = info?.type
    const url = (info?.url || "").slice(0, 90)
    let dab = "?"
    let composer = "?"
    if (type === "iframe" || type === "page" || type === "webview") {
      try {
        await client.send("Runtime.enable", undefined, sid)
        dab = (await client.evaluate(WORD_SHELL_PROBE, sid)) ? "DAB" : "-"
        composer = (await client.evaluate(COPILOT_FRAME_PROBE, sid)) ? "COMPOSER" : "-"
      } catch {
        dab = "err"
      }
    }
    lines.push(`  [${type}] ${dab} ${composer} ${url}`)
  }
  dlog(`[cdp-web word] attached frames (${client.sessions.size}):\n${lines.join("\n") || "  (none)"}`)
}

/**
 * Wait for the Word editor frame (holding the "Chat with Copilot" entry point)
 * to attach and finish loading. Word's SharePoint→WAC boot chain is slow and the
 * editor is a nested OOPIF, so we poll the attached frame sessions (not the top
 * document) up to timeoutMs. Returns the shell frame's sessionId, or null.
 */
export async function waitForWordShell(client: CDPClient, timeoutMs = 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let dumped = false
  while (Date.now() < deadline) {
    const sid = await client.findFrameSession(WORD_SHELL_PROBE)
    if (sid) return sid
    // One diagnostic dump partway through so a failure is debuggable.
    if (!dumped && Date.now() > deadline - timeoutMs + 15_000) {
      await dumpFrames(client).catch(() => {})
      dumped = true
    }
    await sleep(1000)
  }
  await dumpFrames(client).catch(() => {})
  return null
}

/**
 * Open the BizChat "Chat with Copilot" side panel by clicking `#CopilotDAB`
 * INSIDE the Word editor frame (`shellSid`). We deliberately use `#CopilotDAB`
 * and IGNORE "Edit with Copilot" (`#CopilotDraftInDocument-Floatie`) — the
 * parking doc exists only for Word's token allocation; we don't need
 * document-aware responses. Returns true if a button was clicked.
 */
export async function openCopilotPane(client: CDPClient, shellSid: string): Promise<boolean> {
  const clicked = await client.evaluate(
    `
    (() => {
      const btn = document.querySelector('#CopilotDAB')
        || document.querySelector('[aria-label="Chat with Copilot"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `,
    shellSid,
  )
  return clicked === true
}

/**
 * Open the pane (if not already mounted) and resolve the Copilot OOPIF's CDP
 * sessionId (the frame whose document holds the BizChat composer). Clicks
 * `#CopilotDAB` in the Word editor frame (`shellSid`), then waits for the Copilot
 * chat frame — a child of the editor frame — to attach onto our socket. Retries
 * the click because the composer frame can mount a beat after the click. Returns
 * the composer frame sessionId or null on timeout.
 */
export async function resolveCopilotFrame(client: CDPClient, shellSid: string, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  // Maybe the pane was already open (composer frame already present).
  let sid = await client.findFrameSession(COPILOT_FRAME_PROBE)
  if (sid) return sid

  while (Date.now() < deadline) {
    const opened = await openCopilotPane(client, shellSid).catch(() => false)
    if (!opened) dlog("[cdp-web word] #CopilotDAB not clickable yet in shell frame…")
    sid = await client.waitForFrameSession(COPILOT_FRAME_PROBE, 4000)
    if (sid) {
      dlog(`[cdp-web word] resolved Copilot frame session ${sid}`)
      return sid
    }
    dlog("[cdp-web word] Copilot composer frame not resolved yet, re-clicking pane…")
  }
  await dumpFrames(client).catch(() => {})
  return null
}

/**
 * Neutralize Word's document-assistant persona at the wire level.
 *
 * ROOT CAUSE (proven from captured SENT envelopes, Sep 8 2026): the Word Copilot
 * surface stamps every outgoing `type:4 target:"chat"` SignalR invocation with a
 * server-side agent binding — `gpts: [{ id: "WordDraftingAgent", … }]` — plus
 * `localPluginAllowedHost: "document"`. That agent carries its own system framing
 * ("you are the Word drafting assistant, you work inside this document"), which
 * sits UNDERNEATH our composer prompt at the service layer and makes Opus refuse
 * agentic/coding tool calls. The model (tone="Claude_Opus") and our prompt are
 * byte-identical to general chat; only this envelope field differs. The general
 * chat surface binds the neutral `bizchat-as-gpt-scenario` agent instead.
 *
 * We can't change these fields from the composer (Word's client builds the
 * envelope internally), so we monkeypatch `WebSocket.prototype.send` INSIDE the
 * Copilot OOPIF and rewrite every outgoing `type:4 target:"chat"` invocation:
 *   1. `gpts` → the neutral `bizchat-as-gpt-scenario` agent (drops the Word
 *      drafting-assistant persona).
 *   2. drop `localPluginAllowedHost` (document grounding).
 *   3. force `tone: "Claude_Opus"`. The Word engine is Opus-only, and a REOPENED
 *      Word conversation frequently loses both Claude options from the pane's
 *      model picker (only GPT remains selectable), which would otherwise send
 *      a GPT tone. Stamping the tone here pins Opus regardless of the UI state.
 *
 * `source` stays "word" so the turn still bills against Word's token allocation
 * (the whole point of this engine) — forcing the tone does NOT change the bucket,
 * only which model serves the turn within it.
 *
 * The patch is prototype-level and idempotent (guarded by a window flag), so it
 * survives new-chat re-renders and covers a socket created after injection. It
 * MUST be installed before the first sendPrompt of the session.
 */
export async function installEnvelopeRewrite(client: CDPClient, frameSid: string): Promise<boolean> {
  const patch = `
    (() => {
      if (window.__cdpEnvRewrite) return 'already';
      const RS = String.fromCharCode(30); // SignalR record separator (\\x1e)
      const NEUTRAL_GPT = {
        id: "bizchat-as-gpt-scenario",
        source: "BuiltInAgents",
        clientOverrides: {
          capabilities: [{ name: "GraphConnectors" }, { name: "WebSearch" }, { name: "WorkSearch" }],
        },
      };
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === "string" && data.indexOf('"target":"chat"') !== -1) {
            const parts = data.split(RS).filter(Boolean);
            let changed = false;
            const out = parts.map((p) => {
              let obj;
              try { obj = JSON.parse(p); } catch { return p; }
              if (obj && obj.type === 4 && obj.target === "chat" && Array.isArray(obj.arguments)) {
                let touched = false;
                for (const a of obj.arguments) {
                  if (!a || typeof a !== "object") continue;
                  // Only the chat payload argument carries these; skip others.
                  if (!(a.gpts || a.message || a.optionsSets)) continue;
                  if (Array.isArray(a.gpts) && a.gpts.some((g) => g && g.id === "WordDraftingAgent")) {
                    a.gpts = [NEUTRAL_GPT];
                  }
                  if ("localPluginAllowedHost" in a) delete a.localPluginAllowedHost;
                  a.tone = "Claude_Opus";
                  touched = true;
                }
                if (touched) { changed = true; return JSON.stringify(obj); }
              }
              return p;
            });
            if (changed) {
              data = out.join(RS) + RS;
              window.__cdpEnvRewriteCount = (window.__cdpEnvRewriteCount || 0) + 1;
            }
          }
        } catch (e) { /* fall through: never break the send */ }
        return origSend.call(this, data);
      };
      window.__cdpEnvRewrite = true;
      return 'installed';
    })()
  `
  const result = await client.evaluate(patch, frameSid).catch((e) => {
    dlog("[cdp-web word] envelope rewrite injection failed:", e)
    return null
  })
  dlog(`[cdp-web word] envelope rewrite: ${result}`)
  return result === "installed" || result === "already"
}

/**
 * Start a fresh Copilot conversation inside the pane (functional isolation).
 * Word Copilot has no temporary-chat toggle, so we just click New Chat per
 * request; history accrues in the pane but does not affect responses. Runs
 * inside the Copilot OOPIF via the client's defaultSessionId. Uses a plain DOM
 * .click() (not a Fluent coordinate click), so it does not depend on the
 * Phase-4 cross-frame coordinate-click work.
 */
export async function wordOpenNewChat(client: CDPClient): Promise<boolean> {
  const clicked = await client.evaluate(`
    (() => {
      const btn = document.querySelector('[data-testid="newChatButton"]')
        || document.querySelector('#new-chat-button')
        || document.querySelector('[aria-label="New chat"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `)
  if (clicked === true) {
    await sleep(1200)
    // Re-assert Runtime in the frame after the pane re-renders the chat.
    await client.send("Runtime.enable", {}).catch(() => {})
    await sleep(300)
    return true
  }
  dlog("[cdp-web word] wordOpenNewChat: no new-chat button found (continuing on current chat)")
  return false
}

/**
 * Start a fresh TEMPORARY Copilot conversation inside the Word pane. Unlike a
 * plain New Chat (which persists to the pane's chat history), a temporary chat
 * is not saved — the whole point is to avoid cluttering the user's Copilot
 * history with agentic runs.
 *
 * There is no standalone button: "New temporary chat" is a Fluent `menuitem`
 * that lives inside the flyout opened by `#moreButton` (aria-label
 * "Open Copilot chats and more", aria-haspopup="menu"). Empirically confirmed on
 * a live Word tab (Sep 9 2026): open the flyout, click the menuitem, and the
 * pane header switches to "Temporary chat" with the composer still mounted.
 *
 * Two phases (a single sync evaluate can't wait for the flyout to render):
 *   1. Open the more-menu — but only if it isn't already expanded, since
 *      clicking `#moreButton` TOGGLES it (a second click would close it).
 *   2. Click the visible `[role="menuitem"]` whose text is "New temporary chat".
 * Runs inside the Copilot OOPIF via the client's defaultSessionId.
 */
export async function wordOpenTempChat(client: CDPClient): Promise<boolean> {
  // Phase 1: ensure the flyout is open.
  const opened = await client.evaluate(`
    (() => {
      const more = document.getElementById('moreButton')
        || document.querySelector('[aria-label="Open Copilot chats and more"]');
      if (!more) return 'no-trigger';
      if (more.getAttribute('aria-expanded') !== 'true') { more.click(); return 'opened'; }
      return 'already-open';
    })()
  `)
  if (opened === "no-trigger") {
    dlog("[cdp-web word] wordOpenTempChat: #moreButton not found — falling back to plain new chat")
    return await wordOpenNewChat(client)
  }
  await sleep(700)

  // Phase 2: click the "New temporary chat" menuitem.
  const clicked = await client.evaluate(`
    (() => {
      for (const el of document.querySelectorAll('[role="menuitem"]')) {
        const t = (el.innerText || el.textContent || '').trim();
        if (/^New temporary chat$/i.test(t)) { if (!el.offsetParent) return 'hidden'; el.click(); return 'clicked'; }
      }
      return 'not-found';
    })()
  `)
  if (clicked === "clicked") {
    await sleep(1200)
    // Re-assert Runtime in the frame after the pane re-renders the chat.
    await client.send("Runtime.enable", {}).catch(() => {})
    await sleep(300)
    return true
  }
  dlog(`[cdp-web word] wordOpenTempChat: temp menuitem ${clicked} — falling back to plain new chat`)
  return await wordOpenNewChat(client)
}
