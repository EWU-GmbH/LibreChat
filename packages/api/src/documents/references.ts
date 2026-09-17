export const LIBRECHAT_IMAGE_PREFIX: string = 'lc-file:';
export const LATEST_LIBRECHAT_IMAGE: string = `${LIBRECHAT_IMAGE_PREFIX}latest`;

const markdownImagePattern = /(!\[[^\]]*\]\()lc-file:([^)]+)(\))/g;

export interface DocumentImageReference {
  fileId: string;
}

interface ImageBlock {
  type: 'image';
  src?: string;
  fileId?: string;
  [key: string]: boolean | number | string | undefined;
}

interface BasicBlock {
  type: string;
}

interface DocumentArguments {
  content?: string;
  blocks?: Array<ImageBlock | BasicBlock>;
  [key: string]: object | string | undefined;
}

export type ResolveDocumentImage = (reference: DocumentImageReference) => Promise<string>;

function getReference(value: string | undefined): DocumentImageReference | null {
  if (!value?.startsWith(LIBRECHAT_IMAGE_PREFIX)) {
    return null;
  }
  const fileId = value.slice(LIBRECHAT_IMAGE_PREFIX.length).trim();
  if (!fileId) {
    throw new Error('LibreChat image reference is missing a file ID');
  }
  return { fileId };
}

export function hasDocumentImageReferences(toolArguments: object | string): boolean {
  const serialized =
    typeof toolArguments === 'string' ? toolArguments : JSON.stringify(toolArguments);
  return serialized.includes(LIBRECHAT_IMAGE_PREFIX) || serialized.includes('"fileId"');
}

export async function resolveDocumentImageReferences(
  toolArguments: object | string,
  resolveImage: ResolveDocumentImage,
): Promise<object | string> {
  if (!hasDocumentImageReferences(toolArguments)) {
    return toolArguments;
  }

  const parsed =
    typeof toolArguments === 'string'
      ? (JSON.parse(toolArguments) as DocumentArguments)
      : (toolArguments as DocumentArguments);
  const blocks = parsed.blocks ? [...parsed.blocks] : undefined;

  if (blocks) {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type !== 'image') {
        continue;
      }
      const image = block as ImageBlock;
      const reference = image.fileId ? { fileId: image.fileId.trim() } : getReference(image.src);
      if (!reference) {
        continue;
      }
      const { fileId: _, ...rest } = image;
      blocks[index] = { ...rest, src: await resolveImage(reference) };
    }
  }

  let content = parsed.content;
  if (content?.includes(LIBRECHAT_IMAGE_PREFIX)) {
    const matches = [...content.matchAll(markdownImagePattern)];
    for (const match of matches) {
      const dataUri = await resolveImage({ fileId: match[2].trim() });
      content = content.replace(match[0], `${match[1]}${dataUri}${match[3]}`);
    }
  }

  const resolved = { ...parsed, blocks, content };
  return typeof toolArguments === 'string' ? JSON.stringify(resolved) : resolved;
}
