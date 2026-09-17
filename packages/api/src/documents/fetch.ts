import { load } from 'cheerio';
import { isIP } from 'node:net';
import robotsParser from 'robots-parser';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isBlockedIp } from './images';

const USER_AGENT = 'EWU-KI-URL-Fetcher/1.0';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 128 * 1024;
const MAX_MARKDOWN_CHARS = 500_000;
const MAX_REDIRECTS = 3;
const MAX_IMAGES = 50;
const MAX_COLORS = 20;
const FETCH_TIMEOUT_MS = 12_000;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
]);

export interface FetchUrlDeps {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface FetchedImage {
  url: string;
  alt?: string;
}

export interface FetchedPage {
  url: string;
  title?: string;
  markdown: string;
  images: FetchedImage[];
  colors: string[];
  truncated: boolean;
}

const defaultDeps: FetchUrlDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  lookup: async (hostname) => dnsLookup(hostname, { all: true }),
};

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    BLOCKED_HOSTS.has(normalized) ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

export function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Ungültige URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Nur http(s)-URLs sind erlaubt');
  }
  if (url.username || url.password) {
    throw new Error('URLs mit Zugangsdaten sind nicht erlaubt');
  }
  if (isBlockedHostname(url.hostname) || (isIP(url.hostname) && isBlockedIp(url.hostname))) {
    throw new Error('URL-Host ist nicht erlaubt');
  }
  return url;
}

async function assertPublicDns(url: URL, deps: FetchUrlDeps): Promise<void> {
  if (isIP(url.hostname)) {
    return;
  }
  const records = await deps.lookup(url.hostname);
  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    throw new Error('URL-Host ist nicht erlaubt');
  }
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`Antwort ist größer als ${Math.floor(limit / 1024)} KB`);
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Antwort ist größer als ${Math.floor(limit / 1024)} KB`);
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

async function request(
  initialUrl: URL,
  deps: FetchUrlDeps,
  accept: string,
  maxBytes: number,
): Promise<{ response: Response; body: string; url: URL }> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicDns(url, deps);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status < 300 || response.status >= 400) {
      return { response, body: await readLimited(response, maxBytes), url };
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Weiterleitung ohne Ziel (${response.status})`);
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error('Zu viele Weiterleitungen');
    }
    url = parsePublicUrl(new URL(location, url).toString());
  }
  throw new Error('Zu viele Weiterleitungen');
}

async function assertRobotsAllowed(url: URL, deps: FetchUrlDeps): Promise<void> {
  const robotsUrl = new URL('/robots.txt', url);
  let result: Awaited<ReturnType<typeof request>>;
  try {
    result = await request(robotsUrl, deps, 'text/plain', MAX_ROBOTS_BYTES);
  } catch {
    return;
  }
  if (!result.response.ok) {
    return;
  }
  const robots = robotsParser(result.url.toString(), result.body);
  if (!robots.isAllowed(url.toString(), USER_AGENT)) {
    throw new Error('Abruf ist durch robots.txt untersagt');
  }
}

function absoluteUrl(value: string | undefined, base: URL): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function extractColors(html: string): string[] {
  const matches =
    html.match(
      /#[0-9a-f]{3,8}\b|rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)/gi,
    ) ?? [];
  const colors = new Set<string>();
  for (const match of matches) {
    colors.add(match.toLowerCase());
    if (colors.size === MAX_COLORS) {
      break;
    }
  }
  return [...colors];
}

export function extractPage(html: string, url: URL): Omit<FetchedPage, 'url' | 'truncated'> {
  const $ = load(html);
  const title = $('title').first().text().trim() || undefined;
  const images: FetchedImage[] = [];
  const seenImages = new Set<string>();

  const addImage = (src: string | undefined, alt?: string): void => {
    const resolved = absoluteUrl(src, url);
    if (!resolved || seenImages.has(resolved) || images.length >= MAX_IMAGES) {
      return;
    }
    seenImages.add(resolved);
    images.push({ url: resolved, ...(alt?.trim() ? { alt: alt.trim() } : {}) });
  };

  addImage($('meta[property="og:image"]').attr('content'), 'Open-Graph-Bild');
  $('img').each((_, element) => {
    addImage($(element).attr('src') ?? $(element).attr('data-src'), $(element).attr('alt'));
  });

  $('script, style, noscript, iframe, form, svg, canvas, nav, footer').remove();
  $('a[href]').each((_, element) => {
    const resolved = absoluteUrl($(element).attr('href'), url);
    if (resolved) {
      $(element).attr('href', resolved);
    }
  });
  $('img[src]').each((_, element) => {
    const resolved = absoluteUrl($(element).attr('src'), url);
    if (resolved) {
      $(element).attr('src', resolved);
    }
  });

  const main = $('main, article, [role="main"]').first();
  const content = main.length ? main.html() : $('body').html();
  const markdown = NodeHtmlMarkdown.translate(content ?? '').trim();
  const themeColor = $('meta[name="theme-color"]').attr('content')?.trim().toLowerCase();
  const colors = extractColors(html);
  if (themeColor && !colors.includes(themeColor)) {
    colors.unshift(themeColor);
  }

  return { title, markdown, images, colors: colors.slice(0, MAX_COLORS) };
}

export async function fetchUrl(
  value: string,
  deps: FetchUrlDeps = defaultDeps,
): Promise<FetchedPage> {
  const requestedUrl = parsePublicUrl(value);
  await assertPublicDns(requestedUrl, deps);
  await assertRobotsAllowed(requestedUrl, deps);
  const result = await request(
    requestedUrl,
    deps,
    'text/html,application/xhtml+xml,text/plain;q=0.9',
    MAX_RESPONSE_BYTES,
  );
  if (!result.response.ok) {
    throw new Error(`Seite konnte nicht geladen werden (${result.response.status})`);
  }
  const contentType = result.response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    contentType &&
    !contentType.includes('text/html') &&
    !contentType.includes('application/xhtml+xml') &&
    !contentType.includes('text/plain')
  ) {
    throw new Error(`Nicht unterstützter Inhaltstyp: ${contentType.split(';')[0]}`);
  }

  if (contentType.includes('text/plain')) {
    const truncated = result.body.length > MAX_MARKDOWN_CHARS;
    return {
      url: result.url.toString(),
      markdown: result.body.slice(0, MAX_MARKDOWN_CHARS),
      images: [],
      colors: [],
      truncated,
    };
  }

  const page = extractPage(result.body, result.url);
  const truncated = page.markdown.length > MAX_MARKDOWN_CHARS;
  return {
    ...page,
    url: result.url.toString(),
    markdown: page.markdown.slice(0, MAX_MARKDOWN_CHARS),
    truncated,
  };
}
