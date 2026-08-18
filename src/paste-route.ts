/** Pure pasted-image routing policy shared by client logic and tests. */

export type PasteRoute = 'delegate' | 'native'

export function pasteRouteFromCapability(
  pasteMode: 'auto' | 'delegate' | 'native',
  acceptsImage: boolean,
): PasteRoute {
  if (pasteMode === 'native') return 'native'
  if (pasteMode === 'delegate') return 'delegate'
  return acceptsImage ? 'native' : 'delegate'
}
