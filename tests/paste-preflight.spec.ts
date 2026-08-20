import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePasteRoute, resolvePasteRouteWithTimeout } from '../src/paste-preflight.js'
import type { PasteRouteConnection } from '../src/paste-preflight.js'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function connection(models: PasteRouteConnection['api']['sessions']['models']): PasteRouteConnection {
  return { api: { sessions: { models } } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('resolvePasteRoute', () => {
  it('honors forced native before consulting the session model directory', async () => {
    const models = vi.fn(async () => {
      throw new Error('sessions.models must not run in forced mode')
    })
    const fetcher = vi.fn(async () => jsonResponse({
      ok: true,
      pasteMode: 'native',
      acceptsImage: true,
    })) as unknown as typeof fetch

    await expect(resolvePasteRoute(
      'session-1',
      connection(models),
      fetcher,
      new AbortController().signal,
    )).resolves.toBe('native')
    expect(models).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('honors forced delegate before consulting the session model directory', async () => {
    const models = vi.fn(async () => {
      throw new Error('sessions.models must not run in forced mode')
    })
    const fetcher = vi.fn(async () => jsonResponse({
      ok: true,
      pasteMode: 'delegate',
      acceptsImage: false,
    })) as unknown as typeof fetch

    await expect(resolvePasteRoute(
      'session-1',
      connection(models),
      fetcher,
      new AbortController().signal,
    )).resolves.toBe('delegate')
    expect(models).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('looks up the exact current model only when auto mode requests it', async () => {
    const models = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: { current: { provider: 'main-provider', model: 'multimodal' } },
      },
    }))
    const bodies: unknown[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1
        ? jsonResponse({ ok: true, pasteMode: 'auto', requiresModel: true })
        : jsonResponse({ ok: true, pasteMode: 'auto', acceptsImage: true })
    }) as unknown as typeof fetch

    await expect(resolvePasteRoute(
      'session-1',
      connection(models),
      fetcher,
      new AbortController().signal,
    )).resolves.toBe('native')
    expect(models).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(bodies).toEqual([
      {},
      { provider: 'main-provider', model: 'multimodal' },
    ])
  })
})

describe('resolvePasteRouteWithTimeout', () => {
  it('bounds a hanging sessions.models RPC and aborts only the preflight signal', async () => {
    vi.useFakeTimers()
    const models = vi.fn(() => new Promise<never>(() => {}))
    let preflightSignal: AbortSignal | undefined
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      preflightSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return jsonResponse({ ok: true, pasteMode: 'auto', requiresModel: true })
    }) as unknown as typeof fetch

    const pending = resolvePasteRouteWithTimeout(
      'session-1',
      connection(models),
      fetcher,
      25,
    )
    const rejected = expect(pending).rejects.toThrow('capability preflight timed out')
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(preflightSignal?.aborted).toBe(true)

    // The caller's later analysis scope is independent of the expired one.
    const analysisController = new AbortController()
    expect(analysisController.signal.aborted).toBe(false)
  })

  it('propagates caller cancellation while a model-directory RPC is hanging', async () => {
    const models = vi.fn(() => new Promise<never>(() => {}))
    let preflightSignal: AbortSignal | undefined
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      preflightSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return jsonResponse({ ok: true, pasteMode: 'auto', requiresModel: true })
    }) as unknown as typeof fetch
    const caller = new AbortController()
    const cancelled = new Error('composer submit cancelled')

    const pending = resolvePasteRouteWithTimeout(
      'session-1',
      connection(models),
      fetcher,
      10_000,
      caller.signal,
    )
    caller.abort(cancelled)

    await expect(pending).rejects.toBe(cancelled)
    expect(preflightSignal?.aborted).toBe(true)
  })
})
