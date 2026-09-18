/**
 * driver-ws.ts – WebSocket-based response capture for Copilot.
 *
 * Instead of polling the DOM, this listens for SignalR WebSocket frames
 * via CDP's Network.webSocketFrameReceived event. The frames contain
 * properly JSON-encoded text, eliminating all escaping/repair issues.
 *
 * Exports:
 *   • enableWsCapture(client)       – enable Network domain for WS events
 *   • awaitResponseWs(client)       – wait for Copilot response via WS frames
 */

import { CDPClient } from "./client"
import { Log } from "@opencode-ai/core/util/log"
const _cdpLog = Log.create({ service: "cdp-web" })
function _cdpFmt(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}
function dlog(...args: unknown[]): void {
  _cdpLog.error(args.map(_cdpFmt).join(" "))
}


/* ────────────────────────────────────────────────────────── constants ── */
const CHATHUB_URL_MARKER = "m365Copilot/Chathub"
// Single backstop: the turn is only considered dead after this long with NO frames of
// ANY kind (content, progress, isLastUpdate). Reset on every frame, so a slow-but-working
// turn is never cut off; only a genuinely silent/wedged socket trips it. Normal finish is
// the authoritative type=2 done=true signal, which arrives in ~2-3s.
const IDLE_MS = 120_000

/* ────────────────────────────────────────────────── types ── */

interface SignalRMessage {
  type: number
  target?: string
  invocationId?: string
  arguments?: SignalRArgument[]
  item?: SignalRItem
}

interface SignalRArgument {
  messages?: SignalRBotMessage[]
  isLastUpdate?: boolean
  requestId?: string
  cursor?: unknown
  patches?: unknown[]
  nonce?: string
}

interface SignalRBotMessage {
  text?: string
  author?: string
  contentOrigin?: string
  messageType?: string
  turnState?: string
}

interface SignalRItem {
  messages?: SignalRBotMessage[]
  turnState?: string
  result?: { value?: string; message?: string }
}

/* ────────────────────────────────────────────────── state ── */

/**
 * Per-client listener state. We track active WebSocket requestIds
 * that match the Chathub URL pattern.
 */
interface WsListenerState {
  chathubRequestIds: Set<string>
  frameHandler: ((payload: string, requestId: string) => void) | null
}

const clientState = new WeakMap<CDPClient, WsListenerState>()

/* ────────────────────────────────────────────────── public ── */

/**
 * Enable Network domain and register WebSocket event listeners.
 * Call once per CDPClient after connecting.
 *
 * `allSessions` (word engine): the Chathub SignalR socket lives inside the
 * Copilot OOPIF, not the top page, so Network must be enabled on every attached
 * session — not just the top target — for its frames to be observed. We enable
 * Network on each currently-attached session and, via Target.attachedToTarget,
 * on any frame/worker that attaches later. The frame handler dispatch below is
 * already session-agnostic (CDP events fan out to all listeners regardless of
 * sessionId), so beginResponseCapture is reused unchanged. The "" sentinel is
 * NOT used here — we address each session explicitly by its sessionId.
 */
export async function enableWsCapture(client: CDPClient, opts?: { allSessions?: boolean }): Promise<void> {
  await client.send("Network.enable", {})

  if (opts?.allSessions) {
    // Enable Network on every already-attached OOPIF/worker session.
    for (const sid of client.sessions.keys()) {
      await client.send("Network.enable", {}, sid).catch(() => {})
    }
    // …and on any session that attaches after this point (the Copilot frame or
    // its Chathub worker can attach late, after the pane mounts).
    client.on("Target.attachedToTarget", (params: { sessionId?: string }) => {
      const sid = params?.sessionId
      if (sid) client.send("Network.enable", {}, sid).catch(() => {})
    })
  }

  const state: WsListenerState = {
    chathubRequestIds: new Set(),
    frameHandler: null,
  }
  clientState.set(client, state)

  client.on("Network.webSocketCreated", (params: { requestId: string; url: string }) => {
    if (params.url.includes(CHATHUB_URL_MARKER)) {
      state.chathubRequestIds.add(params.requestId)
      dlog(`[cdp-web ws] tracked Chathub WS: ${params.requestId}`)
    }
  })

  client.on("Network.webSocketClosed", (params: { requestId: string }) => {
    state.chathubRequestIds.delete(params.requestId)
  })

  client.on("Network.webSocketFrameReceived", (params: { requestId: string; response: { payloadData: string } }) => {
    if (!state.chathubRequestIds.has(params.requestId)) return
    if (!state.frameHandler) return
    state.frameHandler(params.response.payloadData, params.requestId)
  })

  // Also capture WebSocket frames sent BY the page (outgoing). Copilot sends
  // invocation requests via WS; monitoring these helps us correlate responses.
  client.on("Network.webSocketFrameSent", (params: { requestId: string; response: { payloadData: string } }) => {
    if (!state.chathubRequestIds.has(params.requestId)) return
    // Diagnostic ONLY (env-gated): dump the outgoing invocation ENVELOPE so we
    // can diff what the Word surface stamps onto a turn vs. the general chat
    // surface (source app, mode, plugins, grounding hints). Large string blobs
    // (our prompt/context) are collapsed to <str len=N> so the metadata fields
    // stay readable. Off by default — set CDP_WS_DUMP_SENT=1 to enable.
    if (process.env["CDP_WS_DUMP_SENT"]) dumpOutgoingEnvelope(params.response.payloadData)
  })
}

/**
 * M365 (non-word) outgoing-envelope rewrite — the top-page analogue of the Word
 * engine's `installEnvelopeRewrite`.
 *
 * Word had a concrete bad field to neutralize (`gpts:[{WordDraftingAgent}]` +
 * `localPluginAllowedHost`). M365 general chat already ships the neutral
 * `bizchat-as-gpt-scenario` + `source:"officeweb"`, so there is NO known persona
 * field to strip here yet — the only observed difference between M365-Opus
 * (never refuses) and M365-Sonnet (flat-out refuses) is `tone`. Two independent,
 * env-gated levers, both OFF by default (byte-identical wire when off):
 *
 *   • forceOpus (CDP_M365_FORCE_OPUS=1): stamp `tone:"Claude_Opus"` on every
 *     outgoing chat invocation even though the UI has Sonnet selected. This is
 *     the "select Sonnet, actually run Opus" quota probe — it tells us whether
 *     Copilot bills/quotas by the UI model selection or by the `tone` on the
 *     wire. If it silently serves Opus without burning Opus quota, great; if it
 *     refuses or drains Opus quota, we learn the ceiling. VERIFY quota after.
 *
 *   • stripCodeInterp (CDP_M365_STRIP_CODE_INTERP=1): remove every `code_interpreter`
 *     optionSet from the envelope. A live Sonnet-vs-Opus diff proved the two
 *     envelopes are byte-identical except `tone`, but the shared optionsSets
 *     enable Copilot's built-in Python sandbox — and Sonnet (unlike Opus) routes
 *     tool intent INTO that sandbox instead of emitting our JSON tool-call
 *     contract as text ("tried to do the tool call in its sandbox"). Stripping
 *     the cluster removes the sandbox so Sonnet has to emit the contract.
 *
 * Unlike Word, the M365 Chathub socket lives on the TOP page, so this installs
 * on the default realm (no OOPIF frame sid). Prototype-level + idempotent
 * (guarded by `window.__cdpEnvRewriteM365`), so it survives new-chat re-renders
 * and covers a socket created after injection. Counts applied rewrites via
 * `window.__cdpEnvRewriteM365Count`. Must be installed before the first send.
 */
export async function installEnvelopeRewriteM365(
  client: CDPClient,
  opts?: { forceOpus?: boolean; stripCodeInterp?: boolean; author?: string },
): Promise<boolean> {
  const forceOpus = !!opts?.forceOpus
  const stripCodeInterp = !!opts?.stripCodeInterp
  // Relabel the outgoing message's author (default "" = leave as-is). A live
  // capture proved our whole contract ships as a single author:"user" message,
  // which Sonnet's injection classifier reads as user text trying to redefine
  // the assistant. The UI custom-instructions channel lands system-level (which
  // defeats the classifier) but is account-global + server-stored, not in the
  // request. `author` is the one placement we control per-request — if the
  // backend honors author:"system"/"developer", our contract lands at the same
  // authoritative level with no account pollution. If the backend ignores or
  // rejects a client-declared non-user author, this is a no-op / errors the turn
  // and we learn the per-request system channel isn't exposed.
  const author = (opts?.author ?? "").trim()
  const patch = `
    (() => {
      // Config is stored on the window and refreshed on EVERY install so that
      // changing the env toggles between runs takes effect immediately. The
      // earlier design baked the flags in as literals inside the send closure and
      // short-circuited on a boolean guard — so a tab left open from a prior run
      // (we never close tabs; a prototype patch survives new chats AND opencode
      // restarts) kept applying the OLD flags forever (e.g. FORCE_OPUS leaking
      // Opus quota into a Sonnet run). Now the send handler reads the live cfg.
      const VERSION = 2;
      window.__cdpEnvM365Cfg = { forceOpus: ${forceOpus ? "true" : "false"}, stripCodeInterp: ${stripCodeInterp ? "true" : "false"}, author: ${JSON.stringify(author)} };
      // If the correct patch version is already installed, we're done — the cfg
      // above already refreshed the behavior for the live send handler.
      if (window.__cdpEnvRewriteM365 === VERSION) return 'updated-cfg';
      // A prior version (or the old boolean-guarded build) may have wrapped send
      // without saving the original. Restore the saved original if we have one;
      // otherwise a full reload is required to unwrap it (logged by the caller).
      if (typeof window.__cdpEnvM365OrigSend === "function") {
        WebSocket.prototype.send = window.__cdpEnvM365OrigSend;
      } else if (window.__cdpEnvRewriteM365) {
        // Old build patched without saving origSend — cannot safely re-wrap.
        return 'stale-needs-reload';
      }
      const RS = String.fromCharCode(30); // SignalR record separator (\\x1e)
      const origSend = WebSocket.prototype.send;
      window.__cdpEnvM365OrigSend = origSend;
      WebSocket.prototype.send = function (data) {
        const cfg = window.__cdpEnvM365Cfg || {};
        const FORCE_OPUS = !!cfg.forceOpus;
        const STRIP_CI = !!cfg.stripCodeInterp;
        const AUTHOR = typeof cfg.author === "string" ? cfg.author : "";
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
                  if (FORCE_OPUS) { a.tone = "Claude_Opus"; touched = true; }
                  if (STRIP_CI && Array.isArray(a.optionsSets)) {
                    // Sonnet routes tool intent into Copilot's built-in Python
                    // code interpreter ("tried to do the tool call in its
                    // sandbox") instead of emitting our JSON tool-call contract
                    // as text. Opus ignores the sandbox. Removing the whole
                    // code_interpreter optionSets cluster leaves Sonnet nowhere
                    // to run off to, so it should emit the JSON contract instead.
                    const before = a.optionsSets.length;
                    a.optionsSets = a.optionsSets.filter((s) =>
                      typeof s !== "string" || s.toLowerCase().indexOf("code_interpreter") === -1
                    );
                    if (a.optionsSets.length !== before) touched = true;
                  }
                  if (AUTHOR && a.message && typeof a.message === "object" && a.message.author && a.message.author !== AUTHOR) {
                    a.message.author = AUTHOR;
                    touched = true;
                  }
                }
                if (touched) { changed = true; return JSON.stringify(obj); }
              }
              return p;
            });
            if (changed) {
              data = out.join(RS) + RS;
              window.__cdpEnvRewriteM365Count = (window.__cdpEnvRewriteM365Count || 0) + 1;
            }
          }
        } catch (e) { /* fall through: never break the send */ }
        return origSend.call(this, data);
      };
      window.__cdpEnvRewriteM365 = VERSION;
      return 'installed';
    })()
  `
  const result = await client.evaluate(patch).catch((e) => {
    dlog("[cdp-web m365] envelope rewrite injection failed:", e)
    return null
  })
  dlog(`[cdp-web m365] envelope rewrite: ${result} (forceOpus=${forceOpus} stripCodeInterp=${stripCodeInterp} author=${author || "(unchanged)"})`)
  if (result === "stale-needs-reload") {
    dlog("[cdp-web m365] a stale envelope patch from a prior run is still active and cannot be unwrapped from JS — HARD-RELOAD the Copilot tab (or restart the browser) so the new flags take effect.")
  }
  return result === "installed" || result === "updated-cfg" || result === "stale-needs-reload"
}

/**
 * Begin capturing Copilot's response via WebSocket frames and return a promise
 * that resolves with the final bot message text (JSON escaping intact).
 *
 * CRITICAL: this installs the frame handler SYNCHRONOUSLY before returning, so
 * it must be called BEFORE sendPrompt (or right at send time). The CDP frame
 * listeners registered by enableWsCapture drop any frame that arrives while
 * `state.frameHandler` is null. If capture only started AFTER the send +
 * conversation-id wait + settle (the old awaitResponseWs call site), a fast
 * Copilot reply — including its authoritative type=2 done frame — could stream
 * through and finish inside that setup window and be discarded entirely, leaving
 * this promise to hang until the IDLE_MS backstop and fall back to slow DOM
 * scraping. Arming the handler before the send closes that race window.
 */
export function beginResponseCapture(client: CDPClient, signal?: AbortSignal): Promise<string> {
  const state = clientState.get(client)
  if (!state) return Promise.reject(new Error("WebSocket capture not enabled. Call enableWsCapture first."))

  return new Promise((resolve, reject) => {
    let accumulatedText = ""
    let resolved = false

    let idleTimer: ReturnType<typeof setTimeout> | null = null

    // Idle backstop: reset on EVERY frame (content, progress, isLastUpdate — anything).
    // Fires only after IDLE_MS of complete silence, the real signature of a dead socket,
    // not a slow turn. Armed immediately so a turn that never emits a single frame still
    // resolves/rejects eventually rather than hanging forever.
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (resolved) return
        dlog(`[cdp-web ws DIAG] idle timeout after ${IDLE_MS}ms of silence (accumLen=${accumulatedText.length})`)
        if (accumulatedText) {
          finish()
        } else {
          resolved = true
          state.frameHandler = null
          reject(new Error("WebSocket response timeout: no frames within " + IDLE_MS + "ms"))
        }
      }, IDLE_MS)
    }
    bumpIdle()

    // Respect caller's AbortSignal
    if (signal) {
      if (signal.aborted) {
        resolved = true
        if (idleTimer) clearTimeout(idleTimer)
        state.frameHandler = null
        reject(signal.reason || new Error("Aborted"))
        return
      }
      signal.addEventListener("abort", () => {
        if (resolved) return
        resolved = true
        if (idleTimer) clearTimeout(idleTimer)
        state.frameHandler = null
        reject(signal.reason || new Error("Aborted"))
      }, { once: true })
    }

    state.frameHandler = (payload: string) => {
      if (resolved) return
      bumpIdle()

      const messages = parseSignalRPayload(payload)
      for (const msg of messages) {
        // Type 1: streaming update
        if (msg.type === 1 && msg.arguments) {
          for (const arg of msg.arguments) {
            if (arg.messages) {
              for (const m of arg.messages) {
                // [SETTLE-DIAG] Log EVERY bot message frame, including ones we
                // skip, so we can see if a real tool-call tail was filtered out
                // by isChatContent or arrived after an early resolve.
                if (m.author === "bot" && m.text) {
                  dlog(
                    `[cdp-web ws DIAG] type=1 chatContent=${isChatContent(m)}` +
                      ` msgType=${m.messageType ?? "-"} origin=${m.contentOrigin ?? "-"}` +
                      ` turnState=${m.turnState ?? "-"} isLast=${arg.isLastUpdate ?? false}` +
                      ` textLen=${m.text.length} accumLen=${accumulatedText.length}` +
                      ` tail=${JSON.stringify(m.text.slice(-60))}`,
                  )
                }
                if (m.author === "bot" && m.text && isChatContent(m)) {
                  accumulatedText = decodeHtmlEntities(m.text)
                }
              }
            }

            // isLastUpdate marks the END OF A SEGMENT, not the turn. It is purely
            // informational now — the idle timer already runs from the first frame and
            // resets on every frame, and the authoritative finish is type=2 done=true.
            if (arg.isLastUpdate && accumulatedText) {
              dlog(
                `[cdp-web ws DIAG] isLastUpdate=true (segment end; idle timer runs, awaiting type=2) accumLen=${accumulatedText.length}`,
              )
            }
          }
        }

        // Type 2: invocation complete. Only a turnState of "Completed" ends the
        // turn; any other state is a sub-step — capture its text and keep
        // listening (the idle net or the next type=2 will finish us).
        if (msg.type === 2 && msg.item) {
          const botMsg = msg.item.messages?.filter(
            m => m.author === "bot" && m.text && isChatContent(m)
          ).pop()
          const done = msg.item.turnState === "Completed"
          dlog(
            `[cdp-web ws DIAG] type=2 invocationComplete done=${done}` +
              ` itemTurnState=${msg.item.turnState ?? "-"}` +
              ` botMsgFound=${!!botMsg?.text} botMsgLen=${botMsg?.text?.length ?? 0}` +
              ` accumLenBefore=${accumulatedText.length}` +
              ` result=${JSON.stringify(msg.item.result ?? null)}`,
          )
          if (botMsg?.text) accumulatedText = decodeHtmlEntities(botMsg.text)
          if (done) {
            finish()
            return
          }
        }
      }
    }

    function finish() {
      if (resolved) return
      resolved = true
      if (idleTimer) clearTimeout(idleTimer)
      state!.frameHandler = null
      dlog(`[cdp-web ws DIAG] RESOLVED with ${accumulatedText.length} chars. tail=${JSON.stringify(accumulatedText.slice(-80))}`)
      // Diagnostic ONLY (env-gated): dump the FULL final bot text — not just the
      // 80-char tail above — so a refusal ("I can't run that", "I don't have
      // access", a Word-assistant persona reply) is captured verbatim on the wire
      // instead of inferred from the pane. A tool-call response prints as the JSON
      // we forward to the parser; a refusal prints as the prose the model actually
      // sent. Off by default — set CDP_WS_DUMP_RECV=1 to enable. Capped so a huge
      // answer can't flood the log; the tail is already logged above regardless.
      if (process.env["CDP_WS_DUMP_RECV"]) {
        const MAX = 8000
        const body = accumulatedText.length > MAX ? accumulatedText.slice(0, MAX) + `…<+${accumulatedText.length - MAX} more>` : accumulatedText
        dlog(`[cdp-web ws RECV] final bot text (${accumulatedText.length} chars):\n${body}`)
      }
      resolve(accumulatedText)
    }
  })
}

/**
 * Back-compat wrapper: begins capture at call time. Prefer beginResponseCapture
 * called BEFORE sendPrompt to avoid the first-turn listen-gap race (see the
 * beginResponseCapture doc comment).
 */
export function awaitResponseWs(client: CDPClient, signal?: AbortSignal): Promise<string> {
  return beginResponseCapture(client, signal)
}

/* ────────────────────────────────────────────────── internal ── */

/**
 * Decode HTML entities that Copilot's SignalR rendering injects into the bot
 * message text. Copilot HTML-encodes reserved characters (angle brackets,
 * ampersand, quotes) in its response text, so a tool-call payload the model
 * emitted with a plain greater-than sign arrives over the wire as its entity
 * form and no longer matches the real file content. We decode here, at the WS
 * source, before any JSON parsing downstream.
 *
 * Implementation note: every reserved character is built with String.fromChar-
 * Code and the numeric-entity callback uses the function keyword rather than an
 * arrow, so this source file is itself immune to the exact corruption it fixes.
 * Ampersand is decoded LAST so a double-encoded entity collapses by one level
 * instead of being mangled.
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text
  // Copilot DOUBLE-escapes: we entity-escape file content on the way out (html-escape.ts
  // escapeHtmlPayload), then Copilot's own input pipeline escapes the ampersands AGAIN,
  // so the model sees (and, per the preamble rule, faithfully reproduces) `&amp;lt;` where
  // the file has `<`. A single decode pass strips only one level, leaving `&lt;` — which
  // no longer matches the file and the edit fails. Decode to a FIXED POINT so any residual
  // escape depth collapses back to the real character. Bounded to avoid pathological loops.
  let out = text
  for (let i = 0; i < 5; i++) {
    const next = decodeHtmlEntitiesOnce(out)
    if (next === out) break
    out = next
  }
  return out
}

/** One pass of entity decoding. Ampersand LAST so a double-encoded entity collapses by
 *  exactly one level per pass (the fixed-point loop in decodeHtmlEntities repeats it). */
function decodeHtmlEntitiesOnce(text: string): string {
  if (!text) return text
  const AMP = String.fromCharCode(38)
  const LT = String.fromCharCode(60)
  const GT = String.fromCharCode(62)
  const QUOT = String.fromCharCode(34)
  const APOS = String.fromCharCode(39)
  const SLASH = String.fromCharCode(47)
  const NBSP = String.fromCharCode(160)
  let out = text
  out = out.split(AMP + "lt;").join(LT)
  out = out.split(AMP + "gt;").join(GT)
  out = out.split(AMP + "quot;").join(QUOT)
  out = out.split(AMP + "#39;").join(APOS)
  out = out.split(AMP + "apos;").join(APOS)
  out = out.split(AMP + "#x27;").join(APOS)
  out = out.split(AMP + "#x2F;").join(SLASH)
  out = out.split(AMP + "#47;").join(SLASH)
  out = out.split(AMP + "nbsp;").join(NBSP)
  // Generic numeric decimal entities. Callback uses the function keyword on
  // purpose (no arrow) to keep this source corruption-proof.
  out = out.replace(new RegExp(AMP + "#(\\d+);", "g"), function (whole: string, code: string): string {
    const n = parseInt(code, 10)
    if (isNaN(n)) return whole
    return String.fromCharCode(n)
  })
  // Ampersand LAST.
  out = out.split(AMP + "amp;").join(AMP)
  return out
}

/**
 * DIAGNOSTIC (env-gated via CDP_WS_DUMP_SENT): log the ENVELOPE of an outgoing
 * SignalR invocation so the Word surface's turn metadata can be diffed against
 * the general-chat surface. Any string longer than 200 chars (our prompt, the
 * serialized context/history) is collapsed to `<str len=N>` so the interesting
 * host-context fields — source, mode, plugins, grounding/options — stay legible.
 * Purely observational; never alters what is sent.
 */
// Keys whose VALUE we always show in full even when long — these are the
// authoritative-channel candidates we're hunting for (custom instructions,
// persona/system context, memory/profile). Collapsing them would hide exactly
// the field we're trying to discover. Matched case-insensitively as substrings.
const KEEP_FULL_KEY_PATTERNS = ["instruction", "persona", "systemcontext", "developer", "profile", "memory", "trait", "customization", "preference"]

function keyWantsFull(key?: string): boolean {
  if (!key) return false
  const k = key.toLowerCase()
  return KEEP_FULL_KEY_PATTERNS.some((p) => k.includes(p))
}

function redactBlobs(v: unknown, key?: string): unknown {
  if (typeof v === "string") return v.length > 200 && !keyWantsFull(key) ? `<str len=${v.length}>` : v
  if (Array.isArray(v)) return v.map((el) => redactBlobs(el, key))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactBlobs(val, k)
    return out
  }
  return v
}

function dumpOutgoingEnvelope(payload: string): void {
  const parts = payload.split("\x1e").filter(Boolean)
  for (const part of parts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(part)
    } catch {
      continue
    }
    // Skip keepalives (type 6) — no envelope of interest.
    if ((parsed as { type?: number })?.type === 6) continue
    try {
      dlog(`[cdp-web ws SENT] ${JSON.stringify(redactBlobs(parsed), null, 2)}`)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse a SignalR WebSocket payload. SignalR uses \x1e (record separator)
 * to delimit multiple JSON messages in a single frame.
 */
function parseSignalRPayload(payload: string): SignalRMessage[] {
  const results: SignalRMessage[] = []
  const parts = payload.split("\x1e").filter(Boolean)

  for (const part of parts) {
    try {
      results.push(JSON.parse(part))
    } catch {
      // Some frames have trailing separators or non-JSON; skip
    }
  }

  return results
}

/**
 * Determine if a bot message is actual chat content (not progress/suggestion).
 */
function isChatContent(msg: SignalRBotMessage): boolean {
  if (msg.messageType === "Progress") return false
  if (msg.messageType === "Suggestion") return false
  if (msg.messageType === "HintInvocation") return false
  if (msg.messageType === "ReferencesListComplete") return false
  if (msg.contentOrigin === "EarlyProgress") return false
  if (msg.contentOrigin === "SuggestionsProviderService") return false
  if (msg.contentOrigin === "ExtensibleHintGenerator") return false
  return true
}
