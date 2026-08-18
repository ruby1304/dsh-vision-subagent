/**
 * Browser-side paste capability preflight, kept separate from the React
 * client so its routing and timeout contract can be tested in isolation.
 * @module dsh-vision-subagent/paste-preflight
 */

import { WEB_CAPABILITY_ENDPOINT } from './web-contract.js'
import { pasteRouteFromCapability } from './paste-route.js'
import type { PasteRoute } from './paste-route.js'

export interface PasteRouteConnection {
  readonly api: {
    readonly sessions: {
      models(input: { sessionId: string }): Promise<{
        result:
          | { ok: true; value: { current: { provider: string; model: string } } }
          | { ok: false; error: { code: string; message: string } }
      }>
    }
  }
}

type CapabilityReady = {
  ok: true
  pasteMode: 'auto' | 'delegate' | 'native'
  acceptsImage: boolean
}

type CapabilityNeedsModel = {
  ok: true
  pasteMode: 'auto'
  requiresModel: true
}

type CapabilityResponse =
  | CapabilityReady
  | CapabilityNeedsModel
  | { ok: false; error: { code: string; message: string } }

async function requestCapability(
  fetcher: typeof fetch,
  signal: AbortSignal,
  route?: { provider: string; model: string },
): Promise<CapabilityReady | CapabilityNeedsModel> {
  const response = await fetcher(WEB_CAPABILITY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(route ?? {}),
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  })
  const text = await response.text()
  let payload: CapabilityResponse
  try {
    payload = JSON.parse(text) as CapabilityResponse
  } catch {
    throw new Error('capability endpoint returned invalid JSON')
  }
  if (!response.ok || payload.ok !== true) {
    const detail = payload.ok === false ? payload.error.code + ': ' + payload.error.message : 'HTTP ' + response.status
    throw new Error('model capability unavailable (' + detail + ')')
  }
  if (payload.pasteMode === 'auto' && 'requiresModel' in payload) return payload
  if (typeof payload.acceptsImage !== 'boolean') {
    throw new Error('capability endpoint returned an invalid decision')
  }
  return payload
}

/**
 * Resolve the effective route. Forced policies are returned by the host on
 * the first request, before the client asks DSH for the current model. Only
 * auto mode performs the sessions.models RPC and a model capability lookup.
 */
export async function resolvePasteRoute(
  sessionId: string,
  connection: PasteRouteConnection,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<PasteRoute> {
  const policy = await requestCapability(fetcher, signal)
  if (policy.pasteMode !== 'auto') {
    return pasteRouteFromCapability(policy.pasteMode, policy.acceptsImage)
  }
  if (!('requiresModel' in policy)) {
    return pasteRouteFromCapability(policy.pasteMode, policy.acceptsImage)
  }

  const directory = await connection.api.sessions.models({ sessionId })
  if (!directory.result.ok) {
    throw new Error('model directory unavailable (' + directory.result.error.code + '): ' + directory.result.error.message)
  }
  const { provider, model } = directory.result.value.current
  const capability = await requestCapability(fetcher, signal, { provider, model })
  if ('requiresModel' in capability) {
    throw new Error('capability endpoint requested a model after one was supplied')
  }
  return pasteRouteFromCapability(capability.pasteMode, capability.acceptsImage)
}

/**
 * Bound the complete preflight, including an RPC that currently has no
 * AbortSignal parameter. The late RPC continuation inherits an aborted
 * signal, while the caller is free to create a fresh analysis controller.
 */
export async function resolvePasteRouteWithTimeout(
  sessionId: string,
  connection: PasteRouteConnection,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<PasteRoute> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort('vision paste capability preflight timed out')
      reject(new Error('vision paste capability preflight timed out'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      resolvePasteRoute(sessionId, connection, fetcher, controller.signal),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
