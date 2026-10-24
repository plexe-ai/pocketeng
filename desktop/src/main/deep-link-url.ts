export function extractDeepLinkFromArgv(
  argv: readonly string[],
  scheme: string,
): string | null {
  const prefix = `${scheme}://`
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg
  }
  return null
}
