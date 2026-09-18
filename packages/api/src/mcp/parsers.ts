import crypto from 'node:crypto';
import { Tools } from 'librechat-data-provider';
import type { UIResource } from 'librechat-data-provider';
import type * as t from './types';

export const DEFAULT_MCP_IMAGE_DATA_MAX_BYTES: number = 10 * 1024 * 1024;
/** Default cap for MCP binary file attachments (audio, etc.) — matches OpenAI/ElevenLabs upload limits. */
export const DEFAULT_MCP_FILE_DATA_MAX_BYTES: number = 25 * 1024 * 1024;

function generateResourceId(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 10);
}

function getMCPImageDataMaxBytes(): number {
  const raw = process.env.MCP_IMAGE_DATA_MAX_BYTES;
  if (!raw) {
    return DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
}

function getMCPFileDataMaxBytes(): number {
  const raw = process.env.MCP_FILE_DATA_MAX_BYTES;
  if (!raw) {
    return DEFAULT_MCP_FILE_DATA_MAX_BYTES;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_FILE_DATA_MAX_BYTES;
}

function getBase64Padding(data: string): number {
  if (data.endsWith('==')) {
    return 2;
  }
  if (data.endsWith('=')) {
    return 1;
  }
  return 0;
}

function estimateBase64Bytes(data: string): number {
  const padding = getBase64Padding(data);
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function estimateBase64ImageBytes(data: string): number {
  return estimateBase64Bytes(data);
}

function assertFileDataWithinLimit(data: string, label: string): void {
  const maxBytes = getMCPFileDataMaxBytes();
  const estimatedBytes = estimateBase64Bytes(data);
  if (estimatedBytes <= maxBytes) {
    return;
  }

  throw new Error(
    `MCP file result exceeds maximum size of ${maxBytes} bytes: ${estimatedBytes} bytes (${label})`,
  );
}

function extensionFromMimeType(mimeType: string | undefined): string {
  if (!mimeType) {
    return 'bin';
  }
  const subtype = mimeType.split(';')[0]?.split('/')[1]?.trim().toLowerCase();
  if (!subtype) {
    return 'bin';
  }
  if (subtype === 'mpeg' || subtype === 'mp3') {
    return 'mp3';
  }
  if (subtype === 'x-wav' || subtype === 'wave') {
    return 'wav';
  }
  if (subtype === 'mp4' || subtype === 'x-m4a') {
    return 'm4a';
  }
  return subtype.replace(/^x-/, '') || 'bin';
}

function filenameFromResourceUri(uri: string, mimeType?: string): string {
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const leaf = withoutScheme.split(/[/\\]/).filter(Boolean).pop();
  if (leaf && leaf.includes('.')) {
    return leaf;
  }
  return `mcp_file_${generateResourceId(uri)}.${extensionFromMimeType(mimeType)}`;
}

function isBlobResource(
  resource: t.EmbeddedResource['resource'],
): resource is t.EmbeddedResource['resource'] & { blob: string } {
  return (
    'blob' in resource && typeof (resource as { blob?: unknown }).blob === 'string' && !!resource.blob
  );
}

function isRemoteImageUrl(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

function assertImageDataWithinLimit(item: t.ImageContent): void {
  if (isRemoteImageUrl(item.data)) {
    return;
  }

  const maxBytes = getMCPImageDataMaxBytes();
  const estimatedBytes = estimateBase64ImageBytes(item.data);
  if (estimatedBytes <= maxBytes) {
    return;
  }

  throw new Error(
    `MCP image result exceeds maximum size of ${maxBytes} bytes: ${estimatedBytes} bytes`,
  );
}

const RECOGNIZED_PROVIDERS = new Set([
  'google',
  'anthropic',
  'openai',
  'azureopenai',
  'openrouter',
  'xai',
  'deepseek',
  'ollama',
  'bedrock',
]);

const imageFormatters: Record<string, undefined | t.ImageFormatter> = {
  // google: (item) => ({
  //   type: 'image',
  //   inlineData: {
  //     mimeType: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  // anthropic: (item) => ({
  //   type: 'image',
  //   source: {
  //     type: 'base64',
  //     media_type: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  default: (item) => ({
    type: 'image_url',
    image_url: {
      url: isRemoteImageUrl(item.data) ? item.data : `data:${item.mimeType};base64,${item.data}`,
    },
  }),
};

function isImageContent(item: t.ToolContentPart): item is t.ImageContent {
  return item.type === 'image';
}

function parseAsString(result: t.MCPToolCallResponse): string {
  const content = result?.content ?? [];
  if (!content.length) {
    return '(No response)';
  }

  const text = content
    .map((item) => {
      if (item.type === 'text') {
        return item.text;
      }
      if (item.type === 'resource') {
        const resourceText = [];
        if (isBlobResource(item.resource)) {
          const mimeType = item.resource.mimeType || 'application/octet-stream';
          const filename = filenameFromResourceUri(item.resource.uri, mimeType);
          resourceText.push(`File attachment available for download: ${filename}`);
        } else if ('text' in item.resource && item.resource.text != null && item.resource.text) {
          resourceText.push(item.resource.text);
        }
        if (item.resource.uri) {
          resourceText.push(`Resource URI: ${item.resource.uri}`);
        }
        if (item.resource.mimeType != null && item.resource.mimeType) {
          resourceText.push(`Type: ${item.resource.mimeType}`);
        }
        return resourceText.join('\n');
      }
      if (item.type === 'audio' && typeof item.data === 'string') {
        const mimeType = item.mimeType || 'audio/mpeg';
        return `File attachment available for download (${mimeType})`;
      }
      if (isImageContent(item)) {
        assertImageDataWithinLimit(item);
      }
      return JSON.stringify(item, null, 2);
    })
    .filter(Boolean)
    .join('\n\n');

  return text;
}

/**
 * Converts MCPToolCallResponse content into a plain-text string plus optional artifacts
 * (images, UI resources). All providers receive string content; images are separated into
 * artifacts and merged back by the agents package via formatArtifactPayload / formatAnthropicArtifactContent.
 *
 * @param provider - Used only to distinguish recognized vs. unrecognized providers.
 * All recognized providers currently produce identical string output;
 * provider-specific artifact merging is delegated to the agents package.
 */
export function formatToolContent(
  result: t.MCPToolCallResponse,
  provider: t.Provider,
): t.FormattedContentResult {
  if (!RECOGNIZED_PROVIDERS.has(provider)) {
    return [parseAsString(result), undefined];
  }

  const content = result?.content ?? [];
  if (!content.length) {
    return ['(No response)', undefined];
  }

  const imageUrls: t.FormattedContent[] = [];
  const uiResources: UIResource[] = [];
  const mcpFiles: t.McpFileArtifact[] = [];
  let currentTextBlock = '';

  type ContentHandler = undefined | ((item: t.ToolContentPart) => void);

  const contentHandlers: {
    text: (item: Extract<t.ToolContentPart, { type: 'text' }>) => void;
    image: (item: t.ToolContentPart) => void;
    audio: (item: t.ToolContentPart) => void;
    resource: (item: Extract<t.ToolContentPart, { type: 'resource' }>) => void;
  } = {
    text: (item) => {
      currentTextBlock += (currentTextBlock ? '\n\n' : '') + item.text;
    },

    image: (item) => {
      if (!isImageContent(item)) {
        return;
      }
      assertImageDataWithinLimit(item);
      const formatter = imageFormatters.default as t.ImageFormatter;
      const formattedImage = formatter(item);

      if (formattedImage.type === 'image_url') {
        imageUrls.push(formattedImage);
      }
    },

    audio: (item) => {
      if (item.type !== 'audio' || typeof item.data !== 'string' || !item.data) {
        return;
      }
      const mimeType = item.mimeType || 'audio/mpeg';
      assertFileDataWithinLimit(item.data, mimeType);
      const filename = `mcp_audio_${generateResourceId(item.data)}.${extensionFromMimeType(mimeType)}`;
      mcpFiles.push({
        filename,
        mimeType,
        data: item.data,
      });
      currentTextBlock +=
        (currentTextBlock ? '\n\n' : '') +
        `File attachment available for download: ${filename}\nType: ${mimeType}`;
    },

    resource: (item) => {
      const isUiResource = item.resource.uri.startsWith('ui://');
      const resourceText: string[] = [];

      if (isUiResource) {
        const contentToHash =
          'text' in item.resource && item.resource.text && typeof item.resource.text === 'string'
            ? item.resource.text
            : item.resource.uri;
        const resourceId = generateResourceId(contentToHash);
        const uiResource: UIResource = {
          ...item.resource,
          resourceId,
        };
        uiResources.push(uiResource);
        resourceText.push(`UI Resource ID: ${resourceId}`);
        resourceText.push(`UI Resource Marker: \\ui{${resourceId}}`);
      } else if (isBlobResource(item.resource)) {
        const mimeType = item.resource.mimeType || 'application/octet-stream';
        assertFileDataWithinLimit(item.resource.blob, item.resource.uri || mimeType);
        const filename = filenameFromResourceUri(item.resource.uri, mimeType);
        mcpFiles.push({
          filename,
          mimeType,
          data: item.resource.blob,
        });
        resourceText.push(`File attachment available for download: ${filename}`);
      } else if ('text' in item.resource && item.resource.text != null && item.resource.text) {
        resourceText.push(`Resource Text: ${item.resource.text}`);
      }

      if (item.resource.uri.length) {
        resourceText.push(`Resource URI: ${item.resource.uri}`);
      }
      if (item.resource.mimeType != null && item.resource.mimeType) {
        resourceText.push(`Resource MIME Type: ${item.resource.mimeType}`);
      }

      if (resourceText.length) {
        currentTextBlock += (currentTextBlock ? '\n\n' : '') + resourceText.join('\n');
      }
    },
  };

  for (const item of content) {
    const handler = contentHandlers[item.type as keyof typeof contentHandlers] as ContentHandler;
    if (handler) {
      handler(item as never);
    } else {
      const stringified = JSON.stringify(item, null, 2);
      currentTextBlock += (currentTextBlock ? '\n\n' : '') + stringified;
    }
  }

  if (uiResources.length > 0) {
    const uiInstructions = `

UI Resource Markers Available:
- Each resource above includes a stable ID and a marker hint like \`\\ui{abc123}\`
- You should usually introduce what you're showing before placing the marker
- For a single resource: \\ui{resource-id}
- For multiple resources shown separately: \\ui{resource-id-a} \\ui{resource-id-b}
- For multiple resources in a carousel: \\ui{resource-id-a,resource-id-b,resource-id-c}
- The UI will be rendered inline where you place the marker
- Format: \\ui{resource-id} or \\ui{id1,id2,id3} using the IDs provided above`;

    currentTextBlock += uiInstructions;
  }

  let artifacts: t.Artifacts = undefined;
  if (imageUrls.length > 0) {
    artifacts = { content: imageUrls };
  }

  if (uiResources.length > 0) {
    artifacts = {
      ...artifacts,
      [Tools.ui_resources]: { data: uiResources },
    };
  }

  if (mcpFiles.length > 0) {
    artifacts = {
      ...artifacts,
      mcp_files: mcpFiles,
    };
  }

  return [currentTextBlock || (artifacts !== undefined ? '' : '(No response)'), artifacts];
}
