/**
 * Web paste bridge (client half). Wraps the composer's conversation service
 * sendSession: when a send carries draft images, the images are uploaded to
 * the host endpoint and analyzed on the vision route BEFORE the message is
 * submitted. The rewritten user message contains only the analysis text, so
 * the main model answers immediately — Codex-style paste, on a text-only
 * route. The composer keeps its draft on any failure.
 * @module dsh-vision-subagent/client
 */

import { WEB_PASTE_ENDPOINT } from '../web-contract.js'

export const inject = ['conversation']

interface SessionFace {
  readonly sessionId: string
}

interface DraftAttachment {
  readonly id: string
  readonly previewUrl: string
  readonly file: File
}

interface ConversationLike {
  sendSession(session: SessionFace, text: string, imageIds: readonly string[], mode: unknown): Promise<void>
  draftImages(ids: readonly string[]): readonly DraftAttachment[]
  releaseDraftImages(attachments: readonly DraftAttachment[]): void
}

interface ContextLike {
  get(name: string): unknown
}

interface AnalyzeOk {
  ok: true
  text: string
  provider: string
  model: string
  image_count: number
}

interface AnalyzeError {
  ok: false
  error: { code: string; message: string }
}

type AnalyzeResponse = AnalyzeOk | AnalyzeError

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const REQUEST_TIMEOUT_MS = 120_000

function isConversation(value: unknown): value is ConversationLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const candidate = value as Partial<ConversationLike>
  return typeof candidate.sendSession === 'function'
    && typeof candidate.draftImages === 'function'
    && typeof candidate.releaseDraftImages === 'function'
}

/** The canonical service target behind caller-traced proxies, when exposed. */
function canonicalConversation(value: unknown): ConversationLike | undefined {
  if (!isConversation(value)) return undefined
  const original = (value as unknown as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL]
  return isConversation(original) ? original : value
}

/** Walk the prototype chain to the descriptor owner of sendSession. */
function sendSessionOwner(conversation: ConversationLike): object {
  let current: object | null = conversation as unknown as object
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'sendSession')
    if (typeof descriptor?.value === 'function') return current
    current = Object.getPrototypeOf(current)
  }
  throw new Error('dsh-vision-subagent/client: conversation sendSession descriptor is unavailable')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)))
  }
  return btoa(binary)
}

async function serializeImage(attachment: DraftAttachment): Promise<{ name: string; mediaType: string; data: string }> {
  const bytes = new Uint8Array(await attachment.file.arrayBuffer())
  return {
    name: attachment.file.name || 'pasted-image',
    mediaType: attachment.file.type || 'image/png',
    data: bytesToBase64(bytes),
  }
}

async function analyzePasted(
  sessionId: string,
  question: string,
  attachments: readonly DraftAttachment[],
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<AnalyzeOk> {
  const images = []
  for (const attachment of attachments) images.push(await serializeImage(attachment))
  const response = await fetcher(WEB_PASTE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, question, images }),
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  })
  const text = await response.text()
  if (text.length > 128 * 1024) throw new Error('host returned an oversized response')
  let payload: AnalyzeResponse
  try {
    payload = JSON.parse(text) as AnalyzeResponse
  } catch {
    throw new Error('host returned an invalid response')
  }
  if (!response.ok || payload.ok !== true) {
    if (payload.ok === false) {
      throw new Error('vision analysis failed (' + payload.error.code + '): ' + payload.error.message)
    }
    throw new Error('vision analysis failed (HTTP ' + response.status + '): ' + text.slice(0, 200))
  }
  return payload
}

/** Compose the durable user turn: the user's words plus the analysis block. */
function composeText(userText: string, analysis: AnalyzeOk): string {
  const block = '[Vision analysis of the pasted image' + (analysis.image_count > 1 ? 's' : '') + ' — produced by the vision route ' + analysis.provider + '/' + analysis.model + ' on an isolated context; the image bytes never entered this conversation]\n' + analysis.text
  return userText.trim().length === 0
    ? 'The user pasted ' + analysis.image_count + ' image' + (analysis.image_count > 1 ? 's' : '') + ' without a text message.\n\n' + block
    : userText + '\n\n' + block
}

export function apply(ctx: ContextLike): () => void {
  const raw = ctx.get('conversation')
  const conversation = canonicalConversation(raw)
  if (conversation === undefined) {
    throw new Error('dsh-vision-subagent/client: conversation service is unavailable')
  }
  const owner = sendSessionOwner(conversation)
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'sendSession')
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error('dsh-vision-subagent/client: conversation sendSession descriptor is unavailable')
  }
  const original = descriptor.value as ConversationLike['sendSession']

  const wrapped = async function sendSession(
    this: ConversationLike,
    session: SessionFace,
    text: string,
    imageIds: readonly string[],
    mode: unknown,
  ): Promise<void> {
    if (imageIds.length === 0) {
      await original.call(this, session, text, imageIds, mode)
      return
    }
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('dsh-vision-subagent/client: one or more pasted images are no longer available')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('vision paste analysis timed out'), REQUEST_TIMEOUT_MS)
    try {
      const analysis = await analyzePasted(session.sessionId, text, attachments, fetch, controller.signal)
      this.releaseDraftImages(attachments)
      await original.call(this, session, composeText(text, analysis), [], mode)
    } finally {
      clearTimeout(timer)
    }
  }

  Object.defineProperty(owner, 'sendSession', { ...descriptor, value: wrapped })
  return () => {
    Object.defineProperty(owner, 'sendSession', descriptor)
  }
}
