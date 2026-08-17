import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVisionImageFetchTool } from '../src/tool-fetch.js'
import { encodeVisionImageReference } from '../src/web-contract.js'
import type { ResolvedConfig } from '../src/config.js'

const CONFIG = { enabled: true } as ResolvedConfig

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5])

function makeAttachments() {
  const calls: unknown[] = []
  return {
    calls,
    async readImage(ref: unknown) {
      calls.push(ref)
      return {
        ref: { ...(ref as object), name: 'shot.png' } as never,
        data: IMAGE_BYTES,
      }
    },
  }
}

function makeExec(cwd: string) {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
  } as never
}

interface FetchResult {
  path: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

function reference(overrides: Record<string, unknown> = {}): string {
  return encodeVisionImageReference({
    sessionId: 'session-1',
    attachmentId: 'abc123',
    mediaType: 'image/png',
    bytes: IMAGE_BYTES.byteLength,
    width: 10,
    height: 20,
    name: 'shot.png',
    ...overrides,
  } as never)
}

describe('vision_image_fetch', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'vsa-fetch-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('materializes the verified attachment bytes into .dsh-vision/', async () => {
    const attachments = makeAttachments()
    const tool = createVisionImageFetchTool(CONFIG, attachments)
    const result = (await tool.execute({ reference: reference() }, makeExec(cwd))) as FetchResult
    expect(result.path).toMatch(/^\.dsh-vision\/shot-[0-9a-f]{8}\.png$/)
    const onDisk = await readFile(join(cwd, result.path))
    expect(new Uint8Array(onDisk)).toEqual(IMAGE_BYTES)
    expect(result.mediaType).toBe('image/png')
    expect(result.width).toBe(10)
    expect(result.height).toBe(20)
  })

  it('deduplicates re-fetches of the same content to the same path', async () => {
    const attachments = makeAttachments()
    const tool = createVisionImageFetchTool(CONFIG, attachments)
    const first = (await tool.execute({ reference: reference() }, makeExec(cwd))) as FetchResult
    // The store's verified metadata (not the URL's name claim) names the file,
    // so the same bytes always land on the same path.
    const second = (await tool.execute({ reference: reference({ name: 'renamed.png' }) }, makeExec(cwd))) as FetchResult
    expect(second.path).toBe(first.path)
  })

  it('rejects malformed and foreign references before any store read', async () => {
    const attachments = makeAttachments()
    const tool = createVisionImageFetchTool(CONFIG, attachments)
    await expect(tool.execute({ reference: 'https://example.com/x.png' }, makeExec(cwd)))
      .rejects.toThrow(/not a vision-subagent/)
    await expect(tool.execute({ reference: 'vision-subagent://image/v9/x/y?media=image%2Fpng' }, makeExec(cwd)))
      .rejects.toThrow(/not a vision-subagent/)
    expect(attachments.calls).toHaveLength(0)
  })

  it('refuses when the plugin is disabled', async () => {
    const tool = createVisionImageFetchTool({ enabled: false } as ResolvedConfig, makeAttachments())
    await expect(tool.execute({ reference: reference() }, makeExec(cwd))).rejects.toThrow(/disabled/)
  })
})
