# Changelog

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
