import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PASTE_FALLBACK_QUESTION, buildChildPrompt, pasteAnalysisQuestion } from '../src/prompt.js'

function ref(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as never,
    mediaType: 'image/png',
    bytes: 10,
    width: 4,
    height: 4,
    name: 'shot' + id + '.png',
  }
}

describe('buildChildPrompt', () => {
  it('starts with a text block carrying rules, names, and the question', () => {
    const blocks = buildChildPrompt({
      question: 'Which of the two screenshots shows the bug?',
      imageNames: ['a.png', 'b.png'],
      refs: [ref('1'), ref('2')],
      guidance: '',
    })
    expect(blocks[0]).toEqual({ type: 'text', text: expect.any(String) })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('a.png')
    expect(text).toContain('2. b.png')
    expect(text).toContain('Which of the two screenshots shows the bug?')
    expect(text).toContain('do not delegate subagents')
  })

  it('appends one image block per ref, in order', () => {
    const blocks = buildChildPrompt({
      question: 'describe',
      imageNames: ['a.png', 'b.png'],
      refs: [ref('1'), ref('2')],
      guidance: '',
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toEqual({ type: 'image', attachment: ref('1') })
    expect(blocks[2]).toEqual({ type: 'image', attachment: ref('2') })
  })

  it('omits the guidance section when empty and includes it otherwise', () => {
    const without = buildChildPrompt({ question: 'q', imageNames: ['a.png'], refs: [ref('1')], guidance: '  ' })
    expect((without[0] as { text: string }).text).not.toContain('Additional instructions')
    const withGuidance = buildChildPrompt({ question: 'q', imageNames: ['a.png'], refs: [ref('1')], guidance: ' Count the buttons. ' })
    expect((withGuidance[0] as { text: string }).text).toContain('Additional instructions')
    expect((withGuidance[0] as { text: string }).text).toContain('Count the buttons.')
  })
})

describe('pasteAnalysisQuestion', () => {
  it('falls back to the generic description prompt when the draft is empty', () => {
    expect(pasteAnalysisQuestion('   ')).toBe(PASTE_FALLBACK_QUESTION)
  })

  it('wraps the draft as the intent behind the message', () => {
    const question = pasteAnalysisQuestion(' 看看图上这个人的穿搭 \n')
    expect(question).toContain('看看图上这个人的穿搭')
    expect(question).toContain('composing the following message')
    expect(question).toContain('in service of that message')
  })
})
