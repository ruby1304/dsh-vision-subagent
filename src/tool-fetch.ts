/**
 * The vision_image_fetch tool: materialize a pasted image's durable
 * vision-subagent:// reference into a workspace file.
 *
 * Pasted images reach the main session as opaque attachment links whose bytes
 * live in the host attachment store. That keeps the conversation lean, but
 * downstream work — pixel-level inspection, image editing, feeding the
 * original to another tool — needs the real file. This tool bridges the gap:
 * it re-reads the content-verified attachment and writes it under the session
 * workspace's .dsh-vision/ directory.
 *
 * The write goes through node:fs directly because the harness fs seam
 * (ctx.fs) exposes text writes only. Containment is structural rather than
 * policy-based: the destination directory is fixed under the session cwd and
 * the filename is derived here from the verified attachment metadata — no
 * caller-controlled path segment ever reaches the disk.
 * @module dsh-vision-subagent/tool-fetch
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ResolvedConfig } from './config.js'
import { VisionAgentError } from './errors.js'
import { decodeVisionImageReference } from './web-contract.js'

/** Structural minimum of the attachment service's read half. */
export interface ReadImageAttachmentsLike {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
}

/** Directory (under the session cwd) materialized images land in. */
export const MATERIALIZE_DIR = '.dsh-vision'

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const TOOL_DESCRIPTION = [
  'Materialize a pasted image from its durable vision-subagent:// attachment URL into a workspace file.',
  'Pasted images arrive in this conversation as [Attached image N](vision-subagent://…) links whose bytes live in the host attachment store, not on disk.',
  'Call this with a link URL to recover the original full-fidelity file under the session workspace (' + MATERIALIZE_DIR + '/), then read_image, edit, or otherwise process that path like any workspace file.',
].join(' ')

/** Filesystem-safe filename stem: basename only, no extension, no oddities. */
function fileStem(name: string | undefined): string {
  const base = (name ?? 'pasted-image').split(/[\\/]/u).filter((part) => part.length > 0).at(-1) ?? 'pasted-image'
  const stem = base.replace(/\.[a-z0-9]+$/iu, '').replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '')
  return stem === '' ? 'pasted-image' : stem
}

export function createVisionImageFetchTool(config: ResolvedConfig, attachments: ReadImageAttachmentsLike) {
  return defineTool({
    name: 'vision_image_fetch',
    description: TOOL_DESCRIPTION,
    parameters: {
      reference: {
        type: 'string',
        required: true,
        description: 'The full vision-subagent://image/v1/… URL of a pasted image, exactly as it appears in an [Attached image N](…) link.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Materialized the original image to ' + value.path + ' (' + value.bytes + ' bytes, '
          + value.width + '×' + value.height + '). Read or edit it like any workspace file; '
          + MATERIALIZE_DIR + '/ is disposable derived data.',
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!config.enabled) {
        throw new VisionAgentError('VISION_DISABLED', 'dsh-vision-subagent is disabled by configuration (enabled: false)')
      }
      const reference = (args.reference as string).trim()
      const parts = decodeVisionImageReference(reference)
      if (parts === undefined) {
        throw new VisionAgentError(
          'VISION_INVALID_REFERENCE',
          'reference is not a vision-subagent://image/v1/ URL; copy it verbatim from an [Attached image N](…) link',
        )
      }
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) {
        throw new VisionAgentError('VISION_NO_CWD', 'vision_image_fetch requires an agent session working directory')
      }

      let stored: { ref: ImageAttachmentRef; data: Uint8Array }
      try {
        stored = await attachments.readImage({
          attachmentId: parts.attachmentId as never,
          mediaType: parts.mediaType as ImageMediaType,
          bytes: parts.bytes,
          width: parts.width,
          height: parts.height,
          ...(parts.name === undefined ? {} : { name: parts.name }),
        }, exec.signal)
      } catch (error) {
        if (exec.signal.aborted) throw exec.signal.reason
        const message = error instanceof Error ? error.message : String(error)
        throw new VisionAgentError('VISION_INVALID_REFERENCE', 'the referenced image is not in the attachment store (or failed verification): ' + message)
      }
      if (exec.signal.aborted) throw exec.signal.reason

      const ext = MEDIA_EXTENSIONS[stored.ref.mediaType] ?? '.png'
      const digest = createHash('sha256').update(stored.data).digest('hex').slice(0, 8)
      const fileName = fileStem(stored.ref.name) + '-' + digest + ext
      const workspace = resolve(cwd)
      const directory = join(workspace, MATERIALIZE_DIR)
      const target = join(directory, fileName)
      if (target !== directory + sep + fileName) {
        // Unreachable by construction (fileName is generated above); kept as a
        // tripwire against future edits that let caller data into the path.
        throw new VisionAgentError('VISION_MATERIALIZE_FAILED', 'refused an unexpected materialization path')
      }
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(target, stored.data)
      } catch (error) {
        if (exec.signal.aborted) throw exec.signal.reason
        const message = error instanceof Error ? error.message : String(error)
        throw new VisionAgentError('VISION_MATERIALIZE_FAILED', 'could not write the materialized image: ' + message)
      }
      return {
        path: relative(workspace, target),
        mediaType: stored.ref.mediaType,
        bytes: stored.data.byteLength,
        width: stored.ref.width,
        height: stored.ref.height,
      }
    },
  })
}
