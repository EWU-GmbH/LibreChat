import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';

import { ephemeralAgentByConvoId, useApplyNewAgentTemplate } from '../agents';

const mockRemoveTimestampedValue = jest.fn();
jest.mock('~/utils', () => ({
  removeTimestampedValue: (...args: string[]) => mockRemoveTimestampedValue(...args),
  logger: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

const useAgentTemplateHarness = (conversationId: string) => {
  const applyTemplate = useApplyNewAgentTemplate();
  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
  const newChatAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
  return { applyTemplate, ephemeralAgent, newChatAgent };
};

describe('useApplyNewAgentTemplate', () => {
  it('applies an explicit ephemeral agent when optimistic hydration makes source and target match', async () => {
    const conversationId = 'convo-123';
    const agent = {
      mcp: ['chrome-devtools'],
      skills: true,
      artifacts: 'default',
      web_search: true,
      file_search: true,
      execute_code: true,
    };
    const { result } = renderHook(() => useAgentTemplateHarness(conversationId), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.applyTemplate(conversationId, conversationId, agent);
    });

    await waitFor(() => {
      expect(result.current.ephemeralAgent).toEqual(agent);
    });
  });

  it('keeps PII protection on the created conversation but resets the next chat', async () => {
    const agent = { mcp: ['dataforseo'], pii_protection: true };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RecoilRoot
        initializeState={({ set }) => set(ephemeralAgentByConvoId(Constants.NEW_CONVO), agent)}
      >
        {children}
      </RecoilRoot>
    );
    const { result } = renderHook(() => useAgentTemplateHarness('convo-created'), { wrapper });

    await act(async () => {
      await result.current.applyTemplate('convo-created');
    });

    await waitFor(() => {
      expect(result.current.ephemeralAgent).toEqual(agent);
      expect(result.current.newChatAgent).toEqual({ mcp: ['dataforseo'] });
    });
    expect(mockRemoveTimestampedValue).toHaveBeenCalledWith(
      `${LocalStorageKeys.LAST_PII_PROTECTION_TOGGLE_}${Constants.NEW_CONVO}`,
    );
  });
});
