import sharp from 'sharp';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Alignment, ContentBlock, ImageFormat, PreparedImage } from './model';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 12;
export const DEFAULT_IMAGE_WIDTH_MM = 120;

export interface ImageLoaderDeps {
  fetch: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Pick<Response, 'arrayBuffer' | 'ok' | 'status'>>;
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const defaultDeps: ImageLoaderDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  lookup: async (hostname) => dnsLookup(hostname, { all: true }),
};

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
]);

export function detectImageFormat(data: Buffer): ImageFormat {
  if (data.length >= 8 && data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') {
    return 'png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg';
  }
  throw new Error('Nur PNG- und JPEG-Bilder werden unterstützt');
}

export function readImageSize(
  data: Buffer,
  format: ImageFormat,
): { width: number; height: number } {
  if (format === 'png') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  const jpeg = readJpegSize(data);
  if (!jpeg) {
    return { width: 800, height: 600 };
  }
  return jpeg;
}

function readJpegSize(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      return null;
    }
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

export function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.startsWith('::ffff:')) {
    return isBlockedIp(normalized.slice(7));
  }
  const family = isIP(normalized);
  if (family === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    );
  }
  if (family !== 4) {
    return true;
  }
  const parts = normalized.split('.').map(Number);
  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  return first >= 224;
}

export function assertPublicHttpUrl(src: string): URL {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error('Ungültige Bild-URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Bilder dürfen nur über http(s) geladen werden');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Bild-Host ist nicht erlaubt');
  }
  if (isIP(hostname) && isBlockedIp(hostname)) {
    throw new Error('Bild-Host ist nicht erlaubt');
  }
  return url;
}

export function parseDataUri(src: string): Buffer {
  const match = /^data:image\/(png|jpe?g);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(src.trim());
  if (!match) {
    throw new Error('Ungültige Data-URI. Erlaubt sind image/png und image/jpeg.');
  }
  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new Error('Bild ist leer oder größer als 2 MB');
  }
  return data;
}

async function fetchHttpImage(src: string, deps: ImageLoaderDeps): Promise<Buffer> {
  const url = assertPublicHttpUrl(src);
  if (!isIP(url.hostname)) {
    const records = await deps.lookup(url.hostname);
    if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
      throw new Error('Bild-Host ist nicht erlaubt');
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await deps.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'image/*' },
    });
    if (!response.ok) {
      throw new Error(`Bild konnte nicht geladen werden (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error('Bild ist leer oder größer als 2 MB');
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Zeitüberschreitung beim Laden des Bildes');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function normalizeImage(data: Buffer): Promise<{ data: Buffer; format: ImageFormat }> {
  try {
    const format = detectImageFormat(data);
    return compressForPrint(data, format);
  } catch {
    try {
      const converted = await sharp(data, { failOn: 'error', limitInputPixels: 40_000_000 })
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      if (converted.length === 0 || converted.length > MAX_IMAGE_BYTES) {
        throw new Error('Konvertiertes Bild ist leer oder größer als 2 MB');
      }
      return { data: converted, format: 'jpg' };
    } catch {
      throw new Error('Nur gültige PNG-, JPEG-, WebP- und SVG-Bilder werden unterstützt');
    }
  }
}

async function compressForPrint(
  data: Buffer,
  format: ImageFormat,
): Promise<{ data: Buffer; format: ImageFormat }> {
  try {
    const compressed = await sharp(data, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    if (compressed.length === 0 || compressed.length > MAX_IMAGE_BYTES) {
      return { data, format };
    }
    if (compressed.length < data.length || data.length > 400_000) {
      return { data: compressed, format: 'jpg' };
    }
    return { data, format };
  } catch {
    return { data, format };
  }
}

export function imageDataUri(data: Buffer, format: ImageFormat): string {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${data.toString('base64')}`;
}

export async function loadImageSource(
  src: string,
  widthMm: number | undefined,
  alt: string | undefined,
  align: Alignment | undefined,
  deps: ImageLoaderDeps = defaultDeps,
  caption?: string,
): Promise<PreparedImage> {
  const input = src.startsWith('data:') ? parseDataUri(src) : await fetchHttpImage(src, deps);
  const { data, format } = await normalizeImage(input);
  const size = readImageSize(data, format);
  const width = Math.min(Math.max(widthMm ?? DEFAULT_IMAGE_WIDTH_MM, 10), 190);
  const ratio = size.height > 0 ? size.width / size.height : 1.5;
  const altText = alt?.trim() || 'Bild';
  return {
    data,
    format,
    dataUri: imageDataUri(data, format),
    widthMm: width,
    heightMm: width / ratio,
    alt: altText,
    caption: caption?.trim() || altText,
    align: align ?? 'left',
  };
}

export async function loadBlockImages(
  blocks: ContentBlock[],
  deps: ImageLoaderDeps = defaultDeps,
): Promise<Map<number, PreparedImage>> {
  const images = new Map<number, PreparedImage>();
  let count = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== 'image') {
      continue;
    }
    count += 1;
    if (count > MAX_IMAGES) {
      throw new Error(`Höchstens ${MAX_IMAGES} Bilder pro Dokument`);
    }
    images.set(
      index,
      await loadImageSource(
        block.src,
        block.widthMm,
        block.alt,
        block.align,
        deps,
        block.caption,
      ),
    );
  }
  return images;
}
