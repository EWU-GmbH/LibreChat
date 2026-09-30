import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  getAppendParentMessageId,
  hasPendingAssistantParent,
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
  getRegenerateTargetResponseMessage,
} from '../useChatFunctions';

const userMessage = (messageId: string, parentMessageId = '00000000-0000-0000-0000-000000000000') =>
  ({
    messageId,
    parentMessageId,
    isCreatedByUser: true,
    sender: 'User',
    text: messageId,
  }) as TMessage;

const assistantMessage = (messageId: string, parentMessageId: string) =>
  ({
    messageId,
    parentMessageId,
    isCreatedByUser: false,
    sender: 'Assistant',
    text: messageId,
  }) as TMessage;

describe('regenerate response targeting', () => {
  it('uses the clicked assistant response instead of the conversation tail', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];

    const targetResponse = getRegenerateTargetResponseMessage({
      messages,
      parentMessageId: 'user-1',
      targetResponseMessageId: 'assistant-1',
      latestMessage: messages[5],
    });

    expect(targetResponse?.messageId).toBe('assistant-1');
    expect(getPreliminaryRegenerateResponseMessageId(targetResponse?.messageId)).toBe(
      'assistant-1_',
    );
  });

  it('only falls back to latestMessage when it belongs to the regenerated user turn', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
    ];

    expect(
      getRegenerateTargetResponseMessage({
        messages,
        parentMessageId: 'user-1',
        latestMessage: messages[3],
      })?.messageId,
    ).toBe('assistant-1');

    expect(
      getRegenerateTargetResponseMessage({
        messages,
        parentMessageId: 'user-2',
        latestMessage: messages[3],
      })?.messageId,
    ).toBe('assistant-2');
  });

  it('truncates regenerate history before the targeted assistant response', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];

    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[1],
        initialResponseId: 'assistant-1_',
      }).map((message) => message.messageId),
    ).toEqual(['user-1']);
  });

  it('keeps unrelated sibling branches when regenerating (no flat-array drop)', () => {
    // user-1 has two responses: the original chain (assistant-1 -> ... ) and a
    // regenerated sibling (assistant-1b) that sits LATER in the flat array.
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      assistantMessage('assistant-1b', 'user-1'),
    ];

    // Regenerating the latest response on the original branch must drop only
    // that response, NOT the unrelated assistant-1b branch.
    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[3],
        initialResponseId: 'assistant-2_',
      })
        .map((message) => message.messageId)
        .sort(),
    ).toEqual(['assistant-1', 'assistant-1b', 'user-1', 'user-2']);

    // Regenerating an earlier response drops its subtree (user-2, assistant-2)
    // but still keeps the unrelated assistant-1b branch.
    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[1],
        initialResponseId: 'assistant-1_',
      })
        .map((message) => message.messageId)
        .sort(),
    ).toEqual(['assistant-1b', 'user-1']);
  });
});

describe('getAppendParentMessageId', () => {
  const erroredPreliminary = (userId: string): TMessage =>
    ({
      ...assistantMessage(`${userId}_`, userId),
      error: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }) as TMessage;

  it('uses the latest persisted assistant response as parent', () => {
    const messages = [userMessage('user-1'), assistantMessage('assistant-1', 'user-1')];

    expect(
      getAppendParentMessageId({ latestMessage: messages[1], currentMessages: messages }),
    ).toBe('assistant-1');
  });

  it('does not parent on an errored preliminary `_` response id', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      erroredPreliminary('user-2'),
    ];

    expect(
      getAppendParentMessageId({ latestMessage: messages[3], currentMessages: messages }),
    ).toBe('assistant-1');
  });

  it('walks past several unsaved failed turns to the nearest persisted ancestor', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      erroredPreliminary('user-2'),
      userMessage('user-3', 'user-2_'),
      erroredPreliminary('user-3'),
    ];

    expect(
      getAppendParentMessageId({ latestMessage: messages[5], currentMessages: messages }),
    ).toBe('assistant-1');
  });

  it('falls back to NO_PARENT when the whole thread is unsaved', () => {
    const messages = [userMessage('user-1'), erroredPreliminary('user-1')];

    expect(
      getAppendParentMessageId({ latestMessage: messages[1], currentMessages: messages }),
    ).toBe(Constants.NO_PARENT);
  });

  it('skips a user message whose preliminary response failed', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      erroredPreliminary('user-2'),
    ];

    expect(
      getAppendParentMessageId({ latestMessage: messages[2], currentMessages: messages }),
    ).toBe('assistant-1');
  });

  it('keeps a persisted error response as a valid parent', () => {
    const errored = { ...assistantMessage('assistant-err', 'user-1'), error: true } as TMessage;
    const messages = [userMessage('user-1'), errored];

    expect(getAppendParentMessageId({ latestMessage: errored, currentMessages: messages })).toBe(
      'assistant-err',
    );
  });
});

describe('hasPendingAssistantParent', () => {
  it('treats an errored preliminary response as not pending', () => {
    expect(
      hasPendingAssistantParent({
        ...assistantMessage('user-1_', 'user-1'),
        error: true,
      } as TMessage),
    ).toBe(false);
  });

  it('treats a streaming preliminary response without timestamps as pending', () => {
    expect(hasPendingAssistantParent(assistantMessage('user-1_', 'user-1'))).toBe(true);
  });
});
