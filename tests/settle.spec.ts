import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { VisionAgentError } from '../src/errors.js'
import { extractText, settleRun } from '../src/settle.js'
import type { RunHandle } from '../src/settle.js'

function handle(output: ContentBlock[], stopReason: string, disposeImpl?: () => Promise<void>): RunHandle & { disposed: boolean } {
  return {
    disposed: false,
    result: Promise.resolve({ output, stopReason }),
    dispose: disposeImpl ?? (async () => {}),
  }
}

describe('extractText', () => {
  it('joins only text blocks', () => {
    const text = extractText([
      { type: 'text', text: 'hello ' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'world' },
    ])
    expect(text).toBe('hello world')
  })
})

describe('settleRun', () => {
  it('returns joined text for a completed run and disposes it', async () => {
    let disposed = false
    const run = handle([{ type: 'text', text: 'the button is red' }], 'completed', async () => { disposed = true })
    const settled = await settleRun(run)
    expect(settled).toEqual({ text: 'the button is red', stopReason: 'completed' })
    expect(disposed).toBe(true)
  })

  it('does not reject when dispose fails after a completed run', async () => {
    const run = handle([{ type: 'text', text: 'ok' }], 'completed', async () => { throw new Error('dispose boom') })
    await expect(settleRun(run)).resolves.toEqual({ text: 'ok', stopReason: 'completed' })
  })

  it('throws VISION_SUBAGENT_FAILED with partial text on non-completed runs', async () => {
    const run = handle([{ type: 'text', text: 'partial answer' }], 'max-tokens')
    await expect(settleRun(run)).rejects.toThrow(VisionAgentError)
    await expect(settleRun(run)).rejects.toThrow(/token limit/)
    await expect(settleRun(run)).rejects.toThrow(/partial answer/)
  })

  it('maps error, aborted, and refusal stop reasons', async () => {
    for (const [reason, pattern] of [['error', /failed/], ['aborted', /cancelled/], ['refusal', /declined/]] as const) {
      await expect(settleRun(handle([], reason))).rejects.toThrow(pattern)
    }
  })

  it('throws VISION_SUBAGENT_EMPTY when a completed run produced no text', async () => {
    await expect(settleRun(handle([], 'completed'))).rejects.toThrow(/without producing any text/)
  })
})
