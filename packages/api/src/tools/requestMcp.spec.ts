import { Tools } from 'librechat-data-provider';
import { createRequestMcpTool, resolveRequestableMcpServers } from './requestMcp';

describe('request_mcp', () => {
  it('omits selected and inaccessible servers', () => {
    const servers = resolveRequestableMcpServers({
      mcpConfig: {
        formbricks: { chatMenu: true },
        dataforseo: { chatMenu: true },
        hidden: { chatMenu: false },
      },
      selectedServers: ['dataforseo'],
      user: { id: 'u1', mcpAccess: { policy: 'allowlist', servers: ['formbricks', 'dataforseo'] } },
    });
    expect(servers).toEqual(['formbricks']);
  });

  it('rejects unknown server names', async () => {
    const tool = createRequestMcpTool({ availableServers: ['formbricks'] });
    await expect(tool.invoke({ serverName: 'listmonk' })).rejects.toThrow();
  });

  it('returns enable payload for a valid server', async () => {
    const tool = createRequestMcpTool({ availableServers: ['formbricks'] });
    const result = await tool.invoke({ serverName: 'formbricks', reason: 'surveys' });
    expect(JSON.parse(result as string)).toEqual({
      type: Tools.request_mcp,
      serverName: 'formbricks',
      reason: 'surveys',
    });
  });
});
