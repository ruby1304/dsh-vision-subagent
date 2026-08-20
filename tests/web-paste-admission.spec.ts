import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { admitPastedImages } from '../src/web-paste.js'

const limits: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 4096,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function ref(input: SaveImageAttachment, index: number): ImageAttachmentRef {
  return {
    attachmentId: (`sha256:${String(index).padStart(64, 'a')}`) as ImageAttachmentRef['attachmentId'],
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...(input.name === undefined ? {} : { name: input.name }),
  }
}

function store(saveImages: (inputs: readonly SaveImageAttachment[]) => Promise<readonly ImageAttachmentRef[]>): AttachmentStore {
  return { imageLimits: limits, saveImages } as unknown as AttachmentStore
}

describe('delegated paste batch admission', () => {
  it('normalizes names and submits the complete ordered batch once', async () => {
    const saveImages = vi.fn(async (inputs: readonly SaveImageAttachment[]) => inputs.map(ref))
    const admitted = await admitPastedImages(store(saveImages), [
      { name: '/private/tmp/first.png', mediaType: 'image/png', data: Buffer.from('one').toString('base64') },
      { name: 'folder\\second.jpg', mediaType: 'image/jpeg', data: Buffer.from('two').toString('base64') },
    ], 1024)

    expect(saveImages).toHaveBeenCalledTimes(1)
    expect(saveImages.mock.calls[0]?.[0].map(input => input.name)).toEqual(['first.png', 'second.jpg'])
    expect(admitted.names).toEqual(['first.png', 'second.jpg'])
    expect(admitted.refs.map(item => item.bytes)).toEqual([3, 3])
  })

  it('rejects non-canonical base64 before starting batch storage', async () => {
    const saveImages = vi.fn(async () => [])
    await expect(admitPastedImages(store(saveImages), [
      { name: 'bad.png', mediaType: 'image/png', data: 'Zg' },
    ], 1024)).rejects.toThrow('canonical base64')
    expect(saveImages).not.toHaveBeenCalled()
  })
})
