/**
 * driver.ts – Unified re-export for Copilot browser automation.
 *
 * All DOM-based driver functions (checkAuth, sendPrompt, awaitResponse, etc.)
 * are re-exported from driver-dom.ts for backward compatibility.
 *
 * WebSocket-based response capture is available via:
 *   • enableWsCapture(client)     – call once per CDPClient
 *   • awaitResponseWs(client)     – wait for response via WS frames
 */

export {
  checkAuth,
  checkComposer,
  checkReauth,
  clickReauthContinue,
  type ReauthState,
  openNewChat,
  setEffort,
  EFFORT_LABELS,
  sendPrompt,
  getTurnCount,
  awaitResponse,
  extractResponseRaw,
  attachFiles,
  navigateToChat,
  pasteImageAttachment,
  CopilotReauthRequired,
} from "./driver-dom"

export { enableWsCapture, awaitResponseWs, beginResponseCapture } from "./driver-ws"

export {
  getConversationInfo,
  waitForConversationId,
  openConversationById,
  openConversationInSidebar,
  reopenConversation,
  type ConversationInfo,
} from "./recovery"
