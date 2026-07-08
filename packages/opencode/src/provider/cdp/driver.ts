/**
 * High-level Copilot driver: manage conversations, inject prompts, extract responses.
 * Supports both stateless (new chat per call) and stateful (continue conversation) modes.
 * Mirrors Lumen's services/copilot/driver.py logic in TypeScript.
 */
import { CDPClient, CDPError, findTargetWs } from "./client"

const COMPOSER_ID = "m365-chat-editor-target-element"
const TURN_SELECTOR = '[data-testid="m365-chat-llm-web-ui-chat-message"]'
const COPY_BUTTON = '[data-testid="CopyButtonTestId"]'
const MARKDOWN_REPLY = '[data-testid="markdown-reply"]'

const EFFORT_LABELS: Record<string, string> = {
  auto: "Auto",
  quick: "Quick Response",
  think: "Think Deeper",
  opus: "Opus",
}

export interface DriverOptions {
  port?: number
  effort?: string
  timeout?: number
}

export class CopilotReauthRequired extends CDPError {
  constructor() {
    super("Copilot composer not found — the app likely needs re-login.")
    this.name = "CopilotReauthRequired"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Stateful API (for the persistent conversation model) ────────────────────

/**
 * Verify the composer is present (app is logged in and ready).
 */
export async function checkComposer(client: CDPClient): Promise<boolean> {
  return await client.evaluate(`!!document.getElementById('${COMPOSER_ID}')`)
}

/**
 * Open a new chat (non-temporary, so it persists in history for reconnection).
 * Call this once when initializing a new stateful session.
 */
export async function openNewChat(client: CDPClient): Promise<void> {
  await client.evaluate(`
    (() => {
      const btn = document.querySelector('[data-testid="newChatButton"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `)
  await sleep(1200)
}

/**
 * Set the effort/model mode (Opus, Think Deeper, etc).
 */
export async function setEffort(client: CDPClient, effort: string): Promise<void> {
  const label = EFFORT_LABELS[effort]
  if (!label) return

  // Check if switcher is visible
  const switcherVisible = await client.evaluate(`
    (() => {
      const sw = document.getElementById('gptModeSwitcher');
      return !!(sw && sw.offsetParent);
    })()
  `)

  if (switcherVisible) {
    const current = await client.evaluate(
      `(document.getElementById('gptModeSwitcher')||{}).innerText||''`,
    )
    const currentFirst = (current || "").split("\n")[0].trim()
    if (currentFirst.toLowerCase() === label.toLowerCase()) return

    await client.evaluate(`document.getElementById('gptModeSwitcher').click()`)
    await sleep(700)
    const selected = await clickRadio(client, label)
    if (selected !== "clicked") {
      await client.pressKey("Escape", "Escape", 27)
    }
    await sleep(400)
    return
  }

  // Narrow layout: overflow menu
  const overflowClicked = await client.evaluate(`
    (() => {
      const btn = document.querySelector('[data-testid="overflow-menu-button"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `)
  if (overflowClicked) {
    await sleep(700)
    const selected = await clickRadio(client, label)
    if (selected !== "clicked") {
      await client.pressKey("Escape", "Escape", 27)
    }
    await sleep(400)
  }
}

/**
 * Inject text into the composer and send it. Used for each turn in a
 * stateful conversation.
 */
export async function sendPrompt(client: CDPClient, text: string): Promise<void> {
  await client.evaluate(`document.getElementById('${COMPOSER_ID}').focus()`)
  await sleep(200)
  await client.insertText(text)
  await sleep(400)

  // Click send button or press Enter
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
 * Wait for a NEW response to appear and complete. Takes the expected turn
 * index (0-based) so it waits for the Nth turn to have a CopyButton.
 */
export async function awaitResponse(
  client: CDPClient,
  expectedTurnIndex: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeout * 1000
  let last = ""
  let stable = 0

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new CDPError("Aborted")
    await sleep(700)

    const state = await client.evaluate(`
      (() => {
        const turns = [...document.querySelectorAll('${TURN_SELECTOR}')];
        const turn = turns[${expectedTurnIndex}];
        if (!turn) return JSON.stringify({text:'',done:false});
        const replies = [...turn.querySelectorAll('${MARKDOWN_REPLY}')];
        const text = replies.length ? (replies[replies.length-1].innerText || '').trim() : '';
        const done = !!turn.querySelector('${COPY_BUTTON}');
        return JSON.stringify({text, done});
      })()
    `)

    let parsed: { text: string; done: boolean }
    try {
      parsed = JSON.parse(state || '{"text":"","done":false}')
    } catch {
      parsed = { text: "", done: false }
    }

    if (parsed.done) return parsed.text

    // Secondary settle heuristic
    if (parsed.text && parsed.text === last) {
      stable++
      if (stable >= 6) return parsed.text
    } else {
      stable = 0
    }
    last = parsed.text
  }

  throw new CDPError(`Copilot response did not complete within ${timeout}s`)
}

/**
 * Extract the exact response text via the Copy button + clipboard.
 * Uses the turn at the given index.
 */
export async function extractResponseRaw(
  client: CDPClient,
  turnIndex: number,
): Promise<string | null> {
  try {
    await client.grantClipboard("https://www.microsoft365.com")
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

    // Do NOT unescape markdown backslashes — this destroys JSON escaping in
    // tool-call responses (e.g. "C:\\Users" becomes "C:\Users" which is invalid
    // JSON). The raw clipboard text is the correct source for both tool calls
    // and plain text responses.
    return raw.trim()
  } catch {
    return null
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function clickRadio(client: CDPClient, label: string): Promise<string> {
  return await client.evaluate(`
    (() => {
      const want = ${JSON.stringify(label.toLowerCase())};
      const it = [...document.querySelectorAll('[role="menuitemradio"]')]
        .find(e => (e.innerText||'').split('\\n')[0].trim().toLowerCase() === want);
      if (!it) return 'missing';
      if (it.getAttribute('aria-checked') === 'true') return 'already';
      it.click();
      return 'clicked';
    })()
  `)
}

// ─── Legacy stateless API (kept for fallback) ────────────────────────────────

/**
 * Stateless: drive one prompt through M365 Copilot (opens new chat each time).
 */
export async function ask(
  prompt: string,
  options: DriverOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  const { port = 9223, effort = "opus", timeout = 300 } = options

  const wsUrl = await findTargetWs(port)
  if (!wsUrl) {
    throw new CDPError(`Copilot CDP endpoint not reachable on port ${port}. Is M365Copilot.exe running?`)
  }

  const client = new CDPClient(wsUrl)
  try {
    await client.connect()
    await client.send("Runtime.enable")
    await client.send("DOM.enable")
    await client.send("Page.enable")

    const hasComposer = await checkComposer(client)
    if (!hasComposer) throw new CopilotReauthRequired()

    await openNewChat(client)
    await setEffort(client, effort)
    await sendPrompt(client, prompt)

    const turnCount = await getTurnCount(client)
    const fallback = await awaitResponse(client, turnCount - 1 >= 0 ? turnCount : 0, timeout, signal)
    const raw = await extractResponseRaw(client, turnCount - 1 >= 0 ? turnCount : 0)
    return raw || fallback
  } finally {
    await client.disconnect()
  }
}
