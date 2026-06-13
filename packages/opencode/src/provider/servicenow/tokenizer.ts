import { getEncoding } from "js-tiktoken"

// Lazily initialized — first call takes ~100-200ms to load BPE ranks,
// subsequent calls are fast. cl100k_base is appropriate for Claude-family models.
let encoder: ReturnType<typeof getEncoding> | undefined

function getEncoder() {
  if (!encoder) encoder = getEncoding("cl100k_base")
  return encoder
}

export function countTokens(text: string): number {
  if (!text) return 0
  return getEncoder().encode(text).length
}
