const { resolveDocumentImageReferences } = require('@librechat/api');
const { FileContext, FileSources } = require('librechat-data-provider');
const { getStrategyFunctions } = require('./strategies');
const { getFiles } = require('~/models');

const MAX_DOCUMENT_IMAGE_BYTES = 2 * 1024 * 1024;
const DOCUMENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
const DOCUMENT_SERVER_NAME = 'documents';
const DOCUMENT_TOOLS = new Set(['create_docx', 'create_pdf']);
const LATEST_REFERENCE = 'latest';
const MISSING_STORAGE_CODES = new Set([
  404,
  '404',
  'ENOENT',
  'NoSuchKey',
  'NotFound',
  'ResourceNotFound',
]);

function isMissingStorageError(err) {
  const code = err?.code ?? err?.status ?? err?.statusCode ?? err?.response?.status;
  if (MISSING_STORAGE_CODES.has(code)) {
    return true;
  }
  return /(?:file|object|blob|key|resource) (?:not found|does not exist)|no such (?:file|key)/i.test(
    String(err?.message ?? ''),
  );
}

async function readLimitedBuffer(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      stream.destroy?.();
      throw new Error('Document image exceeds 2 MB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readFileAsDataUri(file, req) {
  if (file.bytes > MAX_DOCUMENT_IMAGE_BYTES) {
    throw new Error('Document image exceeds 2 MB');
  }

  const source = file.source ?? FileSources.local;
  const { getDownloadStream } = getStrategyFunctions(source);
  if (!getDownloadStream) {
    throw new Error('LibreChat image storage cannot be read');
  }

  // #region agent log
  require('fs').appendFileSync(
    '/opt/cursor/logs/debug.log',
    JSON.stringify({
      location: 'documentImages.js:readFileAsDataUri',
      message: 'before getDownloadStream',
      data: {
        file_id: file.file_id,
        source,
        filepathPrefix: typeof file.filepath === 'string' ? file.filepath.slice(0, 80) : null,
        bytes: file.bytes,
        runId: 'post-fix',
      },
      timestamp: Date.now(),
      hypothesisId: 'A,D',
    }) + '\n',
  );
  // #endregion

  const stream = await getDownloadStream(req, file.filepath);
  const buffer = await readLimitedBuffer(stream, MAX_DOCUMENT_IMAGE_BYTES);
  // #region agent log
  require('fs').appendFileSync(
    '/opt/cursor/logs/debug.log',
    JSON.stringify({
      location: 'documentImages.js:readFileAsDataUri',
      message: 'stream read ok',
      data: { file_id: file.file_id, bufferBytes: buffer.length, runId: 'post-fix' },
      timestamp: Date.now(),
      hypothesisId: 'A',
    }) + '\n',
  );
  // #endregion
  const type = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  return `data:${type};base64,${buffer.toString('base64')}`;
}

/**
 * Loads a user-owned LibreChat image as a data URI for document generation.
 * `latest` resolves the user's most recent generated image (e.g. Flux output).
 * Orphaned Mongo metadata (missing storage bytes) is skipped for `latest`.
 *
 * @param {Object} params
 * @param {string} params.fileId
 * @param {ServerRequest} params.req
 * @param {IUser} params.user
 * @returns {Promise<string>}
 */
async function resolveDocumentImage({ fileId, req, user }) {
  if (!req?.config || !user?.id) {
    // #region agent log
    require('fs').appendFileSync(
      '/opt/cursor/logs/debug.log',
      JSON.stringify({
        location: 'documentImages.js:resolveDocumentImage',
        message: 'auth/config missing',
        data: { hasReq: !!req, hasConfig: !!req?.config, hasUserId: !!user?.id, fileId, runId: 'post-fix' },
        timestamp: Date.now(),
        hypothesisId: 'C',
      }) + '\n',
    );
    // #endregion
    throw new Error('LibreChat image references require an authenticated request');
  }

  const filter = { user: user.id, type: { $in: DOCUMENT_IMAGE_TYPES } };
  if (fileId === LATEST_REFERENCE) {
    filter.context = FileContext.image_generation;
  } else {
    filter.file_id = fileId;
  }

  const files = (await getFiles(filter, { createdAt: -1 })) ?? [];
  // #region agent log
  require('fs').appendFileSync(
    '/opt/cursor/logs/debug.log',
    JSON.stringify({
      location: 'documentImages.js:resolveDocumentImage',
      message: 'getFiles result',
      data: {
        fileId,
        userId: user.id,
        filterContext: filter.context || null,
        filterTypes: DOCUMENT_IMAGE_TYPES,
        matchCount: files.length,
        candidates: files.slice(0, 5).map((f) => ({
          file_id: f.file_id,
          type: f.type,
          context: f.context,
          source: f.source,
          bytes: f.bytes,
          filepath: typeof f.filepath === 'string' ? f.filepath.slice(0, 80) : null,
        })),
        runId: 'post-fix',
      },
      timestamp: Date.now(),
      hypothesisId: 'A,B,D',
    }) + '\n',
  );
  // #endregion

  if (!files.length) {
    // #region agent log
    require('fs').appendFileSync(
      '/opt/cursor/logs/debug.log',
      JSON.stringify({
        location: 'documentImages.js:resolveDocumentImage',
        message: 'no matching file metadata',
        data: { fileId, userId: user.id, runId: 'post-fix' },
        timestamp: Date.now(),
        hypothesisId: 'B',
      }) + '\n',
    );
    // #endregion
    throw new Error(
      fileId === LATEST_REFERENCE
        ? 'No generated image found for this user'
        : 'LibreChat image not found or access denied',
    );
  }

  let missingStorageCount = 0;
  for (const file of files) {
    try {
      return await readFileAsDataUri(file, req);
    } catch (error) {
      // #region agent log
      require('fs').appendFileSync(
        '/opt/cursor/logs/debug.log',
        JSON.stringify({
          location: 'documentImages.js:resolveDocumentImage',
          message: 'stream/read failed',
          data: {
            file_id: file.file_id,
            source: file.source ?? FileSources.local,
            code: error?.code,
            errMessage: String(error?.message || error).slice(0, 200),
            isMissing: isMissingStorageError(error),
            willSkip: fileId === LATEST_REFERENCE && isMissingStorageError(error),
            runId: 'post-fix',
          },
          timestamp: Date.now(),
          hypothesisId: 'A,D',
        }) + '\n',
      );
      // #endregion

      if (fileId === LATEST_REFERENCE && isMissingStorageError(error)) {
        missingStorageCount += 1;
        continue;
      }
      if (isMissingStorageError(error)) {
        throw new Error('LibreChat image file is missing from storage');
      }
      throw error;
    }
  }

  // #region agent log
  require('fs').appendFileSync(
    '/opt/cursor/logs/debug.log',
    JSON.stringify({
      location: 'documentImages.js:resolveDocumentImage',
      message: 'all latest candidates missing from storage',
      data: { userId: user.id, missingStorageCount, runId: 'post-fix' },
      timestamp: Date.now(),
      hypothesisId: 'A',
    }) + '\n',
  );
  // #endregion
  throw new Error('No generated image found for this user');
}

/**
 * Replaces `lc-file:` image references in document tool arguments with data URIs
 * read from LibreChat storage under the requesting user's ownership.
 *
 * @param {Object} params
 * @param {string} params.serverName
 * @param {string} params.toolName
 * @param {Object | string} params.toolArguments
 * @param {ServerRequest} [params.req]
 * @param {IUser} [params.user]
 * @returns {Promise<object | string>}
 */
async function resolveDocumentToolImages({ serverName, toolName, toolArguments, req, user }) {
  if (serverName !== DOCUMENT_SERVER_NAME || !DOCUMENT_TOOLS.has(toolName)) {
    return toolArguments;
  }
  return resolveDocumentImageReferences(toolArguments, (reference) =>
    resolveDocumentImage({ ...reference, req, user }),
  );
}

module.exports = {
  MAX_DOCUMENT_IMAGE_BYTES,
  isMissingStorageError,
  resolveDocumentImage,
  resolveDocumentToolImages,
};
