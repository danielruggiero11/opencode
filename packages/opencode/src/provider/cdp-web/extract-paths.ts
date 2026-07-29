import * as path from "node:path"

/** Extensions we support for native Copilot upload */
const UPLOADABLE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff",
  ".pdf",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
])

// Sort extensions longest-first so "docx" is tried before "doc" in alternation
const EXT_PATTERN = Array.from(UPLOADABLE_EXTENSIONS)
  .map((e) => e.slice(1))
  .sort((a, b) => b.length - a.length)
  .join("|")

/**
 * Detect Windows file paths in text that point to uploadable files.
 * Matches patterns like:
 *   C:\Users\...\file.docx
 *   "C:\Users\...\file.pdf"
 *   file:///C:/Users/.../file.png
 *
 * Returns the paths found and the text with those paths stripped out.
 */
export function extractFilePathsFromText(text: string): { paths: string[]; cleaned: string } {
  const paths: string[] = []
  let cleaned = text

  // Match file:// URLs (may contain %20 for spaces)
  const fileUrlRe = new RegExp(`file:///([^\\n"'<>]*?\\.(?:${EXT_PATTERN}))(?=[^a-zA-Z]|$)`, "gi")
  for (const match of text.matchAll(fileUrlRe)) {
    const urlPath = decodeURIComponent(match[1]).replace(/\//g, "\\")
    const filePath = urlPath.startsWith("\\") ? urlPath.slice(1) : urlPath
    if (!paths.includes(filePath)) {
      paths.push(filePath)
      cleaned = cleaned.replace(match[0], "")
    }
  }

  // Match Windows absolute paths that end with an uploadable extension.
  // Allows spaces in path. Lookahead ensures we match the longest extension
  // (e.g., .docx not .doc when followed by 'x').
  const winPathRe = new RegExp(`([A-Z]:\\\\[^\\n"'<>*?|]*?\\.(?:${EXT_PATTERN}))(?=[^a-zA-Z]|$)`, "gi")
  for (const match of text.matchAll(winPathRe)) {
    const filePath = match[1]
    if (!paths.includes(filePath)) {
      paths.push(filePath)
      cleaned = cleaned.replace(filePath, "")
    }
  }

  return { paths, cleaned: cleaned.replace(/\s{2,}/g, " ").trim() }
}

export { UPLOADABLE_EXTENSIONS }
