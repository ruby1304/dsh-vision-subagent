/**
 * Web paste bridge (client half).
 *
 * 1. SendSession wrap: a send carrying draft images uploads them to the host
 *    endpoint, which analyzes them on the vision route BEFORE submission; the
 *    rewritten message carries attachment links + the analysis text. A
 *    floating capsule shows progress while the analysis runs.
 * 2. Chat-node shadow renderer: user rows containing bridge links render as
 *    thumbnail gallery + native bubble; clicking a thumbnail opens a lightbox
 *    showing the image next to its vision analysis.
 * @module dsh-vision-subagent/client
 */

import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { ORIGINAL_IMAGE_HINT_LINE, WEB_IMAGE_ENDPOINT, WEB_PASTE_ENDPOINT, VISION_REFERENCE_FIELD, visionImageLink } from '../web-contract.js'
import { projectBridgedContent } from './chat-render.js'
import type { BridgedImage, BridgedProjection } from './chat-render.js'
import { resolvePasteRouteWithTimeout } from '../paste-preflight.js'
import type { PasteRouteConnection } from '../paste-preflight.js'
import type { PasteRoute } from '../paste-route.js'

export const inject = ['connection', 'conversation', 'sessions', 'slots']

const PACKAGE_NAME = 'dsh-vision-subagent'
const CHAT_NODE_SLOT = 'conversation.chat.node'
const RENDER_MARKER = Symbol.for(PACKAGE_NAME + '.client.chat-render')
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const PREFLIGHT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 120_000
const OVERLAY_ERROR_MS = 5000

interface SessionFace {
  readonly sessionId: string
}

interface DraftAttachment {
  readonly id: string
  readonly previewUrl: string
  readonly file: File
}

interface ConversationLike {
  sendSession(
    session: SessionFace,
    text: string,
    imageIds: readonly string[],
    mode: unknown,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome>
  draftImages(ids: readonly string[]): readonly DraftAttachment[]
  releaseDraftImages(attachments: readonly DraftAttachment[]): void
}

interface SlotEntry {
  readonly component: unknown
  readonly options: { readonly key?: string }
}

interface SlotsLike {
  inject(name: string, factory: () => unknown): unknown
  entries(name: string): readonly SlotEntry[]
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ContextLike {
  get(name: string): unknown
  effect(execute: () => (() => void), label?: string): unknown
}

interface AnalyzeOk {
  ok: true
  text: string
  provider: string
  model: string
  image_count: number
  references: string[]
}

type AnalyzeResponse = AnalyzeOk | { ok: false; error: { code: string; message: string } }

type RowProps = {
  node: { kind: string; data: { content?: readonly unknown[] } }
  loadImage?: (attachment: never) => Promise<string>
} & Record<string, unknown>

function isConversation(value: unknown): value is ConversationLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const candidate = value as Partial<ConversationLike>
  return typeof candidate.sendSession === 'function'
    && typeof candidate.draftImages === 'function'
    && typeof candidate.releaseDraftImages === 'function'
}

function canonicalConversation(value: unknown): ConversationLike | undefined {
  if (!isConversation(value)) return undefined
  const original = (value as unknown as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL]
  return isConversation(original) ? original : value
}

function sendSessionOwner(conversation: ConversationLike): object {
  let current: object | null = conversation as unknown as object
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'sendSession')
    if (typeof descriptor?.value === 'function') return current
    current = Object.getPrototypeOf(current)
  }
  throw new Error(PACKAGE_NAME + '/client: conversation sendSession descriptor is unavailable')
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
  if (!Array.isArray(payload.references) || payload.references.length !== images.length
    || !payload.references.every((reference) => typeof reference === 'string')) {
    throw new Error('host did not return one attachment reference per pasted image')
  }
  return payload
}

/** Compose the durable user turn: words + attachment links + analysis block. */
function composeText(userText: string, analysis: AnalyzeOk): string {
  const links = analysis.references.map((reference, index) => visionImageLink(reference, index)).join('\n')
  const block = '[Vision analysis of the pasted image' + (analysis.image_count > 1 ? 's' : '')
    + ' — produced by the vision route ' + analysis.provider + '/' + analysis.model
    + ' on an isolated context; the image bytes never entered this conversation]\n'
    + ORIGINAL_IMAGE_HINT_LINE + '\n' + analysis.text
  const parts: string[] = []
  if (userText.trim().length > 0) {
    parts.push(userText)
  } else {
    parts.push('The user pasted ' + analysis.image_count + ' image' + (analysis.image_count > 1 ? 's' : '') + ' without a text message.')
  }
  if (links !== '') parts.push(links)
  parts.push(block)
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ */
/* Progress capsule                                                    */
/* ------------------------------------------------------------------ */

let overlayStylesInjected = false

function ensureStyles(): void {
  if (overlayStylesInjected) return
  overlayStylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.dsh-vsa-overlay { position: fixed; left: 50%; bottom: 118px; transform: translateX(-50%);',
    '  z-index: 99999; display: flex; align-items: center; gap: 10px; max-width: 78vw;',
    '  background: rgba(15, 23, 42, 0.92); color: #e2e8f0;',
    '  border: 1px solid rgba(99, 102, 241, 0.45); border-radius: 999px;',
    '  padding: 10px 18px; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif;',
    '  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); pointer-events: none;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.dsh-vsa-spinner { width: 14px; height: 14px; border-radius: 99px; flex: none;',
    '  border: 2px solid rgba(129, 140, 248, 0.35); border-top-color: #818cf8;',
    '  animation: dsh-vsa-spin 0.8s linear infinite; }',
    '.dsh-vsa-overlay.dsh-vsa-error { border-color: rgba(248, 113, 113, 0.6); color: #fecaca; }',
    '@keyframes dsh-vsa-spin { to { transform: rotate(360deg) } }',
    '.dsh-vsa-gallery { display: flex; gap: 8px; justify-content: flex-end; margin: 6px 0 2px; flex-wrap: wrap; }',
    '.dsh-vsa-thumb { padding: 0; border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 10px; overflow: hidden;',
    '  background: none; cursor: zoom-in; max-height: 120px; display: block; }',
    '.dsh-vsa-thumb img { display: block; max-height: 120px; max-width: 220px; object-fit: cover; }',
    '.dsh-vsa-thumb-pending { min-width: 72px; height: 72px; display: flex; align-items: center; justify-content: center;',
    '  color: #94a3b8; font: 12px/1 -apple-system, sans-serif; }',
    '.dsh-vsa-lightbox { position: fixed; inset: 0; z-index: 100000; background: rgba(2, 6, 23, 0.78);',
    '  display: flex; align-items: center; justify-content: center; padding: 4vh 4vw; }',
    '.dsh-vsa-lightbox-body { position: relative; background: #0f172a; border-radius: 14px; max-width: min(1080px, 92vw);',
    '  max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;',
    '  border: 1px solid rgba(99, 102, 241, 0.35); box-shadow: 0 24px 64px rgba(0,0,0,0.5); }',
    '.dsh-vsa-lightbox-body img { display: block; max-width: 92vw; max-height: 58vh; object-fit: contain; margin: 18px auto 0; border-radius: 8px; }',
    '.dsh-vsa-caption { color: #cbd5e1; font: 13px/1.7 -apple-system, "Segoe UI", sans-serif;',
    '  padding: 16px 20px 20px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }',
    '.dsh-vsa-caption-title { color: #818cf8; font-weight: 600; margin-bottom: 6px; }',
    '.dsh-vsa-close { position: absolute; top: 10px; right: 12px; width: 30px; height: 30px; border-radius: 99px;',
    '  border: 1px solid rgba(148, 163, 184, 0.4); background: rgba(15, 23, 42, 0.8); color: #e2e8f0;',
    '  font-size: 16px; line-height: 1; cursor: pointer; }',
  ].join('')
  document.head.appendChild(style)
}

interface PendingOverlay {
  setText(text: string): void
  setError(text: string): void
  /** The capsule follows its owning session: hidden while another session is viewed. */
  setVisible(visible: boolean): void
  remove(): void
}

/** Structural minimum of the client sessions service's selection feed. */
interface SessionsLike {
  readonly list: {
    getSnapshot(): { current?: string }
    subscribe(fn: () => void): () => void
  }
}

function createPendingOverlay(): PendingOverlay {
  ensureStyles()
  const element = document.createElement('div')
  element.className = 'dsh-vsa-overlay'
  const spinner = document.createElement('span')
  spinner.className = 'dsh-vsa-spinner'
  const label = document.createElement('span')
  element.append(spinner, label)
  document.body.appendChild(element)
  return {
    setText(text: string): void {
      label.textContent = text
    },
    setError(text: string): void {
      element.classList.add('dsh-vsa-error')
      spinner.style.display = 'none'
      label.textContent = text
    },
    setVisible(visible: boolean): void {
      // The stylesheet supplies display:flex; only the opt-out is inline.
      element.style.display = visible ? '' : 'none'
    },
    remove(): void {
      element.remove()
    },
  }
}

/* ------------------------------------------------------------------ */
/* History image loader (session-authorized via the opaque reference)  */
/* ------------------------------------------------------------------ */

const imageUrlCache = new Map<string, Promise<string>>()

function loadBridgedImage(reference: string): Promise<string> {
  let pending = imageUrlCache.get(reference)
  if (pending === undefined) {
    pending = fetch(WEB_IMAGE_ENDPOINT + '?ref=' + encodeURIComponent(reference), { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('image load failed (HTTP ' + response.status + ')')
        const blob = await response.blob()
        return URL.createObjectURL(blob)
      })
    imageUrlCache.set(reference, pending)
  }
  return pending
}

/* ------------------------------------------------------------------ */
/* Chat-node shadow renderer                                           */
/* ------------------------------------------------------------------ */

function Thumb(props: { image: BridgedImage; onOpen: () => void }): ReactElement {
  const { image, onOpen } = props
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    loadBridgedImage(image.attachment[VISION_REFERENCE_FIELD])
      .then((url) => { if (alive) setSrc(url) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [image.attachment[VISION_REFERENCE_FIELD]])
  const name = image.attachment.name ?? 'pasted image'
  if (src === null) {
    return h('div', { className: 'dsh-vsa-thumb' }, h('div', { className: 'dsh-vsa-thumb-pending' }, failed ? '加载失败' : '…'))
  }
  return h('button', { type: 'button', className: 'dsh-vsa-thumb', title: '点击预览', onClick: onOpen },
    h('img', { src, alt: name }))
}

function Lightbox(props: { image: BridgedImage; caption: string; onClose: () => void }): ReactElement {
  const { image, caption, onClose } = props
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadBridgedImage(image.attachment[VISION_REFERENCE_FIELD])
      .then((url) => { if (alive) setSrc(url) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [image.attachment[VISION_REFERENCE_FIELD]])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return h('div', { className: 'dsh-vsa-lightbox', onClick: onClose },
    h('div', { className: 'dsh-vsa-lightbox-body', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      src !== null ? h('img', { src, alt: image.attachment.name ?? 'pasted image' }) : null,
      caption !== ''
        ? h('div', { className: 'dsh-vsa-caption' },
            h('div', { className: 'dsh-vsa-caption-title' }, '视觉分析结果'),
            caption)
        : null,
      h('button', { type: 'button', className: 'dsh-vsa-close', title: '关闭', onClick: onClose }, '×')))
}

function stockComponentFor(slots: SlotsLike, key: string): ((props: never) => unknown) | undefined {
  const entries = slots.entries(CHAT_NODE_SLOT)
  const found = entries.find((entry) => entry.options.key === key
    && (entry.component as Record<PropertyKey, unknown>)[RENDER_MARKER] === undefined)
  return found?.component as ((props: never) => unknown) | undefined
}

function createBridgedRow(slots: SlotsLike, key: string) {
  function BridgedRow(props: RowProps): ReactElement | null {
    const content = (props.node?.data?.content ?? []) as never
    const projection: BridgedProjection = useMemo(() => projectBridgedContent(content), [content])
    const [openIndex, setOpenIndex] = useState(-1)
    const stock = stockComponentFor(slots, key)
    if (!projection.bridged || stock === undefined) {
      return stock === undefined ? null : h(stock as never, props as never)
    }
    ensureStyles()
    const textProps = {
      ...props,
      node: { ...props.node, data: { ...props.node.data, content: projection.content } },
    } as RowProps
    return h('div', null,
      h('div', { className: 'dsh-vsa-gallery' },
        projection.images.map((image, index) => h(Thumb, {
          key: image.attachment.attachmentId + String(index),
          image,
          onOpen: () => setOpenIndex(index),
        }))),
      // Image-only sends have no words for the stock bubble; skip it entirely.
      projection.content.length > 0 ? h(stock as never, textProps as never) : null,
      openIndex >= 0 && projection.images[openIndex] !== undefined
        ? h(Lightbox, {
            image: projection.images[openIndex]!,
            caption: projection.analysis,
            onClose: () => setOpenIndex(-1),
          })
        : null)
  }
  ;(BridgedRow as unknown as Record<PropertyKey, unknown>)[RENDER_MARKER] = true
  return BridgedRow
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export function apply(ctx: ContextLike): () => void {
  const raw = ctx.get('conversation')
  const conversation = canonicalConversation(raw)
  if (conversation === undefined) {
    throw new Error(PACKAGE_NAME + '/client: conversation service is unavailable')
  }
  const connection = ctx.get('connection') as PasteRouteConnection | undefined
  const owner = sendSessionOwner(conversation)
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'sendSession')
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error(PACKAGE_NAME + '/client: conversation sendSession descriptor is unavailable')
  }
  const original = descriptor.value as ConversationLike['sendSession']

  // Pending analyses keyed by owning session: the floating capsule follows
  // its session — switching away hides it, switching back re-shows it while
  // the analysis is still running.
  const pending = new Map<string, PendingOverlay>()
  let currentSession: string | undefined
  const syncOverlayVisibility = (): void => {
    for (const [id, overlay] of pending) overlay.setVisible(id === currentSession)
  }
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  let unsubscribeSessions: (() => void) | undefined
  if (sessions !== undefined
    && typeof sessions.list?.getSnapshot === 'function'
    && typeof sessions.list?.subscribe === 'function') {
    currentSession = sessions.list.getSnapshot().current
    unsubscribeSessions = sessions.list.subscribe(() => {
      currentSession = sessions.list.getSnapshot().current
      syncOverlayVisibility()
    })
  }

  const wrapped = async function sendSession(
    this: ConversationLike,
    session: SessionFace,
    text: string,
    imageIds: readonly string[],
    mode: unknown,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    if (imageIds.length === 0) {
      return original.call(this, session, text, imageIds, mode, signal)
    }
    let route: PasteRoute = 'delegate'
    if (connection !== undefined) {
      try {
        route = await resolvePasteRouteWithTimeout(
          session.sessionId,
          connection,
          fetch,
          PREFLIGHT_TIMEOUT_MS,
          signal,
        )
      } catch (error) {
        // A cancelled submit is not a capability miss. In particular, do not
        // turn it into a fresh delegated upload after the composer has moved on.
        if (signal?.aborted) signal.throwIfAborted()
        // Capability uncertainty must not eat the user's send. The historical
        // delegate path is the safe fallback because it works on text-only
        // routes; native admission remains available when preflight succeeds.
        console.warn('[' + PACKAGE_NAME + '] paste capability preflight failed; falling back to delegate:', error)
      }
    }
    if (route === 'native') {
      return original.call(this, session, text, imageIds, mode, signal)
    }
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error(PACKAGE_NAME + '/client: one or more pasted images are no longer available')
    }
    // Analysis gets its own controller. A timed-out capability preflight must
    // never poison the delegated fallback with an already-aborted signal.
    const controller = new AbortController()
    const analysisSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => controller.abort('vision paste analysis timed out'), REQUEST_TIMEOUT_MS)
    const overlay = createPendingOverlay()
    overlay.setText('正在分析图片…')
    pending.set(session.sessionId, overlay)
    syncOverlayVisibility()
    const startedAt = performance.now()
    const elapsed = setInterval(() => {
      overlay.setText('正在分析图片… ' + Math.round((performance.now() - startedAt) / 1000) + 's')
    }, 1000)
    let errorLinger: ReturnType<typeof setTimeout> | undefined
    let phase: 'analysis' | 'submit' = 'analysis'
    const settle = (): void => {
      pending.delete(session.sessionId)
      overlay.remove()
    }
    try {
      const analysis = await analyzePasted(session.sessionId, text, attachments, fetch, analysisSignal)
      phase = 'submit'
      const outcome = await original.call(this, session, composeText(text, analysis), [], mode, signal)
      // Match rc.8's native transaction boundary: a refused Host admission
      // leaves the user's draft images intact for a retry or edit.
      if (outcome.kind === 'success') this.releaseDraftImages(attachments)
      return outcome
    } catch (error) {
      if (phase === 'analysis') {
        const message = error instanceof Error ? error.message : String(error)
        overlay.setError('图片分析失败：' + message + '（消息未发送，图片已保留）')
        errorLinger = setTimeout(settle, OVERLAY_ERROR_MS)
      }
      throw error
    } finally {
      clearTimeout(timer)
      clearInterval(elapsed)
      if (errorLinger === undefined) settle()
    }
  }

  Object.defineProperty(owner, 'sendSession', { ...descriptor, value: wrapped })

  // Shadow the user/steering chat rows so bridged links render as a native
  // thumbnail gallery with an analysis lightbox. Non-bridged rows defer to
  // the stock renderer untouched.
  const slots = ctx.get('slots') as SlotsLike | undefined
  let disposeUser: (() => void) | undefined
  let disposeSteering: (() => void) | undefined
  if (slots !== undefined) {
    for (const key of ['user', 'steering'] as const) {
      const component = createBridgedRow(slots, key)
      const dispose = slots.inject(CHAT_NODE_SLOT, () => slots.register({
        name: CHAT_NODE_SLOT,
        key,
        priority: -100,
        // Inherit the conversation namespace so the entry-derived translator
        // stays a real function: the stock renderer we defer to calls it and
        // crashes hard (slot error boundary, abdication, invisible row) when
        // it receives an undefined one.
        locale: 'conversation',
        registrant: PACKAGE_NAME + '/client',
      }, component))
      if (key === 'user') disposeUser = dispose as () => void
      else disposeSteering = dispose as () => void
    }
  }

  return () => {
    Object.defineProperty(owner, 'sendSession', descriptor)
    unsubscribeSessions?.()
    for (const overlay of pending.values()) overlay.remove()
    pending.clear()
    disposeUser?.()
    disposeSteering?.()
  }
}
