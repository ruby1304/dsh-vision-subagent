import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubDocument(): void {
  const element = () => ({
    append: vi.fn(),
    classList: { add: vi.fn() },
    className: '',
    remove: vi.fn(),
    style: { display: '' },
    textContent: '',
  })
  vi.stubGlobal('document', {
    body: { appendChild: vi.fn() },
    createElement: element,
    head: { appendChild: vi.fn() },
  })
}

function harness(outcome: { kind: 'success' | 'error'; text?: string }) {
  const calls: unknown[][] = []
  const released: unknown[][] = []
  const attachment = {
    id: 'draft-1',
    previewUrl: 'blob:draft-1',
    file: {
      name: 'screen.png',
      type: 'image/png',
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as File,
  }
  const conversation = {
    async sendSession(...args: unknown[]) {
      calls.push(args)
      return outcome
    },
    draftImages: () => [attachment],
    releaseDraftImages: (items: readonly unknown[]) => released.push([...items]),
  }
  const connection = {
    api: { sessions: { models: vi.fn() } },
  }
  const context = {
    effect: vi.fn(),
    get(name: string): unknown {
      if (name === 'conversation') return conversation
      if (name === 'connection') return connection
      return undefined
    },
  }
  return { calls, connection, context, conversation, released }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('rc.8 sendSession transaction', () => {
  it('forwards the signal and native SubmitOutcome without touching drafts', async () => {
    const state = harness({ kind: 'success' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      ok: true,
      pasteMode: 'native',
      acceptsImage: true,
    })))
    const dispose = apply(state.context as never)
    const controller = new AbortController()

    const outcome = await state.conversation.sendSession(
      { sessionId: 'session-1' },
      'inspect this',
      ['draft-1'],
      'normal',
      controller.signal,
    )

    expect(outcome).toEqual({ kind: 'success' })
    expect(state.calls).toEqual([[
      { sessionId: 'session-1' },
      'inspect this',
      ['draft-1'],
      'normal',
      controller.signal,
    ]])
    expect(state.released).toEqual([])
    dispose()
  })

  it.each([
    [{ kind: 'success' } as const, 1],
    [{ kind: 'error', text: 'Host rejected the turn' } as const, 0],
  ])('releases delegated drafts only after successful Host admission', async (submitOutcome, releaseCount) => {
    const state = harness(submitOutcome)
    stubDocument()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        pasteMode: 'delegate',
        acceptsImage: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        text: 'A blue status panel.',
        provider: 'vision-provider',
        model: 'vision-model',
        image_count: 1,
        references: ['opaque-ref-1'],
      })))
    const dispose = apply(state.context as never)
    const controller = new AbortController()

    const outcome = await state.conversation.sendSession(
      { sessionId: 'session-1' },
      'inspect this',
      ['draft-1'],
      'normal',
      controller.signal,
    )

    expect(outcome).toEqual(submitOutcome)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.[2]).toEqual([])
    expect(state.calls[0]?.[4]).toBe(controller.signal)
    expect(state.released).toHaveLength(releaseCount)
    dispose()
  })
})
