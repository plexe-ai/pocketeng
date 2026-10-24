export type DesktopPlatform = 'macos' | 'windows'

export function desktopPlatformFromNodePlatform(
  platform: NodeJS.Platform,
): DesktopPlatform | null {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return null
}
