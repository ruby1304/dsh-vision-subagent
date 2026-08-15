/**
 * The vision_agent tool: delegate image reading to a one-shot subagent on a
 * configured vision route. Only the child's final text returns to the main
 * session; image bytes and the child's intermediate context never do.
 * @module dsh-vision-subagent/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { VisionAgentError } from './errors.js'
import { prepareImage } from './image-source.js'
import type { FsLike, AttachmentsLike } from './image-source.js'
import { buildChildPrompt } from './prompt.js'
import { settleRun } from './settle.js'
import type { RunHandle } from './settle.js'

/** Structural minimum of the subagents service. */
export interface SubagentsLike {
  getProvider(name: string): unknown
  start(name: string, request: StartRequestLike): Promise<RunHandle>
}

/** Structural minimum of a one-shot start request. */
export interface StartRequestLike {
  label?: string
  prompt: ContentBlock[]
  parent: unknown
  agentOptions?: { provider: string; model: string; maxTokens?: number }
  maxDepth?: number
  signal: AbortSignal
}

export interface VisionResult {
  text: string
  provider: string
  model: string
  image_count: number
  stop_reason: string
}

const TOOL_DESCRIPTION = [
  'Read local image files through a delegated vision subagent and return its text analysis.',
  'The images are handed to a separately configured vision-capable model (e.g. a MiniMax or Kimi route) in a one-shot subagent:',
  'image data and the vision model\'s intermediate context never enter this conversation, and only the final text answer comes back.',
  'Use this for screenshots, photos, charts, UI mockups, OCR, and multi-image comparison whenever the current model route cannot see images itself.',
  'Prefer this over read_image for visual questions on text-only routes.',
].join(' ')

function truncated(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) return text
  const marker = '\n\n[vision_agent output truncated at ' + maxOutputChars + ' chars]'
  return text.slice(0, maxOutputChars) + marker
}

/** Optional pre-flight: refuse models whose route explicitly lacks image input. */
async function assertVisionCapable(ctx: Context, config: ResolvedConfig, signal: AbortSignal): Promise<void> {
  const llm = ctx.get('llm') as {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] }>
  } | undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return
  let info: { inputModalities?: readonly string[] }
  try {
    info = await llm.resolveModelInfo(config.provider, config.model, signal)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    const message = error instanceof Error ? error.message : String(error)
    throw new VisionAgentError('VISION_MODEL_UNRESOLVED', 'configured vision route could not be resolved: provider=' + config.provider + ' model=' + config.model + ' (' + message + ')')
  }
  if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
    throw new VisionAgentError(
      'VISION_MODEL_NOT_VISION',
      'configured model does not declare image input: provider=' + config.provider + ' model=' + config.model + '; pick a vision-capable model on that route',
    )
  }
}

export function createVisionAgentTool(ctx: Context, config: ResolvedConfig) {
  const services = ctx as unknown as {
    fs: FsLike
    attachments: AttachmentsLike
    subagents: SubagentsLike
  }

  return defineTool({
    name: 'vision_agent',
    description: TOOL_DESCRIPTION,
    parameters: {
      images: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Local paths of the image files to analyze (PNG/JPEG/WebP/GIF), resolved against the session working directory. One or more; number them in the question for multi-image comparison.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The concrete visual question to answer (e.g. "transcribe the error text", "what is the layout of this mockup", "which of image 1 and image 2 shows the bug and why").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          image_count: { type: 'integer', required: true },
          stop_reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new VisionAgentError('VISION_NO_AGENT', 'vision_agent requires a calling agent')
      }
      if (!config.enabled) {
        throw new VisionAgentError('VISION_DISABLED', 'dsh-vision-subagent is disabled by configuration (enabled: false)')
      }
      if (config.provider.length === 0 || config.model.length === 0) {
        throw new VisionAgentError(
          'VISION_NOT_CONFIGURED',
          'dsh-vision-subagent has no vision route configured; set provider and model in the vision-subagent row config (see README), e.g. provider: kimi-coding, model: k3',
        )
      }
      if (services.subagents.getProvider(config.subagentProvider) === undefined) {
        throw new VisionAgentError(
          'VISION_SUBAGENT_PROVIDER_MISSING',
          'subagent provider is not registered: ' + config.subagentProvider + '; the default "spawn" comes with the base profile',
        )
      }
      await assertVisionCapable(ctx, config, exec.signal)

      const images = args.images as unknown[]
      if (!Array.isArray(images) || images.length < 1 || images.length > config.maxImages) {
        throw new VisionAgentError('VISION_INVALID_ARGUMENT', 'images must contain between 1 and ' + config.maxImages + ' entries')
      }
      const inputs = images.map((entry) => {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          throw new VisionAgentError('VISION_INVALID_ARGUMENT', 'every images entry must be a non-empty string')
        }
        return entry.trim()
      })
      const question = args.question.trim()
      if (question.length === 0) {
        throw new VisionAgentError('VISION_INVALID_ARGUMENT', 'question must be non-empty')
      }
      if (question.length > config.maxPromptChars) {
        throw new VisionAgentError('VISION_INVALID_ARGUMENT', 'question exceeds the configured character limit of ' + config.maxPromptChars)
      }

      const prepared = []
      for (const input of inputs) {
        prepared.push(await prepareImage(services, exec, input, config))
      }

      const blocks = buildChildPrompt({
        question,
        imageNames: prepared.map((image) => image.name),
        refs: prepared.map((image) => image.ref),
        guidance: config.guidance,
      })

      const label = 'vision_agent: ' + (question.length > 60 ? question.slice(0, 57) + '...' : question)
      const request: StartRequestLike = {
        label,
        prompt: blocks,
        parent,
        agentOptions: {
          provider: config.provider,
          model: config.model,
          ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
        },
        maxDepth: config.maxDepth,
        signal: exec.signal,
      }

      try {
        const run = await services.subagents.start(config.subagentProvider, request)
        const settled = await settleRun(run)
        return {
          text: truncated(settled.text, config.maxOutputChars),
          provider: config.provider,
          model: config.model,
          image_count: prepared.length,
          stop_reason: settled.stopReason,
        }
      } catch (error) {
        if (exec.signal.aborted) throw exec.signal.reason
        if (error instanceof VisionAgentError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new VisionAgentError('VISION_SUBAGENT_FAILED', 'vision subagent start failed: ' + message)
      }
    },
  })
}
