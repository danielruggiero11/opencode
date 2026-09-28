import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { Log } from "@opencode-ai/core/util/log"
import { ShimLanguageModel, type ShimTransport } from "../shim/model"

const log = Log.create({ service: "servicenow" })

// The ServiceNow GenAI Controller appends a fixed language instruction to the
// tail of EVERY prompt ("Generate the response in language English. Do not
// return any translation."). It is platform boilerplate, not part of the user's
// request — without this note the model sometimes treats it as a real task and
// derails. Surfaced as a preamble so the model knows to ignore it.
const SN_PREAMBLE = `<environment_notes>
You are running through the ServiceNow Generative AI Controller, which proxies you to a Claude model. The Controller ALWAYS appends the following line to the end of every prompt it sends you:

  "Generate the response in language English. Do not return any translation."

This is a fixed platform instruction injected by the Controller on every call. It is NOT part of the user's request. Do not treat it as a task, do not comment on it, and do not let it change your behavior — just answer the actual request in English as normal.

SHELL / QUOTING (Windows):
The bash tool executes commands through PowerShell, NOT cmd.exe or a POSIX shell. PowerShell's escape character is a backtick (\`), not a backslash. A backslash before a quote (\\") does NOT escape the quote — PowerShell ends the string early and hands the program a broken fragment, and this fails SILENTLY as a different string rather than erroring cleanly. This bites Python/node one-liners constantly.
Rules for commands that contain quotes:
- STRONGLY PREFER writing the code to a .py/.js file and running the file. Zero quoting layers, re-runnable, inspectable. This is the reliable path for anything non-trivial.
- If you must use an inline one-liner, single-quote the OUTER string so the inner double quotes are verbatim: python -c 'import x; print("ok")'. (Fails if the code itself contains single quotes.)
- Never use \\" to nest a double quote inside a double-quoted string here — it will not do what you expect.
</environment_notes>`

// The Controller also renders the prompt through a {{ }} template engine before
// the model sees it, which silently strips Jinja/Handlebars constructs from file
// content (breaking read/edit of template files). The shim breaks those markers
// on the way out and restores them on the way back. Kill switch for debugging.
const SN_ESCAPE_BRACES = process.env["SN_ESCAPE_BRACES"] !== "0"

export interface ServiceNowConfig {
  readonly instanceURL: string
  readonly username: string
  readonly password: string
  readonly capabilityId: string
  readonly fetch?: typeof globalThis.fetch
}

// ServiceNow surfaces timeouts in three different wordings depending on which ceiling
// fired: the platform transaction quota (sysrule_quota.max_duration) and the capability
// execution timeout (one_api_service_plan_feature.timeout_sec). There is no error code to
// key off — only a human-readable string — so this matches on text and fails closed.
function isTimeout(message: string) {
  return (
    message.includes("maximum execution time exceeded") ||
    message.includes("Transaction cancelled") ||
    message.includes("execution timed out")
  )
}

// Builds the transport that performs the ServiceNow Now Assist API call.
// Everything else (prompt serialization, tool-call parsing, streaming) is
// handled by the shared shim base class.
function createTransport(config: ServiceNowConfig): ShimTransport {
  const { instanceURL, username, password, capabilityId } = config
  const fetchFn = config.fetch ?? globalThis.fetch
  const credentials = Buffer.from(`${username}:${password}`).toString("base64")
  const endpoint = `${instanceURL}/api/now/oneextend/scripted/setup_and_execute`

  return async ({ prompt, signal }) => {
    // -------------------------------------------------------------------------
    // Retry strategy:
    //   Attempt 1: Normal request.
    //   Attempt 2: Constrained prompt (ask model to output less).
    //   Attempt 3: Constrained prompt again.
    //   After 3 failures: hard error (no compaction — issue is output size, not input).
    // -------------------------------------------------------------------------
    const TOTAL_ATTEMPTS = 3

    const execute = async (body: string): Promise<Response> => {
      return fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      })
    }

    const buildBody = (p: string) =>
      JSON.stringify({
        mode: "sync",
        executionRequests: [{ capabilityId, payload: { userprompt: p } }],
      })

    const extractResponse = (cap: Record<string, unknown>): string => {
      const rawResponse = cap.response
      const text =
        typeof rawResponse === "string"
          ? rawResponse
          : Array.isArray(rawResponse) && typeof rawResponse[0] === "string"
            ? rawResponse[0]
            : rawResponse != null
              ? JSON.stringify(rawResponse)
              : ""
      return text
    }

    // Returns the successful text or null if this attempt should be retried.
    const tryOnce = async (
      p: string,
      attempt: number,
    ): Promise<{ text: string; thinking?: string } | "retry" | "empty" | "timeout"> => {
      const res = await execute(buildBody(p))

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        // HTTP errors are not transient platform glitches — fail immediately
        throw new Error(`ServiceNow API ${res.status}: ${body.slice(0, 500)}`)
      }

      const data = (await res.json()) as Record<string, unknown>
      const result = (data?.result as Record<string, unknown> | undefined) ?? {}
      const capabilities = (result.capabilities as Record<string, unknown> | undefined) ?? {}

      // Top-level failure (permission/ACL, invalid capability id, etc.): ServiceNow
      // returns result.status === "error", an empty capabilities object, and a
      // human-readable result.message. This is NOT an output-size problem, so it
      // must not be retried or reported as a context/output-limit error.
      //
      // result.status is also "error" when the capability itself failed, in which case the
      // capabilities object is populated and result.message is null. Those carry a usable
      // per-capability error, so defer to the capability branch below.
      if (!capabilities[capabilityId] && (result.status === "error" || Object.keys(capabilities).length === 0)) {
        const message = typeof result.message === "string" ? result.message : JSON.stringify(result)

        // A platform transaction kill (sysrule_quota max_duration) returns the same shape as
        // a permission/ACL failure and is distinguishable only by message. Unlike an ACL
        // failure it is worth retrying — nothing was produced, so there is no partial write.
        if (isTimeout(message)) {
          log.warn("transaction cancelled by platform timeout", { attempt, message: message.slice(0, 200) })
          return "timeout"
        }

        log.error("servicenow request rejected", { capabilityId, message: message.slice(0, 300) })
        throw new APICallError({
          message: `ServiceNow rejected the request for capability ${capabilityId}: ${message}`,
          url: endpoint,
          requestBodyValues: { capabilityId },
          statusCode: 403,
          responseBody: JSON.stringify(result).slice(0, 1000),
          isRetryable: false,
        })
      }

      const cap = capabilities[capabilityId] as Record<string, unknown> | undefined

      if (!cap || cap.status !== "success") {
        const capJson = JSON.stringify(cap ?? {})
        const capError = typeof cap?.error === "string" ? cap.error : capJson

        // Capability-level execution timeout (one_api_service_plan_feature.timeout_sec).
        // Distinct from the platform transaction quota: this one reports as a populated
        // capability with an "An execution timed out with timeout of N MILLISECONDS" error.
        if (isTimeout(capError)) {
          log.warn("capability execution timed out", { attempt, error: capError.slice(0, 200) })
          return "timeout"
        }

        // Context overflow: input data exceeds provider limit — not recoverable here
        if (capError.includes("exceeds limit") || capError.includes("DATA_PRIVACY_API_ERROR")) {
          log.warn("context overflow — input exceeds limit", { attempt, error: capError.slice(0, 200) })
          throw new APICallError({
            message: `ServiceNow context overflow: ${capError}`,
            url: endpoint,
            requestBodyValues: { capabilityId },
            statusCode: 413,
            responseBody: capJson,
            isRetryable: false,
          })
        }

        log.warn("transient failure", {
          attempt,
          status: String(cap?.status ?? "unknown"),
          capJson: capJson.slice(0, 200),
        })
        return "retry"
      }

      const text = extractResponse(cap)
      if (!text || text === "{}") {
        log.warn("empty/truncated response", {
          attempt,
          text,
          cap: JSON.stringify(cap).slice(0, 200),
        })
        return "empty"
      }

      return {
        text,
        thinking: (cap.thinking_response as string | undefined) ?? undefined,
      }
    }

    // --- Attempt 1: initial request ---
    const first = await tryOnce(prompt, 1)
    if (typeof first === "object") {
      return { ...first, requestBody: buildBody(prompt) }
    }

    // A platform timeout is retried with the prompt unchanged and a longer backoff: the
    // request was killed mid-generation, not rejected for size, so constraining output is
    // the wrong remedy. Empty/transient failures still get the output constraint.
    const constrainedPrompt =
      prompt +
      "you are trying to do too much at once. you need to limit your output tokens and give me just the next action to take"

    const nextPrompt = (previous: "retry" | "empty" | "timeout") =>
      previous === "timeout" ? prompt : constrainedPrompt
    const backoffMs = (previous: "retry" | "empty" | "timeout", attempt: number) =>
      previous === "timeout" ? attempt * 5000 : 3000

    // --- Attempt 2 ---
    await new Promise((r) => setTimeout(r, backoffMs(first, 1)))
    const secondPrompt = nextPrompt(first)
    log.info("retrying", { attempt: 2, reason: first, promptLength: secondPrompt.length })
    const second = await tryOnce(secondPrompt, 2)
    if (typeof second === "object") {
      return { ...second, requestBody: buildBody(secondPrompt) }
    }

    // --- Attempt 3 ---
    await new Promise((r) => setTimeout(r, backoffMs(second, 2)))
    const thirdPrompt = nextPrompt(second)
    log.info("retrying", { attempt: 3, reason: second, promptLength: thirdPrompt.length })
    const third = await tryOnce(thirdPrompt, 3)
    if (typeof third === "object") {
      return { ...third, requestBody: buildBody(thirdPrompt) }
    }

    // --- All attempts exhausted — hard error (no compaction; retrying is all we can do) ---
    log.error("all retry attempts exhausted", {
      totalAttempts: TOTAL_ATTEMPTS,
      promptLength: prompt.length,
      lastResult: third,
    })
    throw new Error(
      third === "timeout"
        ? `ServiceNow: all ${TOTAL_ATTEMPTS} attempts were cancelled by the platform (maximum execution time exceeded). Raise the capability timeout (one_api_service_plan_feature.timeout_sec) and the sysrule_quota catch-all max_duration. See the instance setup runbook.`
        : `ServiceNow: all ${TOTAL_ATTEMPTS} attempts failed (empty responses). The model output likely exceeds the platform limit. Check opencode logs for details.`,
    )
  }
}

// Factory consumed by opencode's BUNDLED_PROVIDERS map.
// All credentials are passed through provider.options from opencode.json.
export function createServiceNow(
  opts: Record<string, unknown> & {
    instanceURL?: unknown
    username?: unknown
    password?: unknown
    capabilityId?: unknown
    fetch?: unknown
  },
) {
  const baseConfig: ServiceNowConfig = {
    instanceURL: String(opts.instanceURL ?? ""),
    username: String(opts.username ?? ""),
    password: String(opts.password ?? ""),
    // Provider-level capabilityId is now only a fallback default. Each model can
    // override it via its own `options.capabilityId` in opencode.jsonc. The
    // per-model value arrives here through the getModel loader in provider.ts,
    // which forwards the merged { ...provider.options, ...model.options }.
    capabilityId: String(opts.capabilityId ?? ""),
    fetch: typeof opts.fetch === "function" ? (opts.fetch as typeof globalThis.fetch) : undefined,
  }

  // Build a language model bound to a specific capability id, preferring the
  // per-model override and falling back to the provider-level default. A fresh
  // transport closure per model is cheap and keeps each model pointed at its
  // own capability, so multiple models can run concurrently.
  const modelFor = (modelId: string, options?: Record<string, unknown>): LanguageModelV3 => {
    const capabilityId = String((options?.capabilityId as string | undefined) ?? baseConfig.capabilityId)
    const transport = createTransport({ ...baseConfig, capabilityId })
    return new ShimLanguageModel(modelId, {
      provider: "servicenow",
      transport,
      preamble: SN_PREAMBLE,
      escapeBraces: SN_ESCAPE_BRACES,
    })
  }

  return {
    languageModel(modelId: string, options?: Record<string, unknown>): LanguageModelV3 {
      return modelFor(modelId, options)
    },
    chat(modelId: string, options?: Record<string, unknown>): LanguageModelV3 {
      return modelFor(modelId, options)
    },
  }
}
