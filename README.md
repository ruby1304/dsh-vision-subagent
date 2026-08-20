# dsh-vision-subagent

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Capability-aware vision for DeepSeek Harness: multimodal current models receive pasted images through DSH's native path; text-only models delegate image reading to a **one-shot subagent** on a separately configured **vision route** (MiniMax / Kimi / any OpenAI-compatible provider). On the delegated path, image bytes and the vision model's intermediate context stay out of the main session — only the final text answer comes back.

## Why a subagent

- **Context isolation**: large screenshots and multi-image comparisons never occupy the main model's window
- **Multi-turn visual reasoning**: the child can call read_image on more workspace files before answering
- **Cost & route separation**: vision calls bill on the MiniMax/Kimi route; the main model only reasons

## Quick start

`sh
dsh plugin --profile web add /path/to/dsh-vision-subagent
`

Then edit `~/.dsh/profiles/web/cordis.patch.yml`:

`yaml
- insert:
    - id: vision-subagent
      name: 'dsh-vision-subagent'
      config:
        provider: kimi-coding   # or minimax-cn / a hand-declared route
        model: k3               # or MiniMax-M3 / MiniMax-VL-01
`

Restart `dsh web`, open a new session, and ask: "Look at ~/Desktop/error.png — what is the error?" The model calls `vision_agent(images=[...], question=...)` on its own.

## Screenshots

| Paste & ask | Analyzing | Clean bubble | Lightbox |
| --- | --- | --- | --- |
| ![composer with pasted image thumbnail](docs/images/paste-1-composer.png) | ![analysis progress capsule](docs/images/paste-2-analyzing.png) | ![bubble: thumbnails plus your words only](docs/images/paste-3-bubble.png) | ![lightbox with full analysis](docs/images/paste-4-lightbox.png) |

## Paste images into the composer (Codex-style)

The Web composer already supports native image blocks. The plugin defaults to capability-aware `pasteMode: auto`:

- **Current model accepts images** → the plugin stays transparent and calls DSH's original `sendSession(text, imageIds, mode, signal)`. The current model sees the original pixels with the full conversation context; no analysis capsule or pre-description is produced.
- **Current model is text-only** → the plugin delegates to its configured vision route: validates and stores the image, performs one intent-aware analysis on an isolated context, then sends only the analysis text plus durable original-image links to the main model.

The screenshots above show the delegated fallback path. Its chat bubble contains only your own words plus thumbnails; the analysis lives in the thumbnail lightbox. Need the original bytes later (image editing, pixel-level inspection)? `vision_image_fetch` materializes the full-fidelity file into `.dsh-vision/`.

Set `pasteMode: delegate` to force the isolated route even for multimodal models, or `pasteMode: native` to bypass the plugin and leave all admission to DSH. On delegated-analysis failure the message is not sent and the composer draft is preserved.

## MiniMax / Kimi vision models

| Provider | baseURL | Vision models | Key env |
| --- | --- | --- | --- |
| Kimi (Moonshot) | https://api.moonshot.cn/v1 | k3 / kimi-k3 / moonshot-v1-8k-vision-preview | MOONSHOT_API_KEY |
| MiniMax | https://api.minimaxi.com/v1 | MiniMax-VL-01 | MINIMAX_API_KEY |
| MiniMax CN | (built-in llm-pi-ai minimax-cn route) | MiniMax-M3 | MINIMAX_CN_API_KEY |

If a route already exists in Settings/Models (e.g. kimi-coding, minimax-cn), the plugin config only names provider + model — the key stays in the route's credential reference. The plugin itself never touches secrets.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| enabled | true | Master switch |
| provider / model | '' (dormant) | Vision route; must be set together |
| subagentProvider | spawn | ctx.subagents provider |
| maxDepth | 1 | Absolute delegation-depth cap for the spawned child; 1 lets the vision child run but forbids further delegation (0 would reject the child itself — a top-level agent's child is depth 1) |
| maxImages | 4 | Images per call |
| maxImageBytes | 10 MiB | Per-image byte cap |
| maxPromptChars | 8000 | Question length cap |
| maxOutputChars | 32000 | Returned text truncation |
| maxTokens | 4096 | Output token cap for delegated vision calls; 0 leaves it to the route |
| pasteMode | auto | `auto`: native for image-capable current models, delegated fallback for text-only; `delegate`/`native` force one path |
| allowRemoteUrls | false | Reserved (v0.1 supports local paths only) |
| allowOutsideWorkspace | false | Workspace containment bypass |
| extraAllowedRoots | [] | Extra allowed image roots |
| guidance | '' | Extra instructions appended to the child prompt |

## Security model

- Keys live only in the vision route's credential reference (env); the plugin accepts no plaintext secrets
- Local images default to the session workspace; symlinks are rejected; reads are byte-capped
- The child runs with maxDepth: 1 (runs, but cannot delegate further) and instructions forbid file modification and shell use
- `vision_image_fetch` writes only under the session workspace's `.dsh-vision/` with self-generated content-hashed filenames; no caller-controlled path segment reaches the disk

## Architecture

`
Main model (text-only)
   └─ vision_agent(images, question) ──┐
        │ 1. admission: ext / containment / symlink / byte cap
        │ 2. ctx.attachments.saveImage → durable content-addressed refs
        │ 3. ctx.subagents.start('spawn', { agentOptions: {provider, model} })
        ▼
One-shot subagent (MiniMax/Kimi vision route, own context)
   └─ final text ──► main session (only this message enters main context)
`

The plugin consumes harness services structurally (duck-typed) and is rc-version tolerant. Runtime dependencies: @deepseek-ai/dsh-tools (defineTool) and @deepseek-ai/schemastery (config schema) only.

## Roadmap

- [x] Web paste bridge: composer images auto-trigger vision analysis (v0.2)
- [x] Context-aware paste analysis: your draft message steers the vision focus; bubble stays clean (v0.3)
- [x] `vision_image_fetch`: materialize pasted originals into `.dsh-vision/` for editing (v0.3)
- [x] Capability-aware paste routing: native ImageBlocks for multimodal models, delegated fallback for text-only (v0.4)
- [ ] Settings panel for provider/model selection
- [ ] Remote image URL support (bounded fetch)
- [ ] Embedded SKILL.md steering when to delegate

## Development

`sh
npm install && npm run typecheck && npm test && npm run build
`

Version 0.4.1 is developed and release-tested against DSH `0.1.0-rc.8`. The delegated Web path now uses rc.8's atomic batch image admission, forwards submit cancellation, returns the native `SubmitOutcome`, and releases draft images only after a successful Host admission. DSH runtime packages are optional peers rather than ordinary dependencies, preventing a profile install from adding a second Harness runtime copy.

## License

MIT
