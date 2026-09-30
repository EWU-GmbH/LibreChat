const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { Constants, ContentTypes } = require('librechat-data-provider');
const { saveConvo, getConvo, saveMessage } = require('~/models');

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/][^\s'"]+|\/(?:[\w.@+-]+\/)+[\w.@+-]+)/g;
const MAX_ERROR_TEXT_LENGTH = 500;
const FALLBACK_ERROR_TEXT = 'Generation failed';

/**
 * @param {unknown} error
 * @returns {string}
 */
function readErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    error != null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return '';
}

/**
 * Client-facing generation error text with absolute filesystem paths removed.
 * @param {unknown} error
 * @returns {string}
 */
function toSafeGenerationErrorText(error) {
  const withoutPaths = readErrorMessage(error)
    .replace(ABSOLUTE_PATH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const useful = withoutPaths
    .replace(/^ENOENT:\s*/i, '')
    .replace(/no such file or directory/gi, '')
    .replace(/,?\s*open\s*/gi, '')
    .replace(/['"]/g, '')
    .replace(/^[,:\s]+|[,:\s]+$/g, '')
    .trim();
  if (!useful) {
    return FALLBACK_ERROR_TEXT;
  }
  return useful.slice(0, MAX_ERROR_TEXT_LENGTH);
}

/**
 * Persist the user turn and an error response so follow-ups are not parented
 * on an unsaved preliminary `{messageId}_` id.
 * @param {object} params
 * @param {object} params.req
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {object} [params.endpointOption]
 * @param {object | null | undefined} params.userMessage
 * @param {string} [params.sender]
 * @param {string} [params.model]
 * @param {string} [params.iconURL]
 * @param {boolean} [params.skipSaveUserMessage]
 * @param {unknown} params.error
 * @returns {Promise<{ requestMessage: object, responseMessage: object, conversation: object } | null>}
 */
async function persistFailedResumableTurn({
  req,
  userId,
  conversationId,
  endpointOption,
  userMessage,
  sender,
  model,
  iconURL,
  skipSaveUserMessage = false,
  error,
}) {
  if (!userId || !conversationId || conversationId === Constants.NEW_CONVO) {
    return null;
  }
  if (!userMessage?.messageId) {
    return null;
  }

  const safeText = toSafeGenerationErrorText(error);
  const responseMessageId = crypto.randomUUID();
  const reqCtx = {
    userId,
    isTemporary: req?.body?.isTemporary,
    interfaceConfig: req?.config?.interfaceConfig,
  };

  const requestMessage = {
    ...userMessage,
    conversationId,
    parentMessageId: userMessage.parentMessageId ?? Constants.NO_PARENT,
    isCreatedByUser: true,
    sender: userMessage.sender ?? 'User',
    text: userMessage.text ?? '',
    error: false,
    unfinished: false,
    user: userId,
  };
  if (
    requestMessage.files == null &&
    Array.isArray(req?.body?.files) &&
    req.body.files.length > 0
  ) {
    requestMessage.files = req.body.files;
  }

  const responseMessage = {
    messageId: responseMessageId,
    conversationId,
    parentMessageId: requestMessage.messageId,
    sender: sender || 'AI',
    text: safeText,
    content: [{ type: ContentTypes.TEXT, text: safeText }],
    error: true,
    unfinished: false,
    isCreatedByUser: false,
    user: userId,
    endpoint: endpointOption?.endpoint,
    model: model ?? endpointOption?.model,
    ...(iconURL ? { iconURL } : {}),
  };

  if (!skipSaveUserMessage) {
    await saveMessage(reqCtx, requestMessage, {
      context: 'api/server/controllers/agents/failedTurn.js - failed user message',
    });
  }
  await saveMessage(reqCtx, responseMessage, {
    context: 'api/server/controllers/agents/failedTurn.js - failed response',
  });

  let savedConversation = null;
  try {
    const existing = await getConvo(userId, conversationId);
    /** @type {Record<string, unknown>} */
    const convoFields = {
      conversationId,
      endpoint: endpointOption?.endpoint ?? existing?.endpoint,
    };
    const endpointType = endpointOption?.endpointType ?? existing?.endpointType;
    if (endpointType) {
      convoFields.endpointType = endpointType;
    }
    if (existing == null) {
      convoFields.title = 'New Chat';
    }
    savedConversation = await saveConvo(reqCtx, convoFields, {
      context: 'api/server/controllers/agents/failedTurn.js - failed generation',
    });
  } catch (convoError) {
    logger.error(
      '[ResumableAgentController] Failed to save conversation after generation error',
      convoError,
    );
  }

  const conversation = savedConversation ?? {
    conversationId,
    endpoint: endpointOption?.endpoint,
    title: 'New Chat',
  };

  return { requestMessage, responseMessage, conversation };
}

module.exports = {
  persistFailedResumableTurn,
  toSafeGenerationErrorText,
};
