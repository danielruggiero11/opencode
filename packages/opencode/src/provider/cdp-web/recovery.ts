/**
 * recovery.ts — Conversation persistence & re-open for the cdp-web provider.
 *
 * Key insight (confirmed against the live DOM): every persistent Copilot
 * conversation has a stable URL of the form
 *     https://m365.cloud.microsoft/chat/conversation/<guid>
 * and the Copilot-generated title appears identically in:
 *   - the browser tab title (via /json listTargets)
 *   - the breadcrumb button aria-label
 *   - each sidebar <guid>"> link
 *
 * So recovery does NOT require scraping/hunting the sidebar. We capture the
 * conversation GUID once (after the first turn, when Copilot has created it)
 * and later just navigate the tab straight back to it. The sidebar match is
 * only a fallback for when we somehow have a title but no GUID.
 */
import { CDPClient } from "./client"

const CHAT_BASE = "https://m365.cloud.microsoft/chat"
const CONV_PATH = "/chat/conversation/"

export interface ConversationInfo {
  /** Copilot-generated conversation GUID, or null if not yet assigned (fresh/temporary chat) */
  id: string | null
  /** Copilot-generated conversation title, or null if not yet titled */
  title: string | null
  /** Full current URL of the tab */
  url: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Read the current conversation's id + title directly from the page.
 * The GUID comes from the URL; the title from the breadcrumb (fallback: document.title).
 */
export async function getConversationInfo(client: CDPClient): Promise<ConversationInfo> {
  const raw = await client.evaluate(`
    (() => {
      const url = location.href;
      let id = null;
      const m = url.match(/\\/chat\\/conversation\\/([0-9a-fA-F-]{36})/);
      if (m) id = m[1];
      const crumb = document.querySelector('button.fui-BreadcrumbButton[aria-label]');
      const title = crumb ? crumb.getAttribute('aria-label').trim()
                          : (document.title || '').replace(/\\s*[-|].*$/, '').trim() || null;
      return JSON.stringify({ id, title, url });
    })()
  `)
  try {
    return JSON.parse(raw) as ConversationInfo
  } catch {
    return { id: null, title: null, url: "" }
  }
}

/**
 * Poll until the conversation has been assigned a GUID (Copilot creates it
 * shortly after the first user turn in a persistent chat). Returns the info
 * once an id appears, or the last-seen info if the timeout elapses.
 */
export async function waitForConversationId(
  client: CDPClient,
  timeoutMs = 8000,
): Promise<ConversationInfo> {
  const deadline = Date.now() + timeoutMs
  let last = await getConversationInfo(client)
  while (Date.now() < deadline) {
    if (last.id) return last
    await sleep(500)
    last = await getConversationInfo(client)
  }
  return last
}

/**
 * PRIMARY recovery path: navigate the tab straight to a known conversation GUID.
 * Works even if the conversation is not currently in the sidebar's loaded window.
 * Returns true once the composer is back and the URL matches.
 */
export async function openConversationById(
  client: CDPClient,
  id: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const targetUrl = `${CHAT_BASE}/conversation/${id}`
  await client.evaluate(`window.location.href = ${JSON.stringify(targetUrl)}`)
  await sleep(2500)
  await client.send("Runtime.enable", {})

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await client.evaluate(`
      (() => {
        const onConv = location.href.includes(${JSON.stringify(CONV_PATH + id)});
        const composer = document.getElementById('m365-chat-editor-target-element')
          || document.querySelector('[data-testid="chat-input"]')
          || document.querySelector('div[contenteditable="true"]');
        return !!(onConv && composer);
      })()
    `)
    if (ok) return true
    await sleep(500)
    await client.send("Runtime.enable", {})
  }
  return false
}

/**
 * FALLBACK recovery path: find a conversation in the sidebar by exact title
 * (or by GUID href if we have it) and click it with a real CDP mouse event.
 * Only the most-recent ~20-40 conversations are in the DOM, so this can miss
 * older chats — prefer openConversationById when a GUID is known.
 *
 * Returns { ok, id } — id is the GUID extracted from the matched href.
 */
export async function openConversationInSidebar(
  client: CDPClient,
  match: { title?: string; id?: string },
): Promise<{ ok: boolean; id: string | null }> {
  const locate = await client.evaluate(`
    (() => {
      const wantId = ${JSON.stringify(match.id || "")};
      const wantTitle = ${JSON.stringify((match.title || "").trim().toLowerCase())};
      const links = [...document.querySelectorAll('a[href*="${CONV_PATH}"]')];
      let el = null;
      if (wantId) el = links.find(a => (a.getAttribute('href') || '').includes(wantId));
      if (!el && wantTitle) {
        el = links.find(a => ((a.getAttribute('aria-label') || a.textContent || '').trim().toLowerCase()) === wantTitle);
      }
      if (!el) return null;
      const href = el.getAttribute('href') || '';
      const m = href.match(/([0-9a-fA-F-]{36})/);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, id: m ? m[1] : null });
    })()
  `)
  if (!locate) return { ok: false, id: null }
  let loc: { x: number; y: number; id: string | null }
  try {
    loc = JSON.parse(locate)
  } catch {
    return { ok: false, id: null }
  }
  await client.clickXY(loc.x, loc.y)
  await sleep(1500)
  await client.send("Runtime.enable", {})
  return { ok: true, id: loc.id }
}

/**
 * Unified re-open: try GUID navigation first, fall back to sidebar match.
 */
export async function reopenConversation(
  client: CDPClient,
  ref: { id?: string | null; title?: string | null },
): Promise<boolean> {
  if (ref.id) {
    if (await openConversationById(client, ref.id)) return true
  }
  if (ref.title) {
    const res = await openConversationInSidebar(client, { title: ref.title, id: ref.id || undefined })
    return res.ok
  }
  return false
}
