# cdp-web: Compaction Fix + Temp/Tracked Unification + Compaction Rollover

Self-contained implementation map. Written for an implementer with NO prior context on this
investigation. Read top to bottom.

All `model.ts` / `llm.ts` / `compaction.ts` line numbers are APPROXIMATE references captured
before any edits and WILL DRIFT as changes land. Use them to locate code, not as exact anchors.
Provider code lives in `packages/opencode/src/provider/cdp-web/`. Core compaction lives in
`packages/opencode/src/session/compaction.ts`. Cross-layer hooks are wired in
`packages/opencode/src/session/llm.ts`.

## The three efforts (in dependency order)

- **PART 0 - Compaction-turn fix (prerequisite bug fix).** Today, running `/compact` while on
  a cdp-web model produces a GREETING instead of a summary. Fix the provider so a compaction
  turn actually summarizes. Standalone; does not depend on Parts A or B. MUST ship first
  because everything else and the second diagnostic capture depend on a working summary.
- **PART A - Unify temp and tracked.** Make the `temporary` flag differ from tracked by
  essentially one thing (the "Temporary chat" toggle click at fresh-start). Everything else
  (GUID capture, ref persistence, token totals, drift guard, resume/reopen) becomes shared.
  Delivers "invisible in navbar but recoverable."
- **PART B - Compaction rollover.** On the build turn AFTER a compaction, roll the Copilot
  conversation over to a NEW conversation seeded with the summary. This is what actually
  shrinks context for cdp-web. Built on the unified path from Part A so it is a single flow.

**Sequencing:** Part 0 -> Capture 2 (diagnostic) -> Part A -> Part B. See the Sequencing
section at the end for detail.

---

## Motivating facts (established via code reading + a live diagnostic capture on 2026-08-07)

1. **Copilot is stateful server-side per tab; the provider sends only DELTAS**
   (`formatDeltaMessages` from `session.messagesSent`). opencode's client-side compaction
   rewrites its own message view but does NOT shrink the Copilot conversation held in the tab.
   The ONLY way to actually reduce context for cdp-web is to move to a NEW Copilot conversation.
2. **A fresh Copilot conversation has no GUID until AFTER the first send**
   (`waitForConversationId`, recovery.ts). So a rollover's new id cannot be known at `/compact`
   time. The rollover MUST be deferred to the next user message.
3. **`/compact` and auto-overflow both funnel through the same core path**
   (`compaction.create` -> `compaction.process`, prompt.ts around 1308-1327 and 1475-1483).
   There is NO cdp-web branch in core, and we are NOT adding one. All cdp-web logic stays in
   the provider (respects AGENTS.md "no provider logic bleed").
4. **The `compaction` agent has NO configured model**, so it inherits the active chat model
   (compaction.ts around 338-341). PRODUCT RULE: this is CORRECT and stays. Compaction runs on
   whatever model is active. We do NOT add a `compaction` agent model override. On cdp-web this
   means the summary is generated on the Copilot tab - which is fine once Part 0 fixes how the
   provider handles that turn.
5. **Temp chats DO have a real GUID** (empirically observed: `.../chat/conversation/<guid>`
   exists while the chat is live). Direct navigation reopens it - UNTIL you send a message,
   which promotes it to persistent (it then gets a left-navbar line). Capturing the GUID is a
   passive READ and does NOT promote; only a WRITE (sending a message) promotes.
6. **The user's real requirement for "temp" is "NOT in the left navbar"** (they share this
   Copilot with non-opencode use and do not want opencode sessions cluttering history), NOT
   "ephemeral/unrecoverable." So "invisible but recoverable" is the desired best-of-both-worlds.
   Promotion-on-recovery is acceptable because it only happens the moment we actually cash in a
   recovery - exactly when visibility is fine.
7. **Microsoft does not document the un-persisted temp GUID TTL.** Compliance retention
   (default 30 days, a Purview/Exchange copy) is a SEPARATE, non-reopenable thing. So we treat
   the temp GUID as "recoverable while it lives, never depended upon for long-lived recovery."

---

# PART 0 - Compaction-turn fix (prerequisite)

## 0.1 The bug (proven by capture 2026-08-07)

With no model override, the `compaction` agent inherits `opus-temp` and runs the summarization
ON the Copilot tab (correct per fact #4). But the cdp-web provider MISHANDLES that turn in two
ways, so instead of a summary the user got a greeting
("Hey! Yes, I can hear you loud and clear... What's the task?"):

1. **Fingerprint change -> rebind -> lost history.** A compaction turn carries a DIFFERENT
   system prompt (the summarizer prompt) and DIFFERENT tools (none). `computeFingerprint`
   (session.ts) therefore yields a new value, `ensureBoundSession` (model.ts) treats it as a
   new session, and REBINDS to a fresh tab that never saw the conversation. So Copilot had no
   history to summarize.
2. **System prompt stripped.** Even without the rebind, `formatInitialMessage` (model.ts)
   REPLACES the incoming system prompt with cdp-web's own Copilot coding preamble, so Copilot
   never sees the "You are an anchored context summarization assistant" instructions.

## 0.2 The fix (all provider-side; mirrors the existing `isTitleTurn` special-casing)

There is a precedent to copy: title-generation turns are already special-cased via
`isTitleTurn(systemContent)` (model.ts around 220) which routes to `formatTitleMessage`
instead of `formatInitialMessage`. Do the same for compaction.

- **Detect it:** add `isCompactionTurn(systemContent)`. Detection signal is LOCKED from the
  capture - the compaction turn's SYSTEM prompt contains:
  - `"You are an anchored context summarization assistant"`
  - `"Summarize only the conversation history you are given"`
  and its final USER message contains
  `"Create a new anchored summary from the conversation history"`. A substring check on the
  system content is sufficient and robust (same approach as `isTitleTurn`).
- **PIN the session (load-bearing fix):** a compaction turn MUST reuse the currently-bound tab
  for this opencode sid and IGNORE the fingerprint change - do NOT rebind. This keeps it on the
  Copilot conversation that actually holds the history. Concretely: when `isCompactionTurn` is
  true, skip the fingerprint-mismatch rebind in `ensureBoundSession` and reuse the existing
  bound session for this sid.
- **Do NOT reseed the history:** the Copilot tab already holds the full conversation
  server-side. Send the summarizer instruction as a DELTA (a normal follow-up message), NOT a
  fresh-start preamble. Copilot summarizes what it already has in context. Because we do not
  re-upload history, there is no 128K input-limit risk.
- **Build the delta with `formatCompactionMessage(options)`** (new helper, parallel to
  `formatTitleMessage`): emit the summarizer USER prompt (pull the real summarizer instruction
  out of `options.prompt`) WITHOUT the coding preamble and WITHOUT the tool manifest. Route to
  it from `doGenerate` when `isCompactionTurn` is true.
- **Return the summary as the normal turn output.** opencode then stores it as the compaction
  assistant message in its own history. The provider does NOT need to stash the summary
  anywhere - Part B re-reads it from `options.prompt` on the next turn (restart-safe).

## 0.3 Risk / invariant

Copilot must actually HAVE the conversation history in its live tab context for the summary to
be meaningful. That is true as long as we do NOT rebind. Pinning the session is therefore
mandatory, not optional. If for some reason the bound tab is gone, degrade gracefully (log and
produce an empty/short summary) rather than greeting - but the normal path is: pinned tab,
history present, summarize.

## 0.4 Part 0 test plan
- On cdp-web/opus-temp: 2-3 normal turns, then `/compact`. Assert the compaction turn produces
  an actual SUMMARY of the conversation (not a greeting), and that it ran on the SAME tab (no
  rebind log line).
- Assert no fresh tab was opened for the compaction turn.
- `bun run typecheck` (which runs `tsgo --noEmit`) is clean.

---

# PART A - Unify temp and tracked

## A.1 Target end-state

`temporary` degrades to a flag whose effect is essentially: at fresh-start (new chat or
rollover), `openNewChat(client, temporary)` clicks the "Temporary chat" toggle first. Every
other behavior - capture GUID, persist ref, resume ref, token totals, per-turn drift guard,
reopen-on-resume - runs identically for both modes.

Result: temp = "tracked, but starts behind the temporary toggle so it stays out of the navbar."
Recoverable if we ever need it (it promotes on the recovery send, which is acceptable per
fact #6).

## A.2 Inventory of every `temporary` branch (from grep of model.ts)

### Category 1 - the genuine difference (KEEP)
- `openNewChat(client, this.temporary)` (model.ts ~1237) - the toggle click. The one real
  fork. KEEP as is.
- debug log of `temporary=` (model.ts ~1236) - cosmetic, keep.

### Category 2 - guards that only exist because "temp was assumed disposable" (DROP the `!temporary` exclusion so they run for BOTH modes)
- Capture GUID + `saveConversationRef` after first send (model.ts ~1346). Passive read + a
  metadata write; does NOT promote the chat.
- Resume stored conversation ref on (re)bind (model.ts ~712).
- Resume cumulative token totals (model.ts ~696).
- Persist token totals after each turn (model.ts ~1459).
- Per-turn drift guard "is the tab still on OUR conversation?" (model.ts ~1147). Needs a GUID,
  which temp now has.
- Reopen-existing-conversation branch inside init (model.ts ~1178).

### Category 3 - already unified (NO CHANGE)
- `writeTargetClaim(..., session.temporary)` (model.ts ~731 / ~1011) - already runs for both;
  `temporary` only tweaks the idle-TTL stamp (claims.ts ~233-236).
- `isSubagentTurn` (model.ts ~275) deliberately ignores `temporary` (keys off prompt
  signature). Already correct.
- `createSession(fingerprint, this.temporary)` (model.ts ~650) - still carry the flag; it now
  only feeds the toggle decision.

## A.3 The one new consideration when unifying

Dropping the Category-2 guards means temp INHERITS the persistent path's recovery FAILURE
modes:
- "could not reopen conversation" hard error (model.ts ~1176) when a stored GUID has aged out
  (Microsoft's undocumented temp TTL, fact #7).
- stale-ref overwrite guard (model.ts ~1311) that avoids clobbering a good stored ref with a
  throwaway id.

These are already written and battle-tested on the persistent path; unification just lets temp
reach them. Mitigation for temp's shorter/undocumented TTL:
- On reopen FAILURE for a TEMP session, do NOT hard-error the turn. Fall back to "start a fresh
  temporary chat" (the pre-unification temp behavior) and log. Losing a temp conversation is
  the historical expectation, so a silent fresh-start is a safe degrade for temp specifically.
  For TRACKED, keep the existing hard error (the user expects tracked to be durable).
- Implementation: branch the reopen-failure handling on `session.temporary`.

NET after Part A: `temporary` affects exactly TWO things - (1) the toggle click at fresh-start,
(2) reopen-failure degrades to fresh-start instead of hard-error. Everything else is shared.

## A.4 Storage layer - no change needed

`llm.ts` (~216-288) wires `loadConversationRef` / `saveConversationRef` /
`loadTokenTotals` / `saveTokenTotals` for ALL cdp-web sessions (gated only by
`provider === "cdp-web"`, NO temp check). The metadata keys (`copilotConversation`,
`copilotTokenTotals`) already exist and already work for temp. Unification is purely removing
model.ts guards; llm.ts is untouched by Part A.

## A.5 Part A test plan
- Temp session: run 2-3 turns, confirm GUID captured into `copilotConversation` metadata, and
  confirm NO navbar line appears (still temp).
- Temp session restart: confirm reopen renavigates to the GUID and history loads; confirm the
  first post-reopen SEND promotes it to the navbar (expected, acceptable).
- Temp reopen of an AGED-OUT GUID: confirm it degrades to a fresh temp chat, no hard error.
- Tracked session: confirm behavior unchanged (regression).
- Drift: navigate the temp tab away mid-session, confirm the drift guard re-acquires (now that
  temp has a GUID to compare against).
- `bun run typecheck` clean.

---

# PART B - Compaction rollover (on the unified path)

## B.1 Why rollover

Without a fresh conversation, `/compact` does nothing for cdp-web (fact #1). Value ONLY comes
from: capture summary -> on the next message, open a NEW Copilot conversation seeded with the
summary -> abandon the old bloated conversation. Part 0 makes the summary correct; Part B moves
to the new conversation.

## B.2 Two distinct detections at two distinct moments (do not conflate)

- **Detection 1 (Part 0): the compaction TURN itself**, via `isCompactionTurn(systemContent)`.
  This is where we PIN + summarize. No rollover happens here.
- **Detection 2 (Part B): the BUILD turn AFTER compaction**, via
  `detectCompactionBoundary(options.prompt)`. opencode has by now stored the summary as a
  compaction assistant message, so it appears in `options.prompt`. THIS is where the rollover
  fires.

The provider does NOT carry the summary across turns in memory. It re-reads `summaryText` from
`options.prompt` on the build turn. That is restart-safe (survives an opencode restart between
`/compact` and the next message).

The EXACT collapsed shape of the post-compaction build turn is not yet confirmed - the
2026-08-07 capture was polluted because compaction ran wrong (pre Part 0). Capture 2 (after
Part 0) confirms it and finalizes `detectCompactionBoundary` and the dedupe `key` strategy.

## B.3 Because of Part A, rollover is ONE path

Pre-unification this was a temp-short-path vs persistent-full-path fork. After Part A, both
modes track a GUID and persist refs, so rollover is identical except the toggle click (which
`openNewChat(client, temporary)` already handles). No mode fork in rollover logic.

## B.4 State additions (`SessionState` in session.ts)
- `pendingRollover: boolean` - compaction boundary detected, not yet rolled over.
- `rolledOverCompactionKey: string | null` - dedupe guard: the boundary we last rolled for.

Persist `rolledOverCompactionKey` via a new hook pair mirroring the existing ref hooks:
- `loadRolloverState?()` / `saveRolloverState?({ key })`, wired in llm.ts exactly like
  `load/saveConversationRef`, under a new metadata key e.g. `copilotRolloverKey`.
- Applies to BOTH modes now (Part A made temp tracked). For temp, if the process dies the
  conversation may be gone, but the dedupe key is harmless either way.

## B.5 Detection 2 logic (`detectCompactionBoundary`, in `doGenerate`, before the main seed branch ~1045)
```
detectCompactionBoundary(options.prompt) -> { key, summaryText } | null
```
- Find the summary in `options.prompt` (a recent assistant message that is the stored
  compaction summary). Exact locator finalized by Capture 2.
- Extract `summaryText`.
- Compute a stable `key` (candidate: id of the summary assistant message if it survives into
  the prompt; else a hash of `summaryText`). Finalized by Capture 2.
- Actionable iff `key !== session.rolledOverCompactionKey` AND `key !== persisted key`.
- Skip if `isSubagent` (subagents are torn down anyway) or `summaryText` is empty.

On an actionable boundary -> set `session.pendingRollover = true` and stash `summaryText`+`key`
for use in the same `doGenerate` call.

## B.6 Rollover sequence (single path; only the toggle differs by mode)
Runs when `pendingRollover` is set on entry to `doGenerate`, AFTER auth is confirmed (so we
never seed into a login page):

1. **Save old GUID for in-turn fallback:** `oldConvId = session.conversationId` (populated for
   BOTH modes thanks to Part A).
2. **CLEAR the old conversation ref so init opens a FRESH chat, not a reopen.** Set
   `session.conversationId = null` and `session.conversationTitle = null`, then
   `session.initialized = false`. THIS IS REQUIRED: after Part A the init block reopens any
   session that still has a `conversationId` (the reopen guard was dropped in Part A). If we
   leave the old id set, init would REOPEN the old bloated conversation and the rollover would
   do nothing. Clearing it makes the init block take the `openNewChat` (fresh) path.
3. **Force fresh-start on the SAME tab:** the init block (model.ts ~1210) runs
   `openNewChat(client, this.temporary)` - temp re-clicks the toggle, tracked does not. Reuse
   the same tab (do not open a second tab).
4. **Set effort** (existing init block, model.ts ~1287).
5. **Build the seed** (B.7) and send it. Then set `session.messagesSent = options.prompt.length`.
6. **Capture the NEW GUID:** `waitForConversationId(client, 20000)` (now runs for both modes).
7. **Swap bookkeeping (both modes now):**
   - `releaseClaim(oldConvId)` then `writeClaim(newGuid, sid)`
   - `writeTargetClaim(targetId, sid, temporary)` (same tab id; temp keeps its TTL stamp)
   - `saveConversationRef({ id: newGuid, title })`
   - RESET token totals: `session.cumulativeInputTokens = countTokens(seed)`,
     `session.cumulativeOutputTokens = 0`, then `saveTokenTotals(...)`. OVERWRITE the persisted
     value too - the resume path (model.ts ~696) re-seeds from persisted totals, so a stale
     value would re-inflate the estimate and could immediately re-trigger auto-compaction.
   - `session.conversationId = newGuid`; `session.conversationTitle = title`.
8. **Commit the dedupe guard LAST:** `session.rolledOverCompactionKey = key`;
   `saveRolloverState({ key })`. Then `session.pendingRollover = false`.
9. Continue into the normal await-response flow unchanged.

FAILURE ORDERING: commit the dedupe key LAST. Any failure before it leaves `pendingRollover`
true with an un-committed key, so the next turn retries cleanly. Never half-commit the
claim/ref/token triad without the guard. If `waitForConversationId` yields no GUID, keep the
new fresh chat but log and retry the ref capture next turn (mirror the existing
capture-next-turn philosophy, model.ts ~1317). For temp, an old GUID that is already dead is
fine - we abandoned it anyway.

## B.7 Seed construction (`formatRolloverSeed`)
Treat as `isInitial = true` so the model relearns the tool protocol (a fresh conversation has
none of it). Seed =
- `copilotPreamble(workspaceRoot, manifestPath)` (unchanged)
- `toolsBlock(...)` (RESTORES the JSON tool-call protocol - MUST include, else tool calls break
  in the new conversation)
- `# Prior conversation summary` + `<summaryText>` (clearly delimited)
- tail turns + the new user message (via `formatDeltaMessages` over the post-compaction tail)

Net: the new conversation starts at summary-size, not full-history-size. That IS the value.

## B.8 Diagnostic capture status
- **Capture 1 (2026-08-07): DONE.** Findings: (i) compaction-turn detection signal LOCKED (see
  Part 0 / B.2); (ii) discovered the on-tab compaction bug that became Part 0 (it greeted
  instead of summarizing and tore down the sequence, so the true post-compaction BUILD turn was
  never seen cleanly).
- **Capture 2 (TODO, AFTER Part 0 ships): REQUIRED.** With Part 0 in place (pinned session,
  summarizer sent as a delta, real summary produced), re-run: 2-3 turns -> `/compact` -> one
  more message. Goals: confirm (i) the summary lands as an assistant message in
  `options.prompt` on the next build turn, and (ii) the exact collapsed prompt shape the
  rollover reseeds from. THEN finalize `detectCompactionBoundary` and the `key` strategy (B.5).
- The `CDP_COMPACT_DIAG=1` dumper is already patched into `doGenerate` (read-only, gated by the
  env var). Keep it until Capture 2 is done, then REMOVE it. See "Diagnostic dumper" below.

## B.9 Edge cases
- Double `/compact` with no message between: replace the pending summary; if `key` is
  unchanged, no-op.
- Nothing meaningful to compact: empty `summaryText` -> skip rollover, normal delta.
- Subagent: no-op (torn down).
- Auth drift / stolen tab mid-rollover: detection runs AFTER auth confirm + the existing drift
  guard (model.ts ~1147, active for both modes post Part A).
- Restart between `/compact` and next message: the boundary is re-detected from the summary in
  `options.prompt` (durable in opencode history); the persisted `rolledOverCompactionKey`
  prevents a double roll.
- Temp GUID aged out when rollover tries to release the old claim: harmless; old conv already
  abandoned.

## B.10 Part B test plan
- Long temp session -> `/compact` -> next message: assert the NEW GUID differs from the old,
  old claim released, new claim written, token total reset to ~seed size, tool calls still work
  in the new conversation, and NO navbar line (still a temp chat).
- Same on tracked: assert a new navbar line for the new conversation and the old ref replaced.
- Restart mid-flow: `/compact` -> kill opencode -> restart -> send a message: assert a SINGLE
  rollover (dedupe key holds).
- Regression: normal non-compaction turns still send deltas unchanged.
- `bun run typecheck` clean.

---

# Sequencing

1. **PART 0 - compaction-turn fix.** Provider changes: `isCompactionTurn`,
   `formatCompactionMessage`, pin-session (skip rebind on compaction turns). Standalone bug
   fix: without it every `/compact` greets instead of summarizing. NO config override -
   compaction stays on the active model per fact #4. Ship + test (Part 0 test plan).
2. **Capture 2** - clean `CDP_COMPACT_DIAG` run now that Part 0 makes the summary correct.
   Confirms the post-compaction build-turn shape and finalizes `detectCompactionBoundary` +
   `key` (B.5). Blocks Part B code only.
3. **PART A - unify temp/tracked.** Drop the Category-2 guards; add the temp reopen-failure
   degrade. Independent of Parts 0/B; ship after Part 0 to keep changes reviewable. Delivers
   "invisible but recoverable."
4. **PART B - rollover** on the now-unified single path. Needs Part A (single path) and Capture
   2 (detection locked).

---

# Part A guard-change checklist (quick reference)
Drop the `!session.temporary` exclusion (make it run for both modes) at:
- [ ] capture GUID + saveConversationRef (model.ts ~1346)
- [ ] resume ref on rebind (model.ts ~712)
- [ ] resume token totals (model.ts ~696)
- [ ] persist token totals (model.ts ~1459)
- [ ] drift guard (model.ts ~1147)
- [ ] reopen-existing branch in init (model.ts ~1178)

Special handling:
- [ ] reopen-FAILURE (model.ts ~1176): ADD a temp branch that degrades to a fresh temp chat
      instead of hard-erroring; keep hard error for tracked.

Keep unchanged:
- [ ] openNewChat(client, temporary) (model.ts ~1237) - the one real difference
- [ ] llm.ts hooks - already mode-agnostic, no change

---

# Diagnostic dumper (currently in the tree - REMOVE after Capture 2)
`doGenerate` has a temporary, read-only diagnostic gated behind `CDP_COMPACT_DIAG=1`:
- `dumpCompactionDiag(tag, options, extra)` (a helper near `getToolNames`) dumps every message
  in `options.prompt` (roles, keys, any metadata, truncated text).
- A call at the top of `doGenerate` logs each turn plus the bound session's prior
  `messagesSent` and `conversationId`.
It writes via `dlog` at ERROR level, so it appears in the log regardless of log-level config.
Log file for `bun dev` is `~/.local/share/opencode/log/dev.log` (Windows:
`C:\\Users\\<user>\\.local\\share\\opencode\\log\\dev.log`). To capture: set
`$env:CDP_COMPACT_DIAG=1` in the same shell, run `bun dev`, do the steps. REMOVE the helper and
its call once Capture 2 is complete.