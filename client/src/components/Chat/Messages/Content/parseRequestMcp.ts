export function parseRequestMcpServerName(
  args: string | Record<string, unknown> | undefined,
  output?: string | null,
): string {
  const sources: Array<string | Record<string, unknown> | null | undefined> = [args, output];
  for (const source of sources) {
    if (source && typeof source === 'object' && typeof source.serverName === 'string') {
      return source.serverName;
    }
    if (typeof source !== 'string' || source.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(source) as { serverName?: unknown };
      if (typeof parsed.serverName === 'string') {
        return parsed.serverName;
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}
