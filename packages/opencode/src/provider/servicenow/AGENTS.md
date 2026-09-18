# ServiceNow Provider

`index.ts` is a thin transport for the ServiceNow Now Assist (OneExtend) API. It owns
only the HTTP call, response unwrapping, and retry policy. Prompt serialization,
tool-call parsing, and streaming are owned by the shared shim in `../shim/`.

## Instance setup — single source of truth

Do **not** document instance configuration here. The authoritative runbook is:

```
C:\Users\drugg\OneDrive - ServiceNow\Projects\ServiceNow MCP\docs\runbooks\turnkey-opencode-setup.md
```

It covers the four phases required to stand up a fresh instance (unlock the model,
create the skill in AI Skill Kit by hand, configure capability timeout and token
properties, raise the transaction quota), the record chain across releases, the schema
drift between Yokohama-era and current instances, and the known limitations.

If instance behavior changes, update the runbook — not this file.

Two details worth knowing without opening it, because they explain failures that look
like client bugs:

- **There are two independent timeout ceilings**, both currently `900` s:
  `one_api_service_plan_feature.timeout_sec` (capability) and the `sysrule_quota`
  catch-all `max_duration` (platform transaction). Whichever is lower wins.
- **A quota kill is indistinguishable from an ACL failure** in the response shape, so it
  is separated by message match and routed into the retry ladder (see below).

## Boundaries

- `index.ts` builds a `ShimTransport` and hands it to `ShimLanguageModel` from
  `../shim/model`. It never constructs AI SDK parts or parses tool calls itself.
- `../shim/prompt.ts` owns the system prompt, including the `<tool_use_instructions>`
  block and the turn-ending semantics that stop the model narrating an action without
  emitting the call.
- `../shim/parse.ts` extracts tool calls from raw model text and captures any leading
  prose via `leadingProse`.
- `../shim/model.ts` emits that leading prose as a text part before tool-call parts in
  both `doGenerate` and `doStream`.

`../shim/` is shared with the `powerautomate` provider, so changes there affect both.
The unrelated `../cdp/model.ts` contains a stale copy of an older tool-use block; it is
not on this path and is intentionally divergent.

## Request shape

```ts
{ mode: "sync", executionRequests: [{ capabilityId, payload: { userprompt } }] }
```

No max-tokens field is sent. Any output limit in `opencode.jsonc` is local-only and never
reaches the platform; the real ceiling is the skill's output-token setting. `mode: "sync"`
means the request blocks a ServiceNow transaction thread for the whole generation, which
is the root of the timeout behavior.

## Response handling

Three failure classes, deliberately treated differently:

1. **Top-level rejection** — `result.status === "error"` or empty `capabilities`. Thrown
   immediately as a non-retryable `APICallError` (403). Covers permission/ACL errors and
   invalid capability IDs.
2. **Platform timeout** — same shape as class 1, separated only by a message containing
   `maximum execution time exceeded` or `Transaction cancelled`. Returns `"timeout"` and
   enters the retry ladder. Safe to retry: the transaction was killed mid-generation, so
   nothing was produced and there is no partial write.
3. **Context overflow** — capability error containing `exceeds limit` or
   `DATA_PRIVACY_API_ERROR`. Non-retryable `APICallError` (413). Input is too large; no
   retry helps.
4. **Transient / empty** — any other failing capability status, or an empty/`{}`
   response. Returns `"retry"` or `"empty"` and enters the retry ladder.

Thinking is a free sibling channel: the transport returns
`{ text: cap.response, thinking: cap.thinking_response }`. Only `text` is scanned for
tool calls. Thinking is re-emitted as a `reasoning` part and never replayed into history
by `buildPrompt`.

No `finishReason` is surfaced, so a truncated response is indistinguishable from a normal
completion.

## Retry ladder

Three attempts, engaged by classes 2 and 4 above. The prompt and backoff for each retry
depend on why the previous attempt failed:

| previous failure | prompt | backoff |
| --- | --- | --- |
| `timeout` | unchanged | 5 s, then 10 s |
| `retry` / `empty` | + constrained suffix | 3 s |

The constrained suffix ("limit your output tokens and give me just the next action")
targets output-size failures. It is the wrong remedy for a timeout — the request was
killed mid-generation, not rejected for size — and it lengthens the input, so timeouts
replay the original prompt verbatim with a longer, escalating backoff.

If all three attempts fail, the thrown error message branches on the last failure so a
timeout is not misreported as an output-size problem.
