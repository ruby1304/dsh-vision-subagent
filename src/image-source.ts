/**
 * Image admission: validate inputs, contain paths to the workspace, read
 * bounded bytes, and commit durable attachments the child prompt references.
 * All service access is duck-typed so the plugin stays version-tolerant.
 * @module dsh-vision-subagent/image-source
 */

import type { ImageAttachmentRef, ImageAttachmentLimits, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { imageMediaTypeForPath } from './config.js'
import { VisionAgentError } from './errors.js'

/** Structural minimum of the harness fs service. */
export interface FsLike {
  lstat(input: string, options: { cwd: string }, signal: AbortSignal): Promise<{ type: string } | undefined>
  resolve(input: string, options: { cwd?: string; signal?: AbortSignal }): Promise<string>
  contains(ancestor: string, descendant: string): boolean
  readBytes(path: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
}

/** Structural minimum of the attachment service. */
export interface AttachmentsLike {
  imageLimits: ImageAttachmentLimits
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}

export interface PreparedImage {
  /** Display name (basename), never a full path. */
  name: string
  /** Durable content-addressed reference carried by the child prompt. */
  ref: ImageAttachmentRef
}

export interface ImageSourceConfig {
  allowRemoteUrls: boolean
  allowOutsideWorkspace: boolean
  extraAllowedRoots: string[]
  maxImageBytes: number
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value.trim())
}

/** Display name for a path or URL: basename, query and fragment stripped. */
export function displayNameOf(value: string): string {
  const clean = value.split('?')[0]?.split('#')[0] ?? value
  const parts = clean.split(/[\\/]/u).filter((part) => part.length > 0)
  return parts.at(-1) ?? 'image'
}

/** Recognize rejected scheme kinds (data:, file:) with a precise message. */
function rejectedScheme(value: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):/iu.exec(value.trim())
  if (match === null) return undefined
  const scheme = match[1]?.toLowerCase()
  if (scheme === 'data' || scheme === 'file') return scheme
  return undefined
}

function signalAborted(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true
  const code = (error as { code?: unknown } | null)?.code
  return code === 'FS_ABORTED'
}

/**
 * Admit one local image and commit its durable attachment. Order matters:
 * every gate runs before bytes are read, so refusals never leak partial
 * reads or attachment writes.
 */
export async function prepareImage(
  services: { fs: FsLike; attachments: AttachmentsLike },
  exec: Pick<ToolRunContext, 'agent' | 'signal'>,
  input: string,
  config: ImageSourceConfig,
): Promise<PreparedImage> {
  if (exec.signal.aborted) throw exec.signal.reason

  const rejected = rejectedScheme(input)
  if (rejected !== undefined) {
    throw new VisionAgentError('VISION_INVALID_ARGUMENT', rejected + ': URLs are not accepted as image arguments; pass a local file path')
  }
  if (isHttpUrl(input)) {
    if (!config.allowRemoteUrls) {
      throw new VisionAgentError('VISION_REMOTE_URL_DISABLED', 'remote image URLs are disabled by configuration (allowRemoteUrls)')
    }
    throw new VisionAgentError('VISION_REMOTE_URL_UNSUPPORTED', 'remote image URLs are not supported yet in dsh-vision-subagent v0.1; download the image to the workspace and pass its local path')
  }

  const mediaType = imageMediaTypeForPath(input)
  if (mediaType === undefined) {
    throw new VisionAgentError('VISION_UNSUPPORTED_MEDIA', 'unsupported image path extension; accepted: PNG/JPEG/WebP/GIF')
  }
  if (!services.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new VisionAgentError('VISION_UNSUPPORTED_MEDIA', mediaType + ' images are not accepted by this deployment')
  }

  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) {
    throw new VisionAgentError('VISION_NO_CWD', 'a local image path requires an agent session working directory')
  }

  try {
    const pathInfo = await services.fs.lstat(input, { cwd }, exec.signal)
    if (exec.signal.aborted) throw exec.signal.reason
    if (pathInfo === undefined) {
      throw new VisionAgentError('VISION_PATH_MISSING', 'local image path does not exist: ' + input)
    }
    if (pathInfo.type === 'symlink') {
      throw new VisionAgentError('VISION_SYMLINK_REJECTED', 'the final local image path must not be a symbolic link: ' + input)
    }

    const [target, workspace] = await Promise.all([
      services.fs.resolve(input, { cwd, signal: exec.signal }),
      services.fs.resolve(cwd, { signal: exec.signal }),
    ])
    if (exec.signal.aborted) throw exec.signal.reason

    if (!config.allowOutsideWorkspace) {
      let allowed = services.fs.contains(workspace, target)
      for (const root of config.extraAllowedRoots) {
        if (allowed) break
        const resolvedRoot = await services.fs.resolve(root, { signal: exec.signal })
        if (exec.signal.aborted) throw exec.signal.reason
        allowed = services.fs.contains(resolvedRoot, target)
      }
      if (!allowed) {
        throw new VisionAgentError('VISION_PATH_OUTSIDE_WORKSPACE', 'local image is outside the allowed workspace roots: ' + input)
      }
    }

    const cap = Math.min(config.maxImageBytes, services.attachments.imageLimits.maxImageBytes, services.attachments.imageLimits.maxMessageImageBytes)
    const data = await services.fs.readBytes(target, exec.signal, cap)
    if (exec.signal.aborted) throw exec.signal.reason

    const ref = await services.attachments.saveImage({
      data,
      mediaType,
      name: displayNameOf(input),
    })
    if (exec.signal.aborted) throw exec.signal.reason
    return { name: displayNameOf(input), ref }
  } catch (error) {
    if (signalAborted(exec.signal, error)) throw exec.signal.reason
    if (error instanceof VisionAgentError) throw error
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'FS_TOO_LARGE') {
      throw new VisionAgentError('VISION_IMAGE_TOO_LARGE', 'image exceeds the configured byte limit')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new VisionAgentError('VISION_IMAGE_READ_FAILED', 'local image could not be read: ' + message)
  }
}
