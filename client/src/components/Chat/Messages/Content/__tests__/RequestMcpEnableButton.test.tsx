import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatContext } from '~/Providers/ChatContext';
import RequestMcpEnableButton from '../RequestMcpEnableButton';

const mockInitializeServer = jest.fn();
const mockRegenerate = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: { 0?: string }) =>
    key === 'com_ui_mcp_enable_server' ? `Enable ${params?.[0]} MCP` : key,
}));

jest.mock('~/Providers/BadgeRowContext', () => ({
  useBadgeRowContext: () => ({
    mcpServerManager: {
      mcpValues: [] as string[],
      initializeServer: mockInitializeServer,
    },
  }),
}));

describe('RequestMcpEnableButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitializeServer.mockResolvedValue({ success: true });
  });

  it('enables the MCP and resubmits the last user turn', async () => {
    const user = userEvent.setup();
    const chat = {
      conversation: { conversationId: 'convo-1' },
      latestMessageId: 'assistant-1',
      getMessages: () => [
        {
          messageId: 'user-1',
          parentMessageId: 'root',
          isCreatedByUser: true,
          text: 'Start the survey',
        },
        {
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          text: 'Please enable Formbricks',
        },
      ],
      regenerate: mockRegenerate,
    };

    render(
      <RecoilRoot>
        <ChatContext.Provider value={chat as never}>
          <RequestMcpEnableButton args={{ serverName: 'formbricks' }} />
        </ChatContext.Provider>
      </RecoilRoot>,
    );

    await user.click(screen.getByRole('button', { name: /Enable formbricks MCP/i }));

    await waitFor(() => {
      expect(mockInitializeServer).toHaveBeenCalledWith('formbricks');
      expect(mockRegenerate).toHaveBeenCalledWith({
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
      });
    });
  });

  it('waits for OAuth before resubmitting', async () => {
    mockInitializeServer.mockResolvedValue({ success: true, oauthRequired: true });
    const user = userEvent.setup();
    const chat = {
      conversation: { conversationId: 'convo-1' },
      latestMessageId: 'assistant-1',
      getMessages: () => [
        { messageId: 'user-1', parentMessageId: 'root', isCreatedByUser: true },
        { messageId: 'assistant-1', parentMessageId: 'user-1', isCreatedByUser: false },
      ],
      regenerate: mockRegenerate,
    };

    render(
      <RecoilRoot>
        <ChatContext.Provider value={chat as never}>
          <RequestMcpEnableButton args={{ serverName: 'canva' }} />
        </ChatContext.Provider>
      </RecoilRoot>,
    );

    await user.click(screen.getByRole('button', { name: /Enable canva MCP/i }));

    await waitFor(() => {
      expect(mockInitializeServer).toHaveBeenCalledWith('canva');
    });
    expect(mockRegenerate).not.toHaveBeenCalled();
  });
});
