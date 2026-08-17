/**
 * dsh-vision-subagent — vision for text-only DeepSeek Harness agents.
 *
 * Registers the vision_agent tool: local images are committed as durable
 * attachments and handed to a one-shot subagent running on a configured
 * vision-capable provider route (MiniMax / Kimi / any OpenAI-compatible
 * route). Only the child's final text returns to the main session.
 *
 * Configuration lives on the bundle row (see cordis.patch.yml and README):
 *
 *   provider: kimi-coding   # or minimax-cn, or a hand-declared route
 *   model: k3               # or MiniMax-M3 / MiniMax-VL-01 ...
 *
 * API keys are never part of this plugin's config: they stay in the route's
 * credential reference (e.g. KIMI_CODING_API_KEY / MINIMAX_CN_API_KEY).
 * @module dsh-vision-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import { ConfigSchema, resolveConfig } from './config.js'
import type { Config as ConfigInput } from './config.js'
import { createVisionAgentTool } from './tool.js'
import { createVisionImageFetchTool } from './tool-fetch.js'
import { registerWebPaste } from './web-paste.js'

export const name = 'vision-subagent'
export const inject = ['tools', 'fs', 'attachments', 'subagents']

export interface Config extends ConfigInput {}
export const Config = ConfigSchema
export { VisionAgentError } from './errors.js'
export type { VisionErrorCode } from './errors.js'
export { buildChildPrompt } from './prompt.js'

export function apply(ctx: Context, config: ConfigInput) {
  const resolved = resolveConfig(config)
  registerWebPaste(ctx, resolved)
  const attachments = (ctx as unknown as { attachments: Parameters<typeof createVisionImageFetchTool>[1] }).attachments
  const disposeAgent = ctx.tools.register(createVisionAgentTool(ctx, resolved))
  const disposeFetch = ctx.tools.register(createVisionImageFetchTool(resolved, attachments))
  return () => {
    disposeFetch?.()
    disposeAgent?.()
  }
}
