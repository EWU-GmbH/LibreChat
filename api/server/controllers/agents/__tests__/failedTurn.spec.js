const crypto = require('crypto');

const mockSaveMessage = jest.fn();
const mockSaveConvo = jest.fn();
const mockGetConvo = jest.fn();

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

const { persistFailedResumableTurn, toSafeGenerationErrorText } = require('../failedTurn');

const USER_ID = 'user-1';
const CONVERSATION_ID = 'convo-1';
const USER_MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const RESPONSE_ID = '22222222-2222-4222-8222-222222222222';

describe('toSafeGenerationErrorText', () => {
  it('drops absolute paths from ENOENT errors', () => {
    const error = new Error(
      "ENOENT: no such file or directory, open '/app/client/public/images/user/file.png'",
    );

    const text = toSafeGenerationErrorText(error);

    expect(text).toBe('Generation failed');
    expect(text).not.toMatch(/\/app\//);
    expect(text).not.toMatch(/ENOENT/);
  });

  it('drops Windows paths and keeps a useful message', () => {
    const text = toSafeGenerationErrorText(
      new Error("EIO: read failed at 'C:\\\\data\\\\uploads\\\\photo.png'"),
    );

    expect(text).not.toMatch(/uploads/);
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).toContain('EIO');
  });

  it('keeps validation errors that have no filesystem path', () => {
    expect(toSafeGenerationErrorText(new Error('Image validation failed for tiny.png'))).toBe(
      'Image validation failed for tiny.png',
    );
  });
});

describe('persistFailedResumableTurn', () => {
  beforeEach(() => {
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(RESPONSE_ID);
    mockSaveMessage.mockResolvedValue({});
    mockSaveConvo.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      endpoint: 'agents',
      title: 'Existing',
    });
    mockGetConvo.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      endpoint: 'agents',
      title: 'Existing',
      endpointType: 'custom',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('saves the user message and a persisted error response without a preliminary id', async () => {
    const result = await persistFailedResumableTurn({
      req: { body: { isTemporary: false }, config: { interfaceConfig: { privacy: true } } },
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      endpointOption: { endpoint: 'agents', endpointType: 'custom', model: 'agent_1' },
      userMessage: {
        messageId: USER_MESSAGE_ID,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'hello',
        sender: 'User',
      },
      sender: 'Agent',
      model: 'agent_1',
      error: new Error("ENOENT: no such file or directory, open '/app/uploads/missing.png'"),
    });

    expect(result).not.toBeNull();
    expect(result.responseMessage.messageId).toBe(RESPONSE_ID);
    expect(result.responseMessage.messageId.endsWith('_')).toBe(false);
    expect(result.responseMessage.messageId).not.toBe(`${USER_MESSAGE_ID}_`);
    expect(result.responseMessage.error).toBe(true);
    expect(result.responseMessage.text).toBe('Generation failed');
    expect(result.responseMessage.parentMessageId).toBe(USER_MESSAGE_ID);
    expect(result.responseMessage.content).toEqual([{ type: 'text', text: 'Generation failed' }]);
    expect(JSON.stringify(result.responseMessage)).not.toMatch(/\/app\//);

    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: USER_ID, isTemporary: false }),
      expect.objectContaining({
        messageId: USER_MESSAGE_ID,
        isCreatedByUser: true,
        error: false,
        text: 'hello',
      }),
      expect.any(Object),
    );
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ messageId: RESPONSE_ID, error: true }),
      expect.any(Object),
    );
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        endpoint: 'agents',
        endpointType: 'custom',
      }),
      expect.any(Object),
    );
    const convoFields = mockSaveConvo.mock.calls[0][1];
    expect(convoFields.title).toBeUndefined();
    expect(result.conversation.title).toBe('Existing');
  });

  it('creates a conversation title when the chat does not exist yet', async () => {
    mockGetConvo.mockResolvedValue(null);
    mockSaveConvo.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      title: 'New Chat',
      endpoint: 'agents',
    });

    await persistFailedResumableTurn({
      req: { body: {} },
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      endpointOption: { endpoint: 'agents' },
      userMessage: { messageId: USER_MESSAGE_ID, text: 'hi' },
      error: new Error('boom'),
    });

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ title: 'New Chat', endpoint: 'agents' }),
      expect.any(Object),
    );
  });

  it('still returns persisted messages when saving the conversation fails', async () => {
    mockSaveConvo.mockRejectedValue(new Error('db down'));

    const result = await persistFailedResumableTurn({
      req: { body: {} },
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      endpointOption: { endpoint: 'agents' },
      userMessage: { messageId: USER_MESSAGE_ID, text: 'hi' },
      error: new Error('Image validation failed for tiny.png'),
    });

    expect(result.responseMessage.text).toBe('Image validation failed for tiny.png');
    expect(result.conversation.conversationId).toBe(CONVERSATION_ID);
    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
  });

  it('skips saving the user message when it was already persisted', async () => {
    await persistFailedResumableTurn({
      req: { body: {} },
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      endpointOption: { endpoint: 'agents' },
      userMessage: { messageId: USER_MESSAGE_ID, text: 'hi' },
      skipSaveUserMessage: true,
      error: new Error('boom'),
    });

    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage.mock.calls[0][1].messageId).toBe(RESPONSE_ID);
  });

  it('returns null when there is no user message to parent the error on', async () => {
    const result = await persistFailedResumableTurn({
      req: { body: {} },
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      userMessage: null,
      error: new Error('boom'),
    });

    expect(result).toBeNull();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });
});
