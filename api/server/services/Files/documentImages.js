const { resolveDocumentImageReferences } = require('@librechat/api');
const { FileContext, FileSources } = require('librechat-data-provider');
const { getStrategyFunctions } = require('./strategies');
const { getFiles } = require('~/models');

const MAX_DOCUMENT_IMAGE_BYTES = 2 * 1024 * 1024;
const DOCUMENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
const DOCUMENT_SERVER_NAME = 'documents';
const DOCUMENT_TOOLS = new Set(['create_docx', 'create_pdf']);
const LATEST_REFERENCE = 'latest';

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

/**
 * Loads a user-owned LibreChat image as a data URI for document generation.
 * `latest` resolves the user's most recent generated image (e.g. Flux output).
 *
 * @param {Object} params
 * @param {string} params.fileId
 * @param {ServerRequest} params.req
 * @param {IUser} params.user
 * @returns {Promise<string>}
 */
async function resolveDocumentImage({ fileId, req, user }) {
  if (!req?.config || !user?.id) {
    throw new Error('LibreChat image references require an authenticated request');
  }

  const filter = { user: user.id, type: { $in: DOCUMENT_IMAGE_TYPES } };
  if (fileId === LATEST_REFERENCE) {
    filter.context = FileContext.image_generation;
  } else {
    filter.file_id = fileId;
  }

  const [file] = (await getFiles(filter, { createdAt: -1 })) ?? [];
  if (!file) {
    throw new Error(
      fileId === LATEST_REFERENCE
        ? 'No generated image found for this user'
        : 'LibreChat image not found or access denied',
    );
  }
  if (file.bytes > MAX_DOCUMENT_IMAGE_BYTES) {
    throw new Error('Document image exceeds 2 MB');
  }

  const { getDownloadStream } = getStrategyFunctions(file.source ?? FileSources.local);
  if (!getDownloadStream) {
    throw new Error('LibreChat image storage cannot be read');
  }

  const stream = await getDownloadStream(req, file.filepath);
  const buffer = await readLimitedBuffer(stream, MAX_DOCUMENT_IMAGE_BYTES);
  const type = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  return `data:${type};base64,${buffer.toString('base64')}`;
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
 * @returns {Promise<Object | string>}
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
  resolveDocumentImage,
  resolveDocumentToolImages,
};
