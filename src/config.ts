/**
 * Plugin configuration: Schemastery schema (validated by Cordis at load),
 * runtime resolution, and shared constants.
 * @module dsh-vision-subagent/config
 */

import Schema from '@deepseek-ai/schemastery'
import { VisionAgentError } from './errors.js'

export const PLUGIN_NAME = 'dsh-vision-subagent'
export const PLUGIN_ID = 'vision-subagent'

export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'
export const DEFAULT_MAX_DEPTH = 0
export const DEFAULT_MAX_IMAGES = 4
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_PROMPT_CHARS = 8000
export const DEFAULT_MAX_OUTPUT_CHARS = 32000
export const DEFAULT_MAX_TOKENS = 4096

/** Extensions the v1 attachment path understands. */
const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
} as const

export type SupportedImageMediaType = (typeof IMAGE_MEDIA_TYPES)[keyof typeof IMAGE_MEDIA_TYPES]

/** Media type for a local path from its extension, or undefined when unsupported. */
export function imageMediaTypeForPath(value: string): SupportedImageMediaType | undefined {
  const clean = value.split('?')[0]?.split('#')[0] ?? ''
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = clean.slice(dot).toLowerCase()
  return IMAGE_MEDIA_TYPES[ext as keyof typeof IMAGE_MEDIA_TYPES]
}

export interface Config {
  /** Master switch; the tool stays registered but refuses while false. */
  enabled: boolean
  /** LLM provider route carrying the vision model (e.g. 'kimi-coding', 'minimax-cn'). */
  provider: string
  /** Vision-capable model id on that route (e.g. 'k3', 'MiniMax-M3', 'MiniMax-VL-01'). */
  model: string
  /** Registered ctx.subagents provider used to run the child (default 'spawn'). */
  subagentProvider: string
  /** Delegation-depth cap for the child; 0 forbids further delegation. */
  maxDepth: number
  /** Inclusive image count per call. */
  maxImages: number
  /** Inclusive encoded byte limit per local image. */
  maxImageBytes: number
  /** Question character (UTF-16 code unit) limit. */
  maxPromptChars: number
  /** Returned text character limit before truncation. */
  maxOutputChars: number
  /** max_tokens for the vision calls (subagent child and paste analysis); 0 leaves it to the provider. */
  maxTokens: number
  /** Permit HTTP(S) image URLs in `images`. */
  allowRemoteUrls: boolean
  /** Allow image paths outside the session workspace (plus extraAllowedRoots). */
  allowOutsideWorkspace: boolean
  /** Additional normalized roots allowed for local images. */
  extraAllowedRoots: string[]
  /** Extra instructions appended to the child prompt (advanced steering). */
  guidance: string
}

export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  subagentProvider: Schema.string().default(DEFAULT_SUBAGENT_PROVIDER),
  maxDepth: Schema.number().step(1).min(0).max(8).default(DEFAULT_MAX_DEPTH),
  maxImages: Schema.number().step(1).min(1).max(8).default(DEFAULT_MAX_IMAGES),
  maxImageBytes: Schema.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
  maxPromptChars: Schema.number().step(1).min(1).default(DEFAULT_MAX_PROMPT_CHARS),
  maxOutputChars: Schema.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_CHARS),
  maxTokens: Schema.number().step(1).min(0).default(DEFAULT_MAX_TOKENS),
  allowRemoteUrls: Schema.boolean().default(false),
  allowOutsideWorkspace: Schema.boolean().default(false),
  extraAllowedRoots: Schema.array(Schema.string()).default([]),
  guidance: Schema.string().default(''),
})

export type ResolvedConfig = Config

/**
 * Cross-field validation beyond the schema: a half-configured route is a
 * misconfiguration, not a usable default.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const hasProvider = config.provider.trim().length > 0
  const hasModel = config.model.trim().length > 0
  if (hasProvider !== hasModel) {
    throw new VisionAgentError(
      'VISION_NOT_CONFIGURED',
      'dsh-vision-subagent: provider and model must be set together; got provider=' + JSON.stringify(config.provider) + ' model=' + JSON.stringify(config.model),
    )
  }
  return { ...config, provider: config.provider.trim(), model: config.model.trim() }
}
