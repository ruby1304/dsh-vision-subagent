/**
 * Child (vision subagent) prompt assembly. Pure module: takes plain data,
 * returns content blocks — unit-testable without any harness service.
 * @module dsh-vision-subagent/prompt
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export interface ChildPromptInput {
  /** The visual question from the main agent. */
  question: string
  /** Display names for the attached images, in order. */
  imageNames: string[]
  /** Durable attachment references, in the same order as imageNames. */
  refs: ImageAttachmentRef[]
  /** Optional extra steering appended to the rules block. */
  guidance: string
}

export const CHILD_RULES = [
  'You are a vision-analysis subagent for a text-only main agent. The main agent cannot see images, so it delegated this task to you on a separate vision-capable model route.',
  'Rules:',
  '- Answer the question directly and concisely, in the same language as the question.',
  '- Report visual facts precisely: text content (verbatim where it matters), layout, colors, values, errors, and differences between images.',
  '- If the question references other workspace files you need to see, you may use read_image or read on them; otherwise do not explore.',
  '- Do not modify any file, do not run shell commands, and do not delegate subagents.',
  '- Reply with the analysis text only: no preamble, no meta-commentary, no code fences.',
].join('\n')

/**
 * Assemble the one-shot child prompt: instructions + numbered image list +
 * the question, followed by the image blocks themselves.
 */
export function buildChildPrompt(input: ChildPromptInput): ContentBlock[] {
  const lines: string[] = [CHILD_RULES, '']
  lines.push('Attached images (numbered for reference):')
  input.imageNames.forEach((name, index) => {
    lines.push('  ' + String(index + 1) + '. ' + name)
  })
  lines.push('', 'Question to answer:', input.question)
  if (input.guidance.trim().length > 0) {
    lines.push('', 'Additional instructions:', input.guidance.trim())
  }
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const ref of input.refs) {
    blocks.push({ type: 'image', attachment: ref })
  }
  return blocks
}
