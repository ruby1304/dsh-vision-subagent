/**
 * Settle a one-shot subagent run: map stop reasons to typed errors and
 * extract the child's final text. Structural over the run handle, so it
 * stays version-tolerant.
 * @module dsh-vision-subagent/settle
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { VisionAgentError } from './errors.js'

/** Structural minimum of SubagentRun — never an instanceof target. */
export interface RunHandle {
  readonly result: Promise<{
    readonly output: ContentBlock[]
    readonly stopReason: string
  }>
  dispose(): Promise<void>
}

export interface SettledRun {
  text: string
  stopReason: string
}

function stopReasonLabel(stopReason: string): string {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'cancelled'
    case 'error': return 'failed'
    case 'max-tokens': return 'hit its token limit before finishing'
    case 'refusal': return 'declined the task'
    default: return 'ended abnormally (' + stopReason + ')'
  }
}

export function extractText(output: ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Await the child result, dispose the run best-effort, and map terminal
 * states. A non-completed stop reason throws, preserving any partial text.
 */
export async function settleRun(run: RunHandle): Promise<SettledRun> {
  const result = await run.result
  try {
    await run.dispose()
  } catch {
    // Quiescence is best-effort; the result is already terminal.
  }
  const text = extractText(result.output)
  if (result.stopReason !== 'completed') {
    const headline = 'vision subagent ' + stopReasonLabel(result.stopReason)
    const partial = text.length === 0
      ? ''
      : '\nPartial output before the run ended:\n' + text
    throw new VisionAgentError('VISION_SUBAGENT_FAILED', headline + partial)
  }
  if (text.trim().length === 0) {
    throw new VisionAgentError('VISION_SUBAGENT_EMPTY', 'vision subagent finished without producing any text')
  }
  return { text, stopReason: result.stopReason }
}
