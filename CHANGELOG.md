# Changelog

## 0.4.0 — 2026-08-18

- Capability-aware paste routing (`pasteMode: auto`, now the default): image-capable current models receive pasted originals through DSH's native ImageBlock path; only text-only models use the isolated vision-route analysis fallback
- New `pasteMode` options: `delegate` forces the previous isolated-analysis behavior; `native` bypasses the plugin and leaves image admission to DSH
- Native sends create no analysis capsule or synthetic description; the current multimodal model sees original pixels with full conversation context
- Forced `native` / `delegate` modes now bypass both the session model directory and model-capability resolver; only `auto` performs capability lookup
- Capability preflight and delegated analysis use independent timeouts, so a stalled preflight can safely fall back without reusing an aborted signal
- Release validation target updated to DSH `0.1.0-rc.7`

## 0.3.1 — 2026-08-17

- The paste-analysis progress capsule now follows its owning session: switching sessions hides it, switching back re-shows it while the analysis still runs (previously it floated globally over every session)

## 0.3.0 — 2026-08-17

- Paste analysis is intent-aware: the composer's draft message steers the vision route's focus (error text for debugging, outfit details for styling) instead of a generic description; empty drafts keep the detailed fallback
- Bridged user bubbles render only the sender's own words plus thumbnails — the vision analysis moves to the thumbnail lightbox caption, no longer duplicated inline
- New `vision_image_fetch` tool: materialize a pasted image's durable `vision-subagent://` reference into the workspace `.dsh-vision/` directory (content-hashed filename) for editing or full-fidelity inspection
- Fix maxDepth semantics: default 0 → 1 with a clamp in resolveConfig; the harness cap is absolute delegation depth, so 0 rejected the vision child itself

## 0.2.0 — 2026-08-15

- Web paste bridge: paste/drop images into the composer; on send they are analyzed by the vision route in an isolated context and only the text analysis enters the conversation (Codex-style paste on text-only routes)
- Host endpoint POST /vision-subagent/v1/web-paste with session authorization, bounded uploads, and client-disconnect handling
- Client plugin bundling via tsdown into lib/client.js (window.__ModuleLoader__ protocol)
- New config field: maxTokens (subagent child and paste analysis)

## 0.1.0 — 2026-08-15

- vision_agent tool: delegate image reading to a one-shot subagent on a configurable vision route (MiniMax / Kimi / any OpenAI-compatible provider)
- Image admission: extension allow-list, workspace containment, symlink rejection, byte caps
- Durable attachments via the harness attachment seam; keys stay in route credential references
- Child runs with maxDepth: 0; only the final text returns to the main session
