import { describe, expect, it } from 'vitest'
import { pasteRouteFromCapability } from '../src/paste-route.js'

describe('pasteRouteFromCapability', () => {
  it('uses native submission in auto mode only for image-capable models', () => {
    expect(pasteRouteFromCapability('auto', true)).toBe('native')
    expect(pasteRouteFromCapability('auto', false)).toBe('delegate')
  })

  it('honors forced delegate regardless of model capability', () => {
    expect(pasteRouteFromCapability('delegate', true)).toBe('delegate')
    expect(pasteRouteFromCapability('delegate', false)).toBe('delegate')
  })

  it('honors forced native and leaves admission to DSH', () => {
    expect(pasteRouteFromCapability('native', true)).toBe('native')
    expect(pasteRouteFromCapability('native', false)).toBe('native')
  })
})
