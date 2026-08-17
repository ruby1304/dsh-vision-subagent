import { describe, expect, it } from 'vitest'
import { projectBridgedContent, splitAnalysis } from '../src/client/chat-render.js'
import { encodeVisionImageReference } from '../src/web-contract.js'

function ref(id: string): string {
  return encodeVisionImageReference({
    sessionId: 'session-1',
    attachmentId: id,
    mediaType: 'image/png',
    bytes: 100,
    width: 10,
    height: 20,
    name: 'shot.png',
  })
}

const linkA = '[Attached image 1](' + ref('a') + ')'
const linkB = '[Attached image 2](' + ref('b') + ')'

describe('projectBridgedContent', () => {
  it('returns bridged:false and original content for plain messages', () => {
    const content = [{ type: 'text', text: 'hello world' }]
    const projection = projectBridgedContent(content)
    expect(projection.bridged).toBe(false)
    expect(projection.images).toEqual([])
  })

  it('extracts links into images and strips link lines from text', () => {
    const text = '看看这两张图\n\n' + linkA + '\n' + linkB + '\n\n[Vision analysis]\n图1是红色'
    const projection = projectBridgedContent([{ type: 'text', text }])
    expect(projection.bridged).toBe(true)
    expect(projection.images).toHaveLength(2)
    expect(projection.images[0]?.attachment.attachmentId).toBe('a')
    expect(projection.images[1]?.attachment.attachmentId).toBe('b')
    expect(projection.text).toContain('看看这两张图')
    expect(projection.text).toContain('图1是红色')
    expect(projection.text).not.toContain('Attached image')
    expect(projection.text).not.toContain('vision-subagent://')
  })

  it('keeps non-text blocks and never matches foreign markdown links', () => {
    const foreign = '[Attached image 1](https://example.com/x.png)'
    const projection = projectBridgedContent([
      { type: 'text', text: foreign },
      { type: 'reasoning', text: 'r' } as never,
    ])
    expect(projection.bridged).toBe(false)
    expect(projection.content).toHaveLength(2)
  })
})

describe('splitAnalysis', () => {
  it('splits the question and analysis sections at the marker', () => {
    const { question, analysis } = splitAnalysis('我的问题\n\n[Vision analysis of the pasted image — x]\n分析内容')
    expect(question).toBe('我的问题')
    expect(analysis).toContain('分析内容')
  })

  it('returns empty analysis when no marker exists', () => {
    const { question, analysis } = splitAnalysis('只有问题')
    expect(question).toBe('只有问题')
    expect(analysis).toBe('')
  })
})
