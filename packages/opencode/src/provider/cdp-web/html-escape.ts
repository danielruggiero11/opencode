/**
 * HTML-entity escaping for the Copilot round trip.
 *
 * WHY THIS EXISTS
 * ---------------
 * Copilot's chat pipeline runs an HTML-tag-aware sanitizer over the message text
 * we submit. Any literal markup in a file we hand it (e.g. `<script src="x"></script>`)
 * is dismantled BEFORE the model reads it — the `<tag …>` opener and `</` closer are
 * stripped, leaving orphan fragments like `"x"script>`. The model then faithfully
 * copies that corrupted text into an `edit` tool call's `oldString`, which of course
 * no longer matches the real bytes on disk, so the edit fails ("old string not found").
 * We proved the corruption arrives in the raw WebSocket frame — it is Copilot's
 * transform, not ours — but we control the exact bytes we send, so we can neutralize it.
 *
 * THE FIX
 * -------
 * Entity-escape file/tool-result payloads on the way OUT (`<` → `&lt;`, `>` → `&gt;`,
 * `&` → `&amp;`). Entities are not tags, so the sanitizer leaves them untouched and the
 * model sees the markup intact (as entities). When a tool call comes back, entity-DECODE
 * its arguments so `edit`/`write` run against the real characters again. The escape is a
 * standard, fully-reversible HTML escape, so a file that legitimately contains `&lt;`
 * round-trips correctly too (`&lt;` → `&amp;lt;` out → `&lt;` back).
 *
 * TOGGLE
 * ------
 * Enabled by default. Set `CDP_WEB_HTML_ESCAPE=0` (or `false`) to disable, e.g. to A/B
 * the behavior or if a future Copilot build stops sanitizing.
 */

/** Whether the escape/unescape round trip is active. Read once at module load. */
export function htmlEscapeEnabled(): boolean {
  const v = process.env["CDP_WEB_HTML_ESCAPE"]
  if (v === undefined) return true
  const s = v.trim().toLowerCase()
  return !(s === "0" || s === "false" || s === "no" || s === "off")
}

/**
 * Escape a file/tool-result payload so Copilot's sanitizer cannot dismantle its markup.
 * Order matters: `&` first so we don't double-escape the entities we introduce.
 */
export function escapeHtmlPayload(text: string): string {
  if (!text) return text
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Reverse escapeHtmlPayload. Order matters: `&amp;` LAST so a literal `&lt;` that was
 * escaped to `&amp;lt;` decodes back to `&lt;` rather than `<`.
 */
export function unescapeHtmlPayload(text: string): string {
  if (!text) return text
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}
