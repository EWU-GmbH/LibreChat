import { SystemRoles } from 'librechat-data-provider';
import type { UserMCPAccess } from 'librechat-data-provider';

export type MCPAccessUser = {
  role?: string;
  mcpAccess?: UserMCPAccess;
};

export function canAccessMCPServer(user: MCPAccessUser | undefined, serverName: string): boolean {
  if (user?.role === SystemRoles.ADMIN) {
    return true;
  }

  const access = user?.mcpAccess;
  if (!access || access.policy === 'all') {
    return true;
  }

  return access.servers.includes(serverName);
}

export function filterMCPServersForUser<T>(
  servers: Record<string, T>,
  user?: MCPAccessUser,
): Record<string, T> {
  if (user?.role === SystemRoles.ADMIN || !user?.mcpAccess || user.mcpAccess.policy === 'all') {
    return servers;
  }

  const allowed = new Set(user.mcpAccess.servers);
  return Object.fromEntries(Object.entries(servers).filter(([name]) => allowed.has(name)));
}
