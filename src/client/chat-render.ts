/**
 * Presentation-layer projection for bridged user turns.
 *
 * The durable user turn keeps its exact text (user words + opaque attachment
 * links + the vision analysis block). This module upgrades only how the chat
 * history RENDERS such a turn: links become thumbnail blocks and the
 * analysis text is split out so the preview can show it next to the image.
 * No node data is mutated.
 * @module dsh-vision-subagent/client/chat-render
 */

import { ORIGINAL_IMAGE_HINT_PREFIX, VISION_LINK_PATTERN, VISION_REFERENCE_FIELD, decodeVisionImageReference } from '../web-contract.js'

export interface ChatContentBlock {
  readonly type: string
  readonly text?: string
  readonly attachment?: unknown
  readonly [key: string]: unknown
}

export interface BridgedImage {
  readonly attachment: {
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
    readonly [VISION_REFERENCE_FIELD]: string
  }
}

export interface BridgedProjection {
  readonly bridged: boolean
  /** User words plus the vision analysis text, with link lines removed. */
  readonly text: string
  /** The user's own words only; empty when the send carried no real text. */
  readonly visibleText: string
  /** The analysis section only (from the marker line onward), for the preview caption. */
  readonly analysis: string
  readonly images: readonly BridgedImage[]
  /** View-only content (text-only) for the stock renderer; empty for image-only sends. */
  readonly content: readonly ChatContentBlock[]
}

export const ANALYSIS_MARKER = '[Vision analysis'

/** Matches the synthetic line composeText writes when the user sent no words. */
const PLACEHOLDER_PATTERN = /^The user pasted \d+ images? without a text message\.$/

/** Drop machine-facing hint lines (e.g. the vision_image_fetch pointer) from a caption. */
function stripHintLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith(ORIGINAL_IMAGE_HINT_PREFIX))
    .join('\n')
    .trim()
}

interface LinkMatch {
  readonly start: number
  readonly end: number
}

function findLinks(text: string): LinkMatch[] {
  const links: LinkMatch[] = []
  for (const match of text.matchAll(VISION_LINK_PATTERN)) {
    if (match[0] === undefined) continue
    links.push({ start: match.index, end: match.index + match[0].length })
  }
  return links
}

function linkTarget(text: string, link: LinkMatch): string {
  const raw = text.slice(link.start, link.end)
  return raw.slice(raw.indexOf('](', 1) + 2, -1)
}

function textOf(content: readonly ChatContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Split the visible text into the user's words and the analysis section. */
export function splitAnalysis(text: string): { question: string; analysis: string } {
  const marker = text.indexOf(ANALYSIS_MARKER)
  if (marker < 0) return { question: text, analysis: '' }
  return { question: text.slice(0, marker).trimEnd(), analysis: text.slice(marker).trim() }
}

/**
 * Project one user message's content: bridged links become image descriptors
 * (with the reference kept for the loader), link lines vanish from the text,
 * and the analysis section is available separately for the preview caption.
 */
export function projectBridgedContent(content: readonly ChatContentBlock[]): BridgedProjection {
  const images: BridgedImage[] = []
  const kept: string[] = []
  const rest: ChatContentBlock[] = []
  let bridged = false

  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      rest.push(block)
      continue
    }
    const links = findLinks(block.text)
    if (links.length === 0) {
      kept.push(block.text)
      continue
    }
    bridged = true
    let cursor = 0
    let text = ''
    for (const link of links) {
      text += block.text.slice(cursor, link.start)
      cursor = link.end
      const target = linkTarget(block.text, link)
      const parts = decodeVisionImageReference(target)
      if (parts !== undefined) {
        images.push({
          attachment: {
            attachmentId: parts.attachmentId,
            mediaType: parts.mediaType,
            bytes: parts.bytes,
            width: parts.width,
            height: parts.height,
            ...(parts.name === undefined ? {} : { name: parts.name }),
            [VISION_REFERENCE_FIELD]: target,
          },
        })
      }
    }
    text += block.text.slice(cursor)
    kept.push(text)
  }

  const rawText = textOf([...kept.map((t) => ({ type: 'text', text: t })), ...rest])
  const trimmed = rawText.trim()
  const { question, analysis } = splitAnalysis(trimmed)
  // The bubble shows only the user's own words: the analysis is model-facing
  // context, and for the viewer it lives in the lightbox caption next to the
  // image. An image-only send (placeholder line or no text) renders as the
  // thumbnail gallery alone, with no stock text bubble beneath it.
  const own = question.trim()
  const visibleText = PLACEHOLDER_PATTERN.test(own) ? '' : own
  return {
    bridged,
    text: trimmed,
    visibleText,
    analysis: stripHintLines(analysis),
    images,
    content: visibleText === '' ? rest : [{ type: 'text', text: visibleText }, ...rest],
  }
}
