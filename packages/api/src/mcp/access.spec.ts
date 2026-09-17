import { SystemRoles } from 'librechat-data-provider';
import { canAccessMCPServer, filterMCPServersForUser } from './access';

describe('per-user MCP access', () => {
  const servers = {
    dataforseo: { url: 'https://data.example' },
    formbricks: { url: 'https://forms.example' },
    listmonk: { url: 'https://list.example' },
  };

  it('keeps all servers for existing users without a stored policy', () => {
    expect(filterMCPServersForUser(servers, { role: 'user' })).toEqual(servers);
  });

  it('removes forbidden servers from runtime resolution', () => {
    const result = filterMCPServersForUser(servers, {
      role: 'user',
      mcpAccess: { policy: 'allowlist', servers: ['formbricks'] },
    });

    expect(result).toEqual({ formbricks: servers.formbricks });
    expect(
      canAccessMCPServer({ mcpAccess: { policy: 'allowlist', servers: [] } }, 'listmonk'),
    ).toBe(false);
  });

  it('allows administrators to use every configured server', () => {
    const user = {
      role: SystemRoles.ADMIN,
      mcpAccess: { policy: 'allowlist' as const, servers: [] },
    };

    expect(filterMCPServersForUser(servers, user)).toEqual(servers);
    expect(canAccessMCPServer(user, 'dataforseo')).toBe(true);
  });
});
