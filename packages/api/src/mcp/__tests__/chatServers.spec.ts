import { isChatSelectableMcpServer, listChatSelectableMcpServers } from '../chatServers';

describe('chat selectable MCP servers', () => {
  it('excludes consumeOnly and chatMenu false', () => {
    expect(isChatSelectableMcpServer({ chatMenu: true })).toBe(true);
    expect(isChatSelectableMcpServer({ chatMenu: false })).toBe(false);
    expect(isChatSelectableMcpServer({ consumeOnly: true })).toBe(false);
  });

  it('lists only selectable servers', () => {
    expect(
      listChatSelectableMcpServers({
        formbricks: { chatMenu: true },
        hidden: { chatMenu: false },
        agentOnly: { consumeOnly: true },
      }),
    ).toEqual(['formbricks']);
  });
});
