/**
 * Web paste bridge (host half): one endpoint the browser client calls at
 * send time with the pasted images plus the user's message. The handler
 * validates the session, commits durable attachments, runs ONE vision-route
 * LLM call on an isolated context, and returns only the analysis text.
 * @module dsh-vision-subagent/web-paste
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageAttachmentLimits, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { PLUGIN_NAME } from './config.js'
import type { ResolvedConfig } from './config.js'
import { buildChildPrompt, pasteAnalysisQuestion } from './prompt.js'
import { extractText } from './settle.js'
import { WEB_IMAGE_ENDPOINT, WEB_PASTE_ENDPOINT, decodeVisionImageReference, encodeVisionImageReference } from './web-contract.js'

/** Structural minimums, version-tolerant. */
interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}
interface SessionsLike {
  get(id: string): unknown
}
interface LlmLike {
  stream(options: {
    provider: string
    model: string
    messages: unknown[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}
interface AttachmentsLike {
  imageLimits: ImageAttachmentLimits
  validateImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<void>
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
}

export interface WebPasteServices {
  webServer: WebServerLike
  sessions: SessionsLike
  llm: LlmLike
  attachments: AttachmentsLike
}

interface UploadImage {
  name: string
  mediaType: string
  data: string
}

export interface WebPasteRequest {
  sessionId: string
  question: string
  images: UploadImage[]
}

export type WebPasteResponse =
  | { ok: true; text: string; provider: string; model: string; image_count: number; references: string[] }
  | { ok: false; error: { code: string; message: string } }

const ACCEPTED_MEDIA = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function respond(res: ServerResponse, status: number, payload: WebPasteResponse): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Read a bounded JSON request body; rejects oversized uploads before parsing. */
async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    total += part.byteLength
    if (total > maxBytes) throw new Error('request body exceeds the upload limit')
    chunks.push(part)
  }
  if (chunks.length === 0) throw new Error('request body is empty')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function parseRequest(value: unknown): WebPasteRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be a JSON object')
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) throw new Error('sessionId must be a non-empty string')
  if (typeof raw.question !== 'string') throw new Error('question must be a string')
  if (!Array.isArray(raw.images) || raw.images.length < 1) throw new Error('images must be a non-empty array')
  return {
    sessionId: raw.sessionId,
    question: raw.question,
    images: raw.images.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('images[' + index + '] must be an object')
      const image = entry as Record<string, unknown>
      if (typeof image.name !== 'string') throw new Error('images[' + index + '].name must be a string')
      if (typeof image.mediaType !== 'string') throw new Error('images[' + index + '].mediaType must be a string')
      if (typeof image.data !== 'string') throw new Error('images[' + index + '].data must be a base64 string')
      return { name: image.name, mediaType: image.mediaType, data: image.data }
    }),
  }
}

function base64ToBytes(data: string): Uint8Array {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new Error('image data is not valid base64')
  }
}

/** Assemble the text blocks of one vision call (same rule as settle.extractText). */
function blocksText(assembler: BlockAssembler): string {
  return extractText(assembler.blocks())
}

/**
 * Run one vision-route call for pasted images and return the analysis text.
 */
async function analyzeImages(
  services: WebPasteServices,
  config: ResolvedConfig,
  refs: ImageAttachmentRef[],
  names: string[],
  question: string,
  signal: AbortSignal,
): Promise<string> {
  const blocks: ContentBlock[] = buildChildPrompt({
    question: pasteAnalysisQuestion(question),
    imageNames: names,
    refs,
    guidance: config.guidance,
  })
  const messages = [
    createUserMessage({
      content: blocks,
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }),
  ]
  const assembler = new BlockAssembler()
  for await (const chunk of services.llm.stream({
    provider: config.provider,
    model: config.model,
    messages: messages as unknown[],
    ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
    signal,
  })) {
    assembler.push(chunk as never)
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const failure = (finish as { failure?: { code?: string; message?: string } }).failure
    throw new Error('vision model call failed (' + (failure?.code ?? finish.kind) + '): ' + (failure?.message ?? 'no detail'))
  }
  if (finish.kind === 'tool-calls') {
    throw new Error('vision model unexpectedly requested a tool')
  }
  const text = blocksText(assembler)
  if (text.trim().length === 0) {
    throw new Error('vision model produced no text' + (finish.kind === 'max-tokens' ? ' before hitting maxTokens' : ''))
  }
  return text
}

export function createWebPasteHandler(services: WebPasteServices, config: ResolvedConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Client-disconnect detection: the REQUEST 'close' event fires as soon as
    // the request body is fully read (keep-alive semantics), which would abort
    // every request before the vision call even starts. The RESPONSE 'close'
    // event fires when the response terminates; if we have not ended it
    // ourselves by then, the client really did disconnect.
    const controller = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort('client disconnected')
    }
    res.once('close', onClose)
    try {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, error: { code: 'VISION_METHOD_NOT_ALLOWED', message: 'web-paste accepts POST only' } })
        return
      }
      if (!config.enabled) {
        respond(res, 503, { ok: false, error: { code: 'VISION_DISABLED', message: 'dsh-vision-subagent is disabled by configuration' } })
        return
      }
      if (config.provider.length === 0 || config.model.length === 0) {
        respond(res, 503, { ok: false, error: { code: 'VISION_NOT_CONFIGURED', message: 'dsh-vision-subagent has no vision route configured; set provider and model in the vision-subagent row config' } })
        return
      }
      const uploadCap = Math.min(config.maxImageBytes * config.maxImages, 64 * 1024 * 1024)
      let request: WebPasteRequest
      try {
        request = parseRequest(await readBoundedJson(req, uploadCap + 4096))
      } catch (error) {
        respond(res, 400, { ok: false, error: { code: 'VISION_INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'invalid request' } })
        return
      }
      if (services.sessions.get(request.sessionId) === undefined) {
        respond(res, 404, { ok: false, error: { code: 'VISION_SESSION_NOT_FOUND', message: 'session does not exist on this host' } })
        return
      }
      if (request.images.length > config.maxImages) {
        respond(res, 400, { ok: false, error: { code: 'VISION_TOO_MANY_IMAGES', message: 'images exceeds the configured maximum of ' + config.maxImages } })
        return
      }
      if (request.question.length > config.maxPromptChars) {
        respond(res, 400, { ok: false, error: { code: 'VISION_PROMPT_TOO_LONG', message: 'question exceeds the configured character limit of ' + config.maxPromptChars } })
        return
      }
      const refs: ImageAttachmentRef[] = []
      const names: string[] = []
      try {
        for (const image of request.images) {
          if (!ACCEPTED_MEDIA.has(image.mediaType) || !services.attachments.imageLimits.mediaTypes.includes(image.mediaType as ImageMediaType)) {
            throw new Error('unsupported image media type: ' + image.mediaType)
          }
          const bytes = base64ToBytes(image.data)
          const cap = Math.min(config.maxImageBytes, services.attachments.imageLimits.maxImageBytes, services.attachments.imageLimits.maxMessageImageBytes)
          if (bytes.byteLength > cap) throw new Error('image exceeds the configured byte limit')
          const cleanName = (image.name.split(/[\\/]/u).filter((part) => part.length > 0).at(-1) ?? 'pasted-image') || 'pasted-image'
          await services.attachments.validateImage({ data: bytes, mediaType: image.mediaType as ImageMediaType, name: cleanName })
          const ref = await services.attachments.saveImage({ data: bytes, mediaType: image.mediaType as ImageMediaType, name: cleanName })
          refs.push(ref)
          names.push(cleanName)
        }
      } catch (error) {
        respond(res, 400, { ok: false, error: { code: 'VISION_IMAGE_REJECTED', message: error instanceof Error ? error.message : 'image admission failed' } })
        return
      }
      try {
        const text = await analyzeImages(services, config, refs, names, request.question, controller.signal)
        const references = refs.map((ref) => encodeVisionImageReference({
          sessionId: request.sessionId,
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        }))
        respond(res, 200, { ok: true, text, provider: config.provider, model: config.model, image_count: refs.length, references })
      } catch (error) {
        if (controller.signal.aborted) {
          res.destroy()
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        // Sanitized: no image bytes, paths, or credentials ever reach the log.
        console.error('[dsh-vision-subagent] web-paste analysis failed:', message)
        respond(res, 502, { ok: false, error: { code: 'VISION_ANALYSIS_FAILED', message } })
      }
    } finally {
      res.off('close', onClose)
    }
  }
}

/**
 * GET /vision-subagent/v1/web-image?ref=<encoded>: serve the exact attachment
 * bytes a presentation link names, authorized by the session in the link.
 * The durable turn carries only text links; this endpoint is how thumbnails
 * and previews ever reach the browser.
 */
export function createWebImageHandler(services: WebPasteServices) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'GET') {
        respond(res, 405, { ok: false, error: { code: 'VISION_METHOD_NOT_ALLOWED', message: 'web-image accepts GET only' } })
        return
      }
      const url = new URL(req.url ?? '', 'http://localhost')
      const rawRef = url.searchParams.get('ref') ?? ''
      const parts = decodeVisionImageReference(rawRef)
      if (parts === undefined) {
        respond(res, 400, { ok: false, error: { code: 'VISION_INVALID_REFERENCE', message: 'reference is not a dsh-vision-subagent image link' } })
        return
      }
      if (services.sessions.get(parts.sessionId) === undefined) {
        respond(res, 404, { ok: false, error: { code: 'VISION_SESSION_NOT_FOUND', message: 'session does not exist on this host' } })
        return
      }
      const stored = await services.attachments.readImage({
        attachmentId: parts.attachmentId as never,
        mediaType: parts.mediaType as ImageMediaType,
        bytes: parts.bytes,
        width: parts.width,
        height: parts.height,
        ...(parts.name === undefined ? {} : { name: parts.name }),
      })
      res.writeHead(200, {
        'content-type': stored.ref.mediaType,
        'content-length': String(stored.data.byteLength),
        'cache-control': 'private, max-age=3600',
      })
      res.end(Buffer.from(stored.data))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      respond(res, 500, { ok: false, error: { code: 'VISION_IMAGE_READ_FAILED', message } })
    }
  }
}

export function registerWebPaste(ctx: { inject(deps: string[], apply: (webCtx: unknown) => () => void): unknown }, config: ResolvedConfig): void {
  ctx.inject(['webServer', 'sessions', 'llm'], (webCtx) => {
    const services = webCtx as unknown as WebPasteServices
    const disposePaste = services.webServer.register({
      kind: 'exact',
      path: WEB_PASTE_ENDPOINT,
      handler: createWebPasteHandler(services, config),
    })
    const disposeImage = services.webServer.register({
      kind: 'exact',
      path: WEB_IMAGE_ENDPOINT,
      handler: createWebImageHandler(services),
    })
    return () => {
      disposeImage()
      disposePaste()
    }
  })
}
