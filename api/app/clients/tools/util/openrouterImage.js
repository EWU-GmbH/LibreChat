const OpenAI = require('openai');
const { extractBaseURL, getProxyDispatcher } = require('@librechat/api');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_GEMINI_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL = 'openai/gpt-5-image';

/**
 * @returns {string}
 */
function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || '';
}

/**
 * @param {string} [value]
 * @returns {boolean}
 */
function isOpenRouterBaseUrl(value) {
  if (!value) {
    return false;
  }
  try {
    return extractBaseURL(value).includes('openrouter.ai');
  } catch {
    return String(value).includes('openrouter.ai');
  }
}

/**
 * @param {string} [model]
 * @returns {boolean}
 */
function isOpenRouterModelId(model) {
  return typeof model === 'string' && model.includes('/');
}

/**
 * Create an OpenAI-compatible client pointed at OpenRouter (or a custom base URL).
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseURL]
 * @returns {OpenAI}
 */
function createOpenRouterImageClient({ apiKey, baseURL = OPENROUTER_BASE_URL }) {
  /** @type {ConstructorParameters<typeof OpenAI>[0]} */
  const config = {
    apiKey,
    baseURL: extractBaseURL(baseURL),
  };

  const proxyDispatcher = getProxyDispatcher();
  if (proxyDispatcher) {
    config.fetchOptions = { dispatcher: proxyDispatcher };
  }

  return new OpenAI(config);
}

/**
 * Generate an image via the OpenAI-compatible Images API (works with OpenRouter).
 * @param {Object} params
 * @param {OpenAI} params.client
 * @param {string} params.model
 * @param {string} params.prompt
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.size]
 * @param {number} [params.n]
 * @returns {Promise<{ b64: string, mimeType: string }>}
 */
async function generateImageViaOpenAICompatible({
  client,
  model,
  prompt,
  signal,
  size = '1024x1024',
  n = 1,
}) {
  const resp = await client.images.generate(
    {
      model,
      prompt,
      n: Math.min(Math.max(1, n), 10),
      size,
    },
    signal ? { signal } : undefined,
  );

  const first = resp?.data?.[0];
  if (!first) {
    throw new Error('No image data returned from image API.');
  }

  if (first.b64_json) {
    const mimeType = first.media_type || 'image/png';
    return { b64: first.b64_json, mimeType };
  }

  if (first.url) {
    const imageResponse = await fetch(first.url);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString('base64');
    return { b64, mimeType: 'image/png' };
  }

  throw new Error('Image API response missing b64_json and url.');
}

module.exports = {
  OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_GEMINI_IMAGE_MODEL,
  DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL,
  getOpenRouterApiKey,
  isOpenRouterBaseUrl,
  isOpenRouterModelId,
  createOpenRouterImageClient,
  generateImageViaOpenAICompatible,
};
