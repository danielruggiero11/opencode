/**
 * High-level Copilot driver for the web version (microsoft365.com/chat).
 * Manages conversations, injects prompts, extracts responses, detects auth state.
 *
 * The web UI shares the same Copilot React components as the desktop app,
 * so most selectors are identical. Key differences:
 * - URL-based navigation (can open new chats via URL)
 * - Auth can expire (session timeout) — need to detect login redirects
 * - Multiple tabs can run concurrently
 */
import { CDPClient, CDPError } from "./client"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "cdp-web" })
function _cdpFmt(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}
function dlog(...args: unknown[]): void {
  log.error(args.map(_cdpFmt).join(" "))
}


const COMPOSER_ID = "m365-chat-editor-target-element"
const TURN_SELECTOR = '[data-testid="m365-chat-llm-web-ui-chat-message"]'
const COPY_BUTTON = '[data-testid="CopyButtonTestId"]'
const MARKDOWN_REPLY = '[data-testid="markdown-reply"]'

const EFFORT_LABELS: Record<string, string> = {
  auto: "Auto",
  quick: "Quick response",
  think: "Think deeper",
  opus: "Opus",
}

export class CopilotReauthRequired extends CDPError {
  constructor() {
    super("Copilot session expired — browser tab needs re-authentication.")
    this.name = "CopilotReauthRequired"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Auth Detection ──────────────────────────────────────────────────────────

/**
 * Check if the tab is on a login/auth page instead of the Copilot chat.
 * Returns true if authenticated (chat is usable), false if login is needed.
 */
export async function checkAuth(client: CDPClient): Promise<boolean> {
  const result = await client.evaluate(`
    (() => {
      const url = window.location.href.toLowerCase();
      // Login redirects
      if (url.includes('login.microsoftonline.com')) return 'login';
      if (url.includes('login.live.com')) return 'login';
      if (url.includes('/oauth')) return 'login';
      // Session expired modal
      const expired = document.querySelector('[data-testid="session-expired"]');
      if (expired) return 'expired';
      // Check for the composer (means we're good)
      const composer = document.getElementById('${COMPOSER_ID}');
      if (composer) return 'ready';
      // Also check for chat input in newer Copilot UI
      const chatInput = document.querySelector('[data-testid="chat-input"], [contenteditable="true"]');
      if (chatInput) return 'ready';
      return 'unknown';
    })()
  `)
  return result === "ready"
}

/**
 * Verify the composer is present (app is logged in and ready).
 */
export async function checkComposer(client: CDPClient): Promise<boolean> {
  return await client.evaluate(`
    (() => {
      if (document.getElementById('${COMPOSER_ID}')) return true;
      // Fallback selectors for newer Copilot UI
      if (document.querySelector('[data-testid="chat-input"]')) return true;
      if (document.querySelector('[contenteditable="true"][role="textbox"]')) return true;
      if (document.querySelector('div[contenteditable="true"]')) return true;
      return false;
    })()
  `)
}

/**
 * Navigate the tab to the Copilot chat URL.
 * Useful for opening a fresh chat in an existing tab.
 */
export async function navigateToChat(client: CDPClient): Promise<void> {
  await client.evaluate(`window.location.href = 'https://m365.cloud.microsoft/chat'`)
  // Wait for navigation and page load
  await sleep(3000)
}

/**
 * Open a new TEMPORARY chat conversation within the current tab.
 *
 * Uses real CDP mouse events (clickSelector) because Fluent UI menus
 * don't respond to synthetic .click(). After navigation, re-enables
 * Runtime to restore the execution context (Copilot internally navigates
 * when opening a new chat, invalidating the old context).
 */
export async function openNewChat(client: CDPClient, temporary = true): Promise<void> {
  // ─── New UI: (optionally) toggle temporary mode, then click "New chat" ───
  const hasNewUI = temporary
    ? await ensureTemporaryMode(client)
    : await ensurePersistentMode(client)

  if (hasNewUI) {
    if (await client.clickSelector('a[aria-label="New chat"]')) {
      await sleep(1200)
      await client.send("Runtime.enable", {})
      await sleep(300)
      return
    }
  }

  // ─── Old UI: split button dropdown → private chat (temporary only) ───
  if (temporary && await client.clickSelector('[data-testid="newChatSplitButton"]')) {
    await sleep(1000)
    if (await client.clickSelector('[data-testid="newPrivateChatButton"]')) {
      await sleep(1200)
      await client.send("Runtime.enable", {})
      await sleep(300)
      return
    }
    await client.pressKey("Escape", "Escape", 27)
    await sleep(300)
  }

  // Fallback: regular new chat button
  if (await client.clickSelector('[data-testid="newChatButton"]')) {
    await sleep(1000)
    await client.send("Runtime.enable", {})
    await sleep(300)
    return
  }

  // Last resort: navigate directly
  await navigateToChat(client)
  await client.send("Runtime.enable", {})
  await sleep(300)
}

/**
 * Ensure the "Temporary chat" toggle is pressed (new Copilot UI).
 * Returns true if the new UI was detected (toggle exists), false otherwise.
 */
async function ensureTemporaryMode(client: CDPClient): Promise<boolean> {
  const pressed = await client.evaluate(`
    (() => {
      const btn = document.querySelector('button[aria-label="Temporary chat"]');
      if (!btn) return 'missing';
      return btn.getAttribute('aria-pressed');
    })()
  `)

  if (pressed === "missing") {
    dlog("[cdp-web openNewChat] temporary chat toggle not found (legacy UI)")
    return false
  }

  if (pressed === "true") {
    dlog("[cdp-web openNewChat] temporary chat already enabled")
    return true
  }

  dlog("[cdp-web openNewChat] enabling temporary chat mode")
  await client.clickSelector('button[aria-label="Temporary chat"]')
  await sleep(500)
  return true
}

/**
 * Ensure the "Temporary chat" toggle is NOT pressed (persistent chat).
 * Persistent chats get a conversation GUID and appear in the sidebar,
 * which is what makes them recoverable. Returns true if the new UI was
 * detected (toggle exists), false otherwise.
 */
async function ensurePersistentMode(client: CDPClient): Promise<boolean> {
  const pressed = await client.evaluate(`
    (() => {
      const btn = document.querySelector('button[aria-label="Temporary chat"]');
      if (!btn) return 'missing';
      return btn.getAttribute('aria-pressed');
    })()
  `)

  if (pressed === "missing") {
    dlog("[cdp-web openNewChat] temporary chat toggle not found (legacy UI)")
    return false
  }

  if (pressed !== "true") {
    dlog("[cdp-web openNewChat] persistent chat already enabled")
    return true
  }

  dlog("[cdp-web openNewChat] disabling temporary chat mode (going persistent)")
  await client.clickSelector('button[aria-label="Temporary chat"]')
  await sleep(500)
  return true
}

/**
 * Set the effort/model mode (Opus, Think Deeper, etc).
 * Uses real CDP mouse events (Input.dispatchMouseEvent) which Fluent UI menus require.
 * Mirrors the working Lumen implementation.
 */
export async function setEffort(client: CDPClient, effort: string): Promise<void> {
  const label = EFFORT_LABELS[effort]
  if (!label) {
    dlog(`[cdp-web setEffort] unknown effort: ${effort}`)
    return
  }

  // Wait for the mode switcher to appear (may take a moment after openNewChat)
  let switcherVisible = false
  for (let attempt = 0; attempt < 5; attempt++) {
    switcherVisible = await client.evaluate(`
      (() => {
        const sw = document.getElementById('gptModeSwitcher');
        return !!(sw && sw.offsetParent);
      })()
    `) as boolean
    if (switcherVisible) break
    dlog(`[cdp-web setEffort] switcher not visible yet (attempt ${attempt + 1}/5)`)
    await sleep(800)
  }

  // --- Path A: wide layout (gptModeSwitcher visible) ---
  if (switcherVisible) {
    // Check if already set
    const current = (await client.evaluate(
      `(document.getElementById('gptModeSwitcher')||{}).innerText||''`,
    ) || "").split("\n")[0].trim()
    dlog(`[cdp-web setEffort] current label: "${current}", target: "${label}"`)
    if (current.toLowerCase() === label.toLowerCase()) return

    // Open menu with real mouse click (Fluent menus need this)
    if (!await client.clickSelector("#gptModeSwitcher")) {
      dlog(`[cdp-web setEffort] clickSelector(#gptModeSwitcher) failed`)
      return
    }
    await sleep(700)

    let selected = await clickRadioItem(client, label)
    dlog(`[cdp-web setEffort] Path A initial: ${selected} (target: ${label})`)

    // If not found at top level, expand the provider submenu (Claude/GPT)
    if (selected === "missing") {
      const expanded = await expandProviderSubmenu(client, label)
      if (expanded) {
        await sleep(600)
        selected = await clickRadioItem(client, label)
        dlog(`[cdp-web setEffort] Path A after submenu expand: ${selected}`)
      }
    }

    log.info("setEffort", { label, selected })
    if (selected !== "clicked") {
      await client.pressKey("Escape", "Escape", 27)
    }
    await sleep(400)
    return
  }

  // --- Path B: narrow layout (overflow "..." button) ---
  if (!await client.clickSelector('[data-testid="overflow-menu-button"]')) {
    // Last resort: force-reveal hidden switcher, then use real click
    await client.evaluate(`
      (() => {
        const sw = document.getElementById('gptModeSwitcher');
        if (!sw) return;
        let el = sw;
        while (el) {
          if (window.getComputedStyle(el).display === 'none') {
            el.style.display = 'block';
            el.setAttribute('data-opencode-forced', '1');
          }
          el = el.parentElement;
        }
      })()
    `)
    if (!await client.clickSelector("#gptModeSwitcher")) {
      await restoreForced(client)
      return
    }
    await sleep(700)
    const selected = await clickRadioItem(client, label)
    if (selected !== "clicked") await client.pressKey("Escape", "Escape", 27)
    await sleep(400)
    await restoreForced(client)
    return
  }

  await sleep(700)
  // In overflow menu, try radio items directly
  let selected = await clickRadioItem(client, label)
  if (selected === "clicked") { await sleep(400); return }
  if (selected === "already") {
    await client.pressKey("Escape", "Escape", 27)
    await sleep(300)
    return
  }
  // Radio not found — try expanding a provider submenu (Claude/GPT)
  const expanded = await expandProviderSubmenu(client, label)
  if (expanded) {
    await sleep(600)
    selected = await clickRadioItem(client, label)
  }
  if (selected !== "clicked") await client.pressKey("Escape", "Escape", 27)
  await sleep(400)
}

/**
 * Inject text into the composer and send it.
 * Tries multiple strategies for text insertion into rich-text editors.
 */
export async function sendPrompt(client: CDPClient, text: string): Promise<void> {
  // Grant clipboard for both old and new Copilot domains
  await client.grantClipboard("https://www.microsoft365.com")
  await client.grantClipboard("https://m365.cloud.microsoft")

  // Click inside the composer to ensure real cursor placement
  await client.evaluate(`
    (() => {
      const el = document.getElementById('${COMPOSER_ID}')
        || document.querySelector('[data-testid="chat-input"]')
        || document.querySelector('[contenteditable="true"][role="textbox"]')
        || document.querySelector('div[contenteditable="true"]');
      if (el) {
        el.focus();
        // Dispatch a click to activate the editor
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        el.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      }
    })()
  `)
  await sleep(300)

  const EDITOR_QUERY = `document.getElementById('${COMPOSER_ID}') || document.querySelector('[data-testid="chat-input"]') || document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector('div[contenteditable="true"]')`;

  // Strategy 1: Programmatic paste via DataTransfer
  // This simulates a paste event with text data, which rich editors handle
  const pasted = await client.evaluate(`
    (() => {
      const el = ${EDITOR_QUERY};
      if (!el) return false;
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(pasteEvent);
      return true;
    })()
  `)
  await sleep(500)

  // Check if it worked
  let hasContent = await client.evaluate(`
    (() => {
      const el = ${EDITOR_QUERY};
      return !!(el && el.innerText && el.innerText.trim().length > 0);
    })()
  `)

  // Strategy 2: Input.insertText CDP command
  if (!hasContent) {
    await client.evaluate(`(${EDITOR_QUERY})?.focus()`)
    await sleep(100)
    await client.insertText(text)
    await sleep(300)
    hasContent = await client.evaluate(`
      (() => {
        const el = ${EDITOR_QUERY};
        return !!(el && el.innerText && el.innerText.trim().length > 0);
      })()
    `)
  }

  // Strategy 3: Clipboard write + Ctrl+V
  if (!hasContent) {
    await client.evaluateAsync(`navigator.clipboard.writeText(${JSON.stringify(text)})`)
    await sleep(100)
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "v", code: "KeyV",
      windowsVirtualKeyCode: 86, modifiers: 2,
    })
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "v", code: "KeyV",
      windowsVirtualKeyCode: 86, modifiers: 2,
    })
    await sleep(500)
    hasContent = await client.evaluate(`
      (() => {
        const el = ${EDITOR_QUERY};
        return !!(el && el.innerText && el.innerText.trim().length > 0);
      })()
    `)
  }

  // Strategy 4: Direct innerHTML/innerText mutation + input event
  if (!hasContent) {
    await client.evaluate(`
      (() => {
        const el = ${EDITOR_QUERY};
        if (!el) return;
        el.innerText = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
      })()
    `)
    await sleep(300)
  }

  // Click send button
  await sleep(200)
  const clicked = await client.evaluate(`
    (() => {
      const b = document.querySelector('button[aria-label*="Send" i]');
      if (b && !(b.disabled || b.getAttribute('aria-disabled')==='true')) { b.click(); return true; }
      return false;
    })()
  `)
  if (!clicked) {
    await client.pressKey("Enter", "Enter", 13)
  }
}

/**
 * Get the current turn count (number of assistant response elements).
 */
export async function getTurnCount(client: CDPClient): Promise<number> {
  const count = await client.evaluate(`
    document.querySelectorAll('${TURN_SELECTOR}').length
  `)
  return typeof count === "number" ? count : 0
}

/**
 * Wait for a new response to appear and complete.
 *
 * Detection strategy (mirrors Lumen's battle-tested approach):
 *
 * PRIMARY PATH ("Stop generating" button was seen):
 *   While the stop button is visible → keep polling, no stability checks.
 *   Once it disappears (+ Send button returns) → settle 3 polls, then return.
 *   This prevents premature returns during long thinking pauses (opus/think).
 *
 * FALLBACK PATH (stop button never seen — selector broken or ultra-fast response):
 *   Use text-stability heuristics + turnDone signals as last resort.
 */
export async function awaitResponse(
  client: CDPClient,
  expectedTurnIndex: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  const POLL_INTERVAL = 700
  const SETTLE_AFTER_STOP = 3       // ~2.1s after stop disappears
  const FALLBACK_STABLE = timeout >= 300 ? 12 : 6  // polls of identical text
  const FALLBACK_LEN_POLLS = 10     // polls of unchanged length for large responses
  const LARGE_RESPONSE_CHARS = 500
  const MAX_EMPTY_BEFORE_RECOVERY = 5

  const deadline = Date.now() + timeout * 1000
  let last = ""
  let lastLen = 0
  let stable = 0
  let lengthStable = 0
  let pollCount = 0
  let wasGenerating = false
  let stopGoneCount = 0
  let consecutiveEmpty = 0

  // JS expression that reads the full response state in one call
  const jsState = `
    (() => {
      const turns = [...document.querySelectorAll('${TURN_SELECTOR}')];
      const turn = turns[${expectedTurnIndex}] || turns[turns.length - 1];
      const replies = turn ? [...turn.querySelectorAll('${MARKDOWN_REPLY}')] : [];
      const text = replies.length ? (replies[replies.length-1].innerText || '').trim() : '';

      const stopBtn = document.querySelector('button[aria-label="Stop generating"]');
      const sendBtn = document.querySelector('button[aria-label="Send"]');
      const isGenerating = !!stopBtn;
      const hasSendBtn = !!sendBtn;

      let turnDone = false;
      if (turn) {
        turnDone = !!(turn.querySelector('${COPY_BUTTON}')
          || turn.querySelector('[data-testid="ThumbLikeButtonTestId"]')
          || turn.querySelector('[data-testid="SuggestedResponsesContainerTestId"]'));
      }

      return JSON.stringify({text, isGenerating, hasSendBtn, turnDone, totalTurns: turns.length});
    })()
  `

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new CDPError("Aborted")
    await sleep(POLL_INTERVAL)
    pollCount++

    const raw = await client.evaluate(jsState)
    let state: { text: string; isGenerating: boolean; hasSendBtn: boolean; turnDone: boolean; totalTurns: number }
    try {
      state = JSON.parse(raw || '{"text":"","isGenerating":false,"hasSendBtn":false,"turnDone":false,"totalTurns":0}')
    } catch {
      state = { text: "", isGenerating: false, hasSendBtn: false, turnDone: false, totalTurns: 0 }
    }

    const { text, isGenerating, hasSendBtn, turnDone } = state
    const textLen = text.length

    // Context health: if everything comes back empty, Runtime context may be stale
    if (!text && !isGenerating && !hasSendBtn && !turnDone) {
      consecutiveEmpty++
      if (consecutiveEmpty === MAX_EMPTY_BEFORE_RECOVERY) {
        dlog(`[cdp-web] awaitResponse: ${consecutiveEmpty} empty polls, re-enabling Runtime`)
        await client.send("Runtime.enable", {})
        await sleep(300)
        continue
      }
    } else {
      consecutiveEmpty = 0
    }

    // Debug log every 10 polls
    if (pollCount % 10 === 1) {
      dlog(`[cdp-web] awaitResponse poll #${pollCount}: gen=${isGenerating} send=${hasSendBtn} done=${turnDone} len=${textLen} wasGen=${wasGenerating} stopGone=${stopGoneCount}`)
    }

    // Track that we saw the stop button
    if (isGenerating) {
      wasGenerating = true
      stopGoneCount = 0
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIMARY PATH: Stop button was seen at some point.
    // While visible → generation ongoing (even during 60s thinking).
    // Once gone → settle for a few polls to let text finalize.
    // ═══════════════════════════════════════════════════════════════════
    if (wasGenerating) {
      // Preserve the last non-empty text we captured during generation
      if (text) {
        last = text
        lastLen = textLen
      }

      if (!isGenerating) {
        const finalText = text || last
        const finalLen = finalText?.length ?? 0
        if (finalText) {
          stopGoneCount++
          if (stopGoneCount >= SETTLE_AFTER_STOP) {
            dlog(`[cdp-web] awaitResponse: stop gone + settled (${stopGoneCount} polls). Returning ${finalLen} chars.`)
            return finalText
          }
          if (hasSendBtn && turnDone) {
            dlog(`[cdp-web] awaitResponse: stop gone + send + turnDone. Returning ${finalLen} chars.`)
            return finalText
          }
        } else if (turnDone) {
          // Stop gone, turnDone, but never captured text — DOM may have re-rendered.
          // Give a few more polls then bail with empty to avoid infinite loop.
          stopGoneCount++
          if (stopGoneCount >= 10) {
            dlog(`[cdp-web] awaitResponse: stop gone + turnDone but text empty after 10 polls. Bailing.`)
            return ""
          }
        }
      }
      continue
    }

    // ═══════════════════════════════════════════════════════════════════
    // FALLBACK PATH: Stop button was NEVER seen.
    // Either selector broken, ultra-fast response, or polling started
    // before generation began. Use stability heuristics.
    // ═══════════════════════════════════════════════════════════════════

    // turnDone (Copy button, thumbs, suggestions) → return
    if (turnDone && text) {
      // But wait one more poll to ensure text is final
      await sleep(POLL_INTERVAL)
      const verify = await client.evaluate(jsState)
      try {
        const v = JSON.parse(verify || '{}')
        if (v.text) return v.text
      } catch {}
      return text
    }

    // Exact text match over N polls
    if (text && text === last) {
      stable++
      if (stable >= FALLBACK_STABLE) {
        dlog(`[cdp-web] awaitResponse: text stable for ${stable} polls. Returning ${textLen} chars.`)
        return text
      }
    } else {
      stable = 0
    }

    // Length-stable for large responses
    if (textLen >= LARGE_RESPONSE_CHARS && textLen === lastLen) {
      lengthStable++
      if (lengthStable >= FALLBACK_LEN_POLLS) {
        dlog(`[cdp-web] awaitResponse: length stable for ${lengthStable} polls. Returning ${textLen} chars.`)
        return text
      }
    } else if (textLen !== lastLen) {
      lengthStable = 0
    }

    last = text
    lastLen = textLen
  }

  // Timeout: return whatever we have (may be partial)
  if (last) {
    dlog(`[cdp-web] awaitResponse: timeout reached, returning partial (${lastLen} chars)`)
    return last
  }
  throw new CDPError(`Copilot response did not complete within ${timeout}s`)
}

/**
 * Extract the exact response text via the Copy button + clipboard.
 */
export async function extractResponseRaw(
  client: CDPClient,
  turnIndex: number,
): Promise<string | null> {
  try {
    await client.grantClipboard("https://www.microsoft365.com")
    await client.grantClipboard("https://m365.cloud.microsoft")
    const clicked = await client.evaluate(`
      (() => {
        const turns = [...document.querySelectorAll('${TURN_SELECTOR}')];
        const turn = turns[${turnIndex}];
        if (!turn) return false;
        const b = turn.querySelector('${COPY_BUTTON}');
        if (b) { b.click(); return true; }
        return false;
      })()
    `)
    if (!clicked) return null
    await sleep(350)
    const raw = await client.evaluateAsync("navigator.clipboard.readText()")
    if (!raw) return null
    return raw.trim()
  } catch {
    return null
  }
}

// ─── Image Paste (via Clipboard) ─────────────────────────────────────────────

/**
 * Paste an image into the Copilot composer via the REAL system clipboard.
 *
 * Uses navigator.clipboard.write() to put the image blob into the OS clipboard,
 * then dispatches real Ctrl+V key events via CDP. This is identical to what
 * happens when a user presses Ctrl+V — the browser natively handles the paste
 * event from the actual clipboard, and Copilot's Lexical editor processes it
 * as a real file attachment with thumbnail preview.
 *
 * A synthetic ClipboardEvent doesn't work because Copilot's editor checks
 * the native clipboard path, not the event's clipboardData property.
 */
export async function pasteImageAttachment(
  client: CDPClient,
  base64: string,
  mime: string,
  _filename: string,
): Promise<boolean> {
  log.info("pasteImageAttachment", { mime, dataLen: base64.length })

  // Grant clipboard permissions for the current origin
  await client.grantClipboard("https://m365.cloud.microsoft")
  await client.grantClipboard("https://www.microsoft365.com")

  // Step 1: Write image blob to the real system clipboard
  const writeResult = await client.evaluateAsync(`
    (async () => {
      try {
        const base64 = ${JSON.stringify(base64)};
        const mime = ${JSON.stringify(mime)};

        // Decode base64 to Uint8Array
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

        const blob = new Blob([bytes], { type: mime });

        // Write to the real OS clipboard
        await navigator.clipboard.write([
          new ClipboardItem({ [mime]: blob })
        ]);
        return 'written';
      } catch (e) {
        return 'error:' + e.message;
      }
    })()
  `)

  if (!writeResult?.startsWith("written")) {
    log.warn("pasteImageAttachment: clipboard write failed", { result: writeResult })
    return false
  }

  // Step 2: Focus the composer
  await client.evaluate(`
    (() => {
      const el = document.getElementById('${COMPOSER_ID}')
        || document.querySelector('[contenteditable="true"]');
      if (el) el.focus();
    })()
  `)
  await sleep(200)

  // Step 3: Send real Ctrl+V key events via CDP Input domain
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "v",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 2, // Ctrl
  })
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "v",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 2, // Ctrl
  })

  // Wait for the editor to process the paste and show the thumbnail
  await sleep(3000)

  log.info("pasteImageAttachment: done")
  return true
}

// ─── File Attachment ─────────────────────────────────────────────────────────

/**
 * Attach files to the Copilot composer via DOM.setFileInputFiles.
 *
 * Mirrors the working Lumen implementation exactly:
 * - Target #upload-file-button directly (always present in DOM)
 * - Pass native Windows paths (backslashes)
 * - No change event dispatch needed
 * - Wait 2s for attachment to register
 *
 * @param filePaths - Array of absolute paths to files on disk (native OS format)
 */
export async function attachFiles(client: CDPClient, filePaths: string[]): Promise<boolean> {
  if (filePaths.length === 0) return true
  log.info("attachFiles", { paths: filePaths })
  try {
    await client.setFileInput("#upload-file-button", filePaths)
  } catch (err) {
    log.warn("attachFiles: setFileInput failed", { err: String(err) })
    return false
  }
  await sleep(2000)
  return true
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a menuitemradio matching label and click it with real CDP mouse events.
 * Returns 'clicked', 'already', or 'missing'.
 */
/**
 * Expand the provider submenu (Claude / GPT) that contains the target model.
 * Copilot nests model-specific options (like Opus) under a provider expander
 * that opens a side popup when clicked with real mouse events.
 * Returns true if a submenu was expanded.
 */
async function expandProviderSubmenu(client: CDPClient, targetLabel: string): Promise<boolean> {
  // Determine which provider submenu to expand based on the target label
  const providerForLabel: Record<string, string> = {
    opus: "claude",
    sonnet: "claude",
    haiku: "claude",
    "gpt-4o": "gpt",
    "gpt-4": "gpt",
    "o1": "gpt",
    "o3": "gpt",
  }
  const targetProvider = providerForLabel[targetLabel.toLowerCase()] || "claude"

  const result = await client.evaluate(`
    (() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const target = ${JSON.stringify(targetProvider)};
      const trigger = items.find(e => {
        const t = (e.innerText||'').split('\\n')[0].trim().toLowerCase();
        return t === target;
      });
      if (!trigger) return JSON.stringify({expanded: false, available: items.map(e => (e.innerText||'').split('\\n')[0].trim())});
      const r = trigger.getBoundingClientRect();
      return JSON.stringify({expanded: true, x: r.x + r.width/2, y: r.y + r.height/2});
    })()
  `)
  const parsed = JSON.parse(result || '{"expanded":false}')
  dlog(`[cdp-web expandProviderSubmenu] target="${targetProvider}", result=${JSON.stringify(parsed)}`)

  if (parsed.expanded) {
    // Use real CDP mouse click — Fluent UI menus require Input.dispatchMouseEvent
    await client.clickXY(parsed.x, parsed.y)
    // Wait for the submenu popup to render
    await sleep(1200)
    return true
  }
  return false
}

async function clickRadioItem(client: CDPClient, label: string): Promise<string> {
  const info = await client.evaluate(`
    (() => {
      const want = ${JSON.stringify(label.toLowerCase())};
      const all = [...document.querySelectorAll('[role="menuitemradio"]')];
      const labels = all.map(e => (e.innerText||'').split('\\n')[0].trim());
      // Match either exact or "starts with" to handle suffixes like "(Preview)"
      const it = all.find(e => {
        const t = (e.innerText||'').split('\\n')[0].trim().toLowerCase();
        return t === want || t.startsWith(want + ' ');
      });
      if (!it) return JSON.stringify({status:'missing', available: labels});
      if (it.getAttribute('aria-checked') === 'true') return JSON.stringify({status:'already'});
      const r = it.getBoundingClientRect();
      return JSON.stringify({status:'found', x: r.x + r.width/2, y: r.y + r.height/2});
    })()
  `)
  const parsed = JSON.parse(info || '{"status":"missing"}')
  dlog(`[cdp-web clickRadioItem] target="${label}", result=${JSON.stringify(parsed)}`)
  if (parsed.status !== "found") return parsed.status
  await client.clickXY(parsed.x, parsed.y)
  await sleep(300)
  return "clicked"
}

async function restoreForced(client: CDPClient): Promise<void> {
  await client.evaluate(`
    (() => {
      document.querySelectorAll('[data-opencode-forced]').forEach(el => {
        el.style.display = 'none';
        el.removeAttribute('data-opencode-forced');
      });
    })()
  `)
}
