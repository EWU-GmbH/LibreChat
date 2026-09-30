const MISSING_STORAGE_CODES = new Set([
  404,
  '404',
  'ENOENT',
  'NoSuchKey',
  'NotFound',
  'ResourceNotFound',
]);

/**
 * @param {object | null | undefined} err
 * @param {string | number} [err.code]
 * @param {string | number} [err.status]
 * @param {string | number} [err.statusCode]
 * @param {{ status?: string | number }} [err.response]
 * @param {string} [err.message]
 * @returns {boolean}
 */
function isMissingStorageError(err) {
  const code = err?.code ?? err?.status ?? err?.statusCode ?? err?.response?.status;
  if (MISSING_STORAGE_CODES.has(code)) {
    return true;
  }

  const message = String(err?.message ?? '');
  return (
    /(?:file|object|blob|key|resource) (?:not found|does not exist)/i.test(message) ||
    /no such (?:file|key)/i.test(message)
  );
}

module.exports = { isMissingStorageError };
