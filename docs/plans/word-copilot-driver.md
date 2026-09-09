### Phase 4 - Multi-session Word affinity + recovery

**Direction change (Sep 2026):** Word should use tab affinity rather than conversation persistence. The real requirement is support for multiple independent agent sessions. For Word, the session anchor is the CDP targetId (tab ownership), not a conversation GUID.

#### Phase 4A - Multi-session tab affinity + resume-in-place — DONE (Sep 9 2026)

Implemented in `affinity.ts` (new) + `model.ts` + `session.ts`:
- **sid → targetId affinity** (`affinity.ts`: `saveTabAffinity` / `loadTabAffinity` / `clearTabAffinity`, one JSON per sid under `<state>/cdp-web-affinity/`). CDP targetIds are stable for the browser's lifetime, so the record survives an opencode restart. Persisted at bind time; cleared on `releaseSessionForSid`.
- **Exact-tab routing**: `findUsableTab` (word) prefers the sid's recorded targetId when it's still a live, unclaimed Word tab — so with several Word tabs open each sid re-adopts its own instead of grabbing the first free one. Falls through to the first free Word tab when the record is stale (manual-recovery case).
- **Resume-in-place (the load-bearing fix)**: word init used to click New Chat on every first turn, which wiped whatever conversation the user had navigated to. Now `session.resumeInPlace` is set from the affinity record at bind time; when true, init CONTINUES the pane's current conversation and skips New Chat. A brand-new sid (no record) still gets a clean chat. This also stops drift-recovery from wiping an ongoing conversation.
- **Drift detection** already targetId + frame-liveness based (no GUID) — unchanged.
- **Diagnostics**: `findUsableTab` now logs every candidate tab and the per-tab reject reason, so a "spawned a new tab instead of adopting mine" case is debuggable from the log.

Model: conversations are **ephemeral**. Word private chats are still tracked by Word, but we do not programmatically reopen a specific one — there is no CDP handle for that, and the parking-doc URL (`copilot.docx` for every conversation) emits nothing conversation-specific. Recovery is **manual**: open a Word tab, navigate to the conversation in the pane, open opencode to the right session, and continue as if we never left (resume-in-place makes this work).

#### Phase 4B - Document-backed recovery — DROPPED

Not pursued: the parking doc is a single shared `copilot.docx`, so the document URL cannot disambiguate one Word conversation from another. There is no URL/CDP anchor for a specific conversation, so automated reopen is impossible. Superseded by the manual-recovery model above.

#### Phase 4C - Remaining polish

22. Automate Opus/Sonnet model selection inside Word's pane. (Partially moot: `installEnvelopeRewrite` already pins `tone:"Claude_Opus"` on the wire regardless of the pane's picker.)
23. Harden Word-frame reauth detection and stale-frame recovery.
24. Optional Word-port Chrome launcher and parking-document management.

#### Phase 5 - Periodic agentic-context reminder — DONE (Sep 9 2026)

Implemented as a token-interval trigger rather than a fixed turn count (simpler, and scales with actual context pressure instead of turn size): `session.tokensAtLastReminder` (new field, `session.ts`) tracks the cumulative-token total (`cumulativeInputTokens + cumulativeOutputTokens`) at the last injection. In `model.ts`'s doGenerate, right after `messageToSend` is finalized (post attachment-stripping, pre `sendPrompt`): if `engine === "word"` and this isn't the turn-0/compaction path, and `tokensSoFar - tokensAtLastReminder >= reminderTokenInterval`, prepend `formatReminderMessage(options, isSubagent)` to the delta and reset the counter.

`formatReminderMessage` (`model.ts`, next to `formatInitialMessage`) is NOT a short nudge — a bare "you're a coding agent" reminder with no tool definitions would be useless, since the model would have nothing to act on even if it believed the reminder. Instead it rebuilds the exact SAME `copilotPreamble(...)` + `toolsBlock(options, ...)` used on turn 0, computed fresh from `options` on every injection (so it can never go stale if the tool manifest changes mid-conversation), wrapped in one framing line marking it as a re-assertion rather than a new conversation. The only thing intentionally omitted vs. turn 0 is the "# Task" section — the real task/turn already follows immediately after in the same delta.

`reminderTokenInterval` is configurable via provider options (`wordUrl`/`wordPort` sibling in `opencode.jsonc`), default `35_000`. Below is the original planning note, kept for the design rationale:

**Problem.** `formatInitialMessage` (`model.ts:542-568`) — preamble + tool manifest + first task — is sent exactly once, on turn 0 (gated at `model.ts:1460-1464` roughly). Every later turn goes through `formatDeltaMessages` (`model.ts:587`), which sends only the newest message(s) — no framing at all. Persona/behavior stability after turn 0 depends entirely on Copilot server-side retaining that first message. Copilot is known to shrink/summarize context as a conversation grows, which can silently drop or deprioritize turn 0, and the model drifts back into its "I'm your Word assistant" register and starts arguing about running commands. This is a separate mechanism from the envelope-rewrite persona pin (fixed by the per-send `window.__cdpEnvRewrite` check in `model.ts`) — that fix stops Word's server-side agent binding from overriding the model; this phase is about keeping the model's own understanding of its job from decaying.

**Non-goal.** Do not resend the full preamble + tool manifest every turn — wasteful, and burns into the 128K limit (`DELTA_CHAR_BUDGET`/`SINGLE_RESULT_MAX` at `model.ts:571-573`) for no benefit on turns that don't need it.

**Direction.** Inject a short, cheap "reminder" block ahead of the user's delta message on a cadence, rather than every turn:
- Track turns-since-last-reminder per session (`SessionState` in `session.ts` — add a counter, e.g. `turnsSinceReminder`, reset on injection and on a fresh `formatInitialMessage` turn).
- Pick a cadence — candidate: every N turns (e.g. N=8-10) OR when `session.messagesSent` crosses a char-budget-derived threshold since the last reminder, whichever fires first. Needs empirical tuning against how aggressively Copilot appears to shrink context in practice.
- Reminder content: a condensed version of `copilotPreamble(...)` — NOT the full tool manifest (that's large and static; only worth re-sending if hallucinated tool names/refusals correlate with reminder gaps in testing) — framed explicitly as a re-assertion, e.g. "Reminder: you are still operating as the coding agent described earlier in this conversation. You have tool-call access via the manifest given at the start of this chat. Continue executing tasks; do not ask for permission to run standard read/build/test commands."
- Splice this into `formatDeltaMessages`'s output (or a new `formatDeltaMessagesWithReminder` wrapper) ahead of the actual delta content, only when the cadence condition is met.
- Consider whether the reminder should be visually/structurally distinct (e.g. a `# Reminder` heading) so it doesn't get misread as a new user task.

**Open questions to resolve before implementing:**
- Cadence: turn count vs. char budget vs. both — needs a few real long Word sessions to observe where drift actually starts.
- Whether the drift is specifically Word-engine (server-side context shrinkage tied to Word's smaller token allocation) or would also affect the m365 desktop-app engine — if only Word, gate this behind `this.engine === "word"`.
- Whether to log reminder injections (`dlog`) so a session transcript makes it visible when this fired, useful for correlating with observed drift.

**Out of scope for this phase:** the envelope-rewrite realm-reset gap (already fixed separately — see per-send `window.__cdpEnvRewrite` check in `model.ts` near the `sendPrompt` call).

