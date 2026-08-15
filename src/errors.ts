/**
 * Typed plugin errors with stable machine-readable codes. The tool layer
 * surfaces these as tool failures; the message is model- and user-visible,
 * so every message must name what to fix, never secrets.
 * @module dsh-vision-subagent/errors
 */

export const VISION_ERROR_CODES = [
  'VISION_DISABLED',
  'VISION_NOT_CONFIGURED',
  'VISION_NO_AGENT',
  'VISION_NO_CWD',
  'VISION_SUBAGENT_PROVIDER_MISSING',
  'VISION_MODEL_NOT_VISION',
  'VISION_MODEL_UNRESOLVED',
  'VISION_INVALID_ARGUMENT',
  'VISION_REMOTE_URL_DISABLED',
  'VISION_REMOTE_URL_UNSUPPORTED',
  'VISION_UNSUPPORTED_MEDIA',
  'VISION_ATTACHMENTS_UNAVAILABLE',
  'VISION_IMAGE_TOO_LARGE',
  'VISION_PATH_MISSING',
  'VISION_PATH_OUTSIDE_WORKSPACE',
  'VISION_SYMLINK_REJECTED',
  'VISION_IMAGE_READ_FAILED',
  'VISION_SUBAGENT_FAILED',
  'VISION_SUBAGENT_EMPTY',
] as const

export type VisionErrorCode = (typeof VISION_ERROR_CODES)[number]

export class VisionAgentError extends Error {
  readonly code: VisionErrorCode

  constructor(code: VisionErrorCode, message: string) {
    super(message)
    this.name = 'VisionAgentError'
    this.code = code
  }
}
