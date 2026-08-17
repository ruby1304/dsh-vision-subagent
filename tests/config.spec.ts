import { describe, expect, it } from 'vitest'
import { ConfigSchema, imageMediaTypeForPath, resolveConfig } from '../src/config.js'
import { VisionAgentError } from '../src/errors.js'

describe('ConfigSchema', () => {
  it('fills defaults for an empty object', () => {
    const config = ConfigSchema({})
    expect(config).toMatchObject({
      enabled: true,
      provider: '',
      model: '',
      subagentProvider: 'spawn',
      maxDepth: 1,
      maxImages: 4,
      maxImageBytes: 10 * 1024 * 1024,
      maxPromptChars: 8000,
      maxOutputChars: 32000,
      maxTokens: 4096,
      allowRemoteUrls: false,
      allowOutsideWorkspace: false,
      extraAllowedRoots: [],
      guidance: '',
    })
  })

  it('rejects a fractional maxDepth at schema level', () => {
    expect(() => ConfigSchema({ maxDepth: 1.5 })).toThrow()
  })

  it('accepts a full valid configuration', () => {
    const config = ConfigSchema({
      provider: 'kimi-coding',
      model: 'k3',
      maxImages: 2,
      extraAllowedRoots: ['/tmp/screenshots'],
      guidance: 'Be extra careful with numbers.',
    })
    expect(config.provider).toBe('kimi-coding')
    expect(config.maxImages).toBe(2)
    expect(config.extraAllowedRoots).toEqual(['/tmp/screenshots'])
  })
})

describe('resolveConfig', () => {
  it('rejects a half-configured route', () => {
    const base = ConfigSchema({})
    expect(() => resolveConfig({ ...base, provider: 'kimi-coding' })).toThrow(VisionAgentError)
    expect(() => resolveConfig({ ...base, model: 'k3' })).toThrow(/provider and model must be set together/)
  })

  it('trims provider and model', () => {
    const base = ConfigSchema({})
    const resolved = resolveConfig({ ...base, provider: '  minimax-cn ', model: ' MiniMax-M3	' })
    expect(resolved.provider).toBe('minimax-cn')
    expect(resolved.model).toBe('MiniMax-M3')
  })
})

describe('imageMediaTypeForPath', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(imageMediaTypeForPath('a.png')).toBe('image/png')
    expect(imageMediaTypeForPath('b.JPEG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('c.webp')).toBe('image/webp')
    expect(imageMediaTypeForPath('d.gif')).toBe('image/gif')
  })

  it('strips query and fragment', () => {
    expect(imageMediaTypeForPath('shot.png?size=2#frag')).toBe('image/png')
  })

  it('returns undefined for unsupported or extension-less paths', () => {
    expect(imageMediaTypeForPath('notes.txt')).toBeUndefined()
    expect(imageMediaTypeForPath('README')).toBeUndefined()
    expect(imageMediaTypeForPath('dir.svg/x.png')).toBe('image/png')
  })
})
