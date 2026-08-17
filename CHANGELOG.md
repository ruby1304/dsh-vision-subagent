# Changelog

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
