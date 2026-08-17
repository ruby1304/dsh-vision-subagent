/** Wire constants shared by the host and client halves. No node imports here.
 * @module dsh-vision-subagent/web-contract */

export const WEB_PASTE_ENDPOINT = '/vision-subagent/v1/web-paste'
export const WEB_IMAGE_ENDPOINT = '/vision-subagent/v1/web-image'

/** Field carrying the opaque reference on projected attachment objects. */
export const VISION_REFERENCE_FIELD = 'visionSubagentReference'

export interface VisionImageRefParts {
  sessionId: string
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/**
 * Encode one durable image reference as the opaque link target embedded in
 * the durable user turn. Presentation-only consumers decode it back; the
 * host image endpoint re-reads the attachment store by these exact fields.
 */
export function encodeVisionImageReference(parts: VisionImageRefParts): string {
  const query = new URLSearchParams({
    media: parts.mediaType,
    bytes: String(parts.bytes),
    width: String(parts.width),
    height: String(parts.height),
  })
  if (parts.name !== undefined) query.set('name', parts.name)
  return (
    'vision-subagent://image/v1/'
    + encodeURIComponent(parts.sessionId)
    + '/'
    + encodeURIComponent(parts.attachmentId)
    + '?'
    + query.toString()
  )
}

/** Tolerant decoder: presentation never breaks on a malformed token. */
export function decodeVisionImageReference(value: string): VisionImageRefParts | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'vision-subagent:') return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'v1') return undefined
    const sessionId = decodeURIComponent(segments[1] ?? '')
    const attachmentId = decodeURIComponent(segments[2] ?? '')
    const mediaType = url.searchParams.get('media') ?? 'image/png'
    const bytes = Number(url.searchParams.get('bytes') ?? '0')
    const width = Number(url.searchParams.get('width') ?? '0')
    const height = Number(url.searchParams.get('height') ?? '0')
    const name = url.searchParams.get('name') ?? undefined
    if (sessionId === '' || attachmentId === '') return undefined
    return {
      sessionId,
      attachmentId,
      mediaType,
      bytes: Number.isSafeInteger(bytes) ? bytes : 0,
      width: Number.isSafeInteger(width) ? width : 0,
      height: Number.isSafeInteger(height) ? height : 0,
      ...(name === undefined ? {} : { name }),
    }
  } catch {
    return undefined
  }
}

/**
 * Machine-facing hint line embedded right after the analysis marker in the
 * durable user turn: tells the model how to recover original bytes. The view
 * layer strips it from the lightbox caption by this exact prefix.
 */
export const ORIGINAL_IMAGE_HINT_PREFIX = '[Original image bytes:'

/** The hint line text the client composes into bridged user turns. */
export const ORIGINAL_IMAGE_HINT_LINE = ORIGINAL_IMAGE_HINT_PREFIX
  + ' call the vision_image_fetch tool with an attachment URL above to materialize the full-fidelity file into the workspace, e.g. for editing.]'

/** The markdown link shape embedded in the durable user turn. */
export const VISION_LINK_PATTERN = /\[Attached image \d+\]\(vision-subagent:\/\/image\/v1\/[^)\s]+\)/gu

/** Build the link line for image N (0-based). */
export function visionImageLink(reference: string, index: number): string {
  return '[Attached image ' + String(index + 1) + '](' + reference + ')'
}
