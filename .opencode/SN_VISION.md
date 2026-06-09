# ServiceNow Vision for OpenCode

Gives OpenCode image understanding + PDF/Office parsing while running on the
text-only ServiceNow Now Assist provider. Additions-only (nothing in upstream
opencode source is modified), so the fork still pulls cleanly.

> Instance-side deploy details + history live in the ServiceNow MCP repo:
> `docs/runbooks/opencode-image-support.md`. This file is the developer reference
> that travels with the tools/plugin.

## Components

| File | Role |
|---|---|
| `tool/sn_analyze_image.ts` | Tool `sn_analyze_image` — OCR + visual description of any image |
| `tool/sn_parse_document.ts` | Tool `sn_parse_document` — PDF/DOCX/XLSX → text (local; no SN call) |
| `plugin/sn-vision.ts` | On attach: auto-analyzes images (injects description), materializes PDFs/Office to a temp path + points the model at `sn_parse_document` |
| `tool/_sn-shared.ts` | Shared helpers: gateway call (upload→analyze→cleanup), image-byte resolver, creds, cache |

Deps (in `.opencode/package.json`): `unpdf`, `mammoth`, `xlsx`, `@opencode-ai/plugin`.

## How it works

- **Images** are read by the multimodal **Document Chat** capability
  (`36e696ed075b921016f71f00ead3006f`) via `OneExtendUtil.execute`, behind the
  gateway resource `POST /api/snc/apigateway/analyzeimage`. Document Chat reads
  images from real **sys_attachments**, so `_sn-shared.analyzeImage` uploads the
  bytes via the Attachment API, passes the sys_id, then deletes it.
  *(AI Lens `invokeLens` was abandoned — it needs the `lens_user` role and still
  doesn't survive a synchronous scripted-REST web transaction.)*
- **Documents** are parsed locally in opencode; scanned PDF pages are surfaced to
  `sn_analyze_image`.
- **Credentials** come from the `servicenow` provider block in `opencode.jsonc`;
  the plugin reads them via `client.config.get()` (lazily, on first hook — calling
  it at plugin-init deadlocks opencode bootstrap) and shares them to the tools.
  Env vars `SERVICENOW_INSTANCE_URL/_USERNAME/_PASSWORD` are the fallback.

## Model selection — IMPORTANT LIMITATION

The vision model is **currently Azure GPT-small** (multimodal: it does OCR *and*
visual description). Switching the model is **not** a per-call or opencode-config
choice today. Findings (tested 2026-06-09 on pulsecheck):

- Document Chat has defs for **Bedrock/Claude** (`3c727940eb4e62104c8ff734bad0cd22`),
  **Azure/GPT** (`8348d6a1079b921016f71f00ead300df`), **Vertex/Gemini**
  (`8961b100eb4e62104c8ff734bad0cd53`), plus NowLLM variants.
- **Per-call selection does not work.** Passing the target definition via
  `meta.definition` in `OneExtendUtil.execute` is **ignored** — all three tested
  routed to Azure. So we cannot pick the model per request.
- The real lever is the per-capability **`default` flag**, but those records are in
  the protected `sn_docintel_gen_ai` scope (can't change via REST — needs a scoped
  background script or the **Now Assist Admin** UI), and the change is **global to
  the Document Chat skill** (also affects the OOB doc/visual-insights AI agent and
  Virtual Agent), not isolated to this gateway.

### How to actually switch the model

- **Experiment / one-off:** flip Document Chat's model in **Now Assist Admin →
  Manage AI Models** (or a scoped background script). Global to the skill; revert when done.
- **Permanent, opencode-config-driven, isolated switching:** requires building a
  dedicated multimodal capability layer we own — e.g. 3 capabilities pinned per
  model in a writable scope, with the gateway mapping a config `visionModel` value
  → capabilityId. **Not built yet** — moderate effort. Do this only if "change one
  value in opencode.jsonc" switching is actually needed.

## Using it in every project (not just this repo)

Project-local `.opencode/` only loads inside this repo. To use everywhere, **move**
(don't copy — avoids duplicate-tool collisions) into the global config dir
(`~/.config/opencode/`):
- `plugin/sn-vision.ts`, `tool/{sn_analyze_image,sn_parse_document,_sn-shared}.ts`
- a `package.json` with the deps (preserve the `../tool/_sn-shared` relative layout)
- the **`servicenow` provider block** — required, since the tools get their creds from it

## Notes

- Gateway returns `{result:{status,answer}}` (ServiceNow wraps scripted-REST output in `result`).
- Scanned-PDF rasterization (`unpdf.renderPageAsImage`) is best-effort in Bun; otherwise
  scanned pages degrade to an "attach as image" message.
- `experimental.chat.messages.transform` is an experimental opencode hook — recheck on major upgrades.
