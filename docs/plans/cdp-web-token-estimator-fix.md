# Plan: Fix the CDP-Web Token Estimator

**Status:** Proposed
**Scope:** `packages/opencode/src/provider/cdp-web/` (session + model), no changes to the shim providers.
**Owner:** _tbd_
**Related providers:** Now Assist, Power Automate (shim), CDP-Web (Copilot browser)

---

## 1. Problem

The token counter shown in opencode is wrong for the CDP-Web (Copilot) provider. It is correct for Now Assist and Power Automate.

All three custom providers share the same tokenizer helper, `countTokens()` in `provider/shim/tokenizer.ts` (a `cl100k_base` tiktoken wrapper). The tokenizer itself is fine. The bug is in **how usage is computed per `doGenerate` call**, and it stems from a fundamental difference in how the providers talk to their backend.

### Why the shim providers are correct

`ShimLanguageModel.doGenerate` (`provider/shim/model.ts`) rebuilds and resends the **entire transcript** every turn:

- `const prompt = buildPrompt(options)` serializes all prior turns (both sides).
- `const inputTokens = countTokens(prompt)` therefore counts the whole cumulative context every call.

Because they resend everything, counting everything each turn happens to equal the true context size.

### Why CDP-Web is wrong

CDP-Web only sends a **delta** each turn. In `provider/cdp-web/model.ts`:

- Follow-up turns build `messageToSend = formatDeltaMessages(options.prompt, session.messagesSent)` (only the newest user/tool turn).
- `const inputTokens = countTokens(messageToSend)` (line ~920) counts only that delta.
- `outputTokens` (lines ~928 / ~939) counts only the single latest response.
- The returned `usage` block (lines ~949-953) reports those per-turn values.

So every turn the counter **resets to just-this-delta** and never accumulates. It is missing (a) all prior user/tool turns and (b) every response Copilot has sent back. Copilot retains the history server-side; opencode never re-sends it, so opencode never counts it.

`SessionState` (`provider/cdp-web/session.ts`) already persists across turns (it tracks `messagesSent`, `turnCount`, `conversationId`) but has **no token fields**, so there is nowhere a running total currently lives.

---

## 2. Goal

Make the CDP-Web usage report a **cumulative context estimate** that grows turn over turn, summing both directions:

> context so far = (every message we have sent) + (every response Copilot has sent back)

One input accumulator + one output accumulator, living on the session, never reset until the conversation ends. Their sum is the working context size.

---

## 3. Design decisions (settled)

1. **Cumulative on both sides.** The context window is everything sent plus everything received, accumulated. We keep one running input total and one running output total on `SessionState` and add each turn's contribution.

2. **Count the RAW response for output, not the parsed payload.** Tool-call JSON (`{"type":"tool_call",...}`) is plaintext the model generated. It is output tokens like any prose. The current code counts only the parsed branch (`parsed.calls.map(c => c.input)` or `parsed.text`), which undercounts the JSON envelope, commentary, and whitespace. The accumulator must count the full `finalText` captured from Copilot (after footer strip, before/independent of parsing).

3. **Ignore behind-the-scenes reasoning tokens.** Ephemeral chain-of-thought is (a) not capturable by opencode and (b) discarded after each turn rather than carried into the next turn's context, so it never becomes part of the growing conversation. It is a per-turn cost that evaporates, not part of the cumulative context. We deliberately do not try to count it.

4. **This is an estimate, by design.** We cannot see Copilot's injected system prompt, tool-orchestration scaffolding, RAG/Graph snippets, or the footer we strip. Copilot also silently trims/summarizes old turns once the window fills. So the odometer will read somewhat **below** Copilot's true internal context and may diverge on very long chats. That is acceptable for a usage indicator; it must not be treated as exact.

5. **Shim providers are untouched.** Their per-turn full-transcript count is already correct. No changes there.

---

## 4. Implementation

### 4.1 Add running totals to `SessionState`

File: `packages/opencode/src/provider/cdp-web/session.ts`

Add to the `SessionState` interface (near `messagesSent` / `turnCount`):

```ts
/** Cumulative input tokens sent to Copilot across all turns (estimate) */
cumulativeInputTokens: number
/** Cumulative output tokens received from Copilot across all turns (estimate) */
cumulativeOutputTokens: number
```

Initialize both to `0` in `createSession()` (alongside `messagesSent: 0, turnCount: 0`).

### 4.2 Accumulate each turn in `doGenerate`

File: `packages/opencode/src/provider/cdp-web/model.ts`

At the point where usage is computed today (~lines 918-941):

1. **Input side** — after `messageToSend` is finalized (post attachment/path stripping, i.e. the actual text handed to `sendPrompt`), count it and add to the session total:

   ```ts
   const turnInputTokens = countTokens(messageToSend)
   session.cumulativeInputTokens += turnInputTokens
   ```

   This works for both the initial turn (big preamble + tools + task) and delta turns, because in each case `messageToSend` is exactly what we pushed to Copilot that turn.

2. **Output side** — count the RAW captured response, not the parsed payload:

   ```ts
   const turnOutputTokens = countTokens(finalText) // post footer-strip, pre-parse
   session.cumulativeOutputTokens += turnOutputTokens
   ```

   Keep the existing `parsed` logic for building `content` / `finishReason` — only the token count changes source.

### 4.3 Report cumulative totals in the usage block

File: `packages/opencode/src/provider/cdp-web/model.ts` (~lines 949-953)

Report the session running totals instead of the single-turn values:

```ts
usage: {
  inputTokens: {
    total: session.cumulativeInputTokens,
    noCache: session.cumulativeInputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: session.cumulativeOutputTokens,
    text: session.cumulativeOutputTokens,
    reasoning: undefined,
  },
  raw: undefined,
},
```

The indicator in opencode now behaves like an odometer for the conversation instead of a per-turn trip meter.

### 4.4 (Optional) Debug log per turn

Behind the existing `dlog` helper, emit per-turn and cumulative numbers so the totals can be watched climbing during testing:

```ts
dlog(`[cdp-web] tokens turn: in=${turnInputTokens} out=${turnOutputTokens} | cumulative: in=${session.cumulativeInputTokens} out=${session.cumulativeOutputTokens}`)
```

---

## 5. Edge cases to handle

- **Resume / reopen (`resumedExisting`).** On restart we reopen an existing Copilot conversation and only send the latest turn. The accumulators start from 0 for the new `SessionState`, so the reported context after resume will be lower than the true (server-side) history. Document this; optionally persist/restore the two totals alongside the conversation ref (`saveConversationRef` / `loadConversationRef`) if we want the odometer to survive restarts. **Recommended: log-only for v1, persistence as a follow-up.**
- **WS vs DOM path.** Both paths converge on `finalText` before parsing — count there so the number is path-independent.
- **Initial vs delta.** Both covered because we count `messageToSend` as-sent in every branch.
- **Rebind (fingerprint change).** `ensureBoundSession` abandons the old session and creates a new one; the counter resets with the new conversation, which is correct (new conversation = new context).

---

## 6. Testing / verification

1. **Multi-turn delta growth.** Start a CDP-Web conversation, issue several tool-call round-trips, confirm the reported input/output totals increase monotonically and never reset to a single-turn value.
2. **Tool-call JSON counted.** A turn whose response is pure tool-call JSON must add a non-trivial output count (previously it counted only extracted `input` strings).
3. **Shim unaffected.** Run a Now Assist / Power Automate turn and confirm reported usage is unchanged.
4. **Sanity vs chars.** Spot-check `cumulative tokens ≈ cumulative chars / ~4` for English-ish content.

---

## 7. Out of scope

- Matching Copilot's exact internal token count (impossible — hidden system prompt, RAG snippets, silent trimming).
- Counting ephemeral reasoning tokens (not capturable; discarded across turns).
- Any change to the shared `countTokens` tokenizer or to the shim providers.
