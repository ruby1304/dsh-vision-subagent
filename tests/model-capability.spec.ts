import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema, resolveConfig } from '../src/config.js'
import { resolveModelCapability } from '../src/web-paste.js'

function config(overrides: Record<string, unknown> = {}) {
  return resolveConfig(ConfigSchema({
    provider: 'vision-provider',
    model: 'vision-model',
    ...overrides,
  }))
}

describe('resolveModelCapability', () => {
  it('makes disabled and forced modes independent of model resolution', async () => {
    const resolveModelInfo = vi.fn(async () => {
      throw new Error('resolver must not be called')
    })
    const resolver = { resolveModelInfo }

    await expect(resolveModelCapability(resolver, config({ enabled: false }))).resolves.toEqual({
      pasteMode: 'native',
      acceptsImage: true,
    })
    await expect(resolveModelCapability(resolver, config({ pasteMode: 'native' }))).resolves.toEqual({
      pasteMode: 'native',
      acceptsImage: true,
    })
    await expect(resolveModelCapability(resolver, config({ pasteMode: 'delegate' }))).resolves.toEqual({
      pasteMode: 'delegate',
      acceptsImage: false,
    })
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('asks for a concrete route before resolving auto mode', async () => {
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['image'] }))
    await expect(resolveModelCapability({ resolveModelInfo }, config())).resolves.toEqual({
      pasteMode: 'auto',
      requiresModel: true,
    })
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('resolves image support only for auto mode with an exact route', async () => {
    const resolveModelInfo = vi.fn(async (_provider: string, model: string) => ({
      inputModalities: model === 'multimodal' ? ['text', 'image'] : ['text'],
    }))
    const resolver = { resolveModelInfo }

    await expect(resolveModelCapability(resolver, config(), {
      provider: 'main',
      model: 'multimodal',
    })).resolves.toEqual({ pasteMode: 'auto', acceptsImage: true })
    await expect(resolveModelCapability(resolver, config(), {
      provider: 'main',
      model: 'text-only',
    })).resolves.toEqual({ pasteMode: 'auto', acceptsImage: false })
    expect(resolveModelInfo).toHaveBeenNthCalledWith(1, 'main', 'multimodal')
    expect(resolveModelInfo).toHaveBeenNthCalledWith(2, 'main', 'text-only')
  })
})
