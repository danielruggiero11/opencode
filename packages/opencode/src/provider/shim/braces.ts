// Brace "de-templating" for backends that run the serialized prompt through a
// {{ }} template engine before the model sees it.
//
// ServiceNow's Now Assist "setup_and_execute" capability renders the
// `userprompt` string through a Glide/Jinja-style variable substitution pass.
// Any balanced template construct in the payload — `{{ expr }}`, `{% stmt %}`,
// `{# comment #}` — is treated as an (undefined) variable and resolved to empty
// BEFORE the model receives the prompt. The practical fallout: reading or
// editing Jinja/Handlebars templates fails because the model sees blanked-out
// braces and its edit `oldString` never matches the real file on disk.
//
// Fix: insert a zero-width space (U+200B) between the two characters of each
// opening/closing marker on the way OUT. `{{` becomes `{​{`, which the
// template engine no longer recognizes as a token, so the content passes
// through intact and visually reads the same to the model. On the way IN we
// strip every zero-width char, restoring the real characters.
//
// This is robust to the model dropping the marker: if it reproduces a literal
// `{{ }}` (having dropped the invisible char), that is already the correct
// on-disk text; if it preserves `{​{`, stripping the zero-width char
// yields the same result. Either way edit/write matches the real file.
//
// Single-brace `{`/`}` (ordinary JSON, code) is untouched. A lone `}}` with no
// matching `{{` (e.g. the tail of nested JSON objects in tool-call history) is
// harmless to split and is left readable.

const ZWSP = "​"

// Ordered longest-first is irrelevant here (all markers are 2 chars), but the
// pairs are explicit so the intent is obvious and easy to extend.
const MARKERS: ReadonlyArray<[string, string]> = [
  ["{{", `{${ZWSP}{`],
  ["}}", `}${ZWSP}}`],
  ["{%", `{${ZWSP}%`],
  ["%}", `%${ZWSP}}`],
  ["{#", `{${ZWSP}#`],
  ["#}", `#${ZWSP}}`],
]

/** Break template markers so a downstream {{ }} engine leaves them intact. */
export function deTemplateBraces(input: string): string {
  let out = input
  for (const [from, to] of MARKERS) out = out.split(from).join(to)
  return out
}

/**
 * Undo de-templating (and any zero-width chars the model may have echoed).
 * Strips U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ) and U+FEFF (BOM) so a real
 * `{{`/`}}` is recovered regardless of what the model reproduced.
 */
export function stripZeroWidth(input: string): string {
  return input.replace(/[​‌‍﻿]/g, "")
}
