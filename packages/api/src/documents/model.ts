export type Alignment = 'left' | 'center' | 'right' | 'justify';
export type PageSizeName = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';
export type ImageFormat = 'png' | 'jpg';
export type CellValue = string | number | boolean | null;

export interface DocumentLayout {
  pageSize?: PageSizeName;
  orientation?: Orientation;
  marginsMm?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
  header?: string;
  footer?: string;
  backgroundColor?: string;
  defaultFont?: string;
  defaultFontSize?: number;
  defaultColor?: string;
  accentColor?: string;
  hideTitle?: boolean;
}

export interface TextStyle {
  font?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3;
  text: string;
  align?: Alignment;
  style?: TextStyle;
}

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
  align?: Alignment;
  style?: TextStyle;
}

export interface ListBlock {
  type: 'list';
  items: string[];
  ordered?: boolean;
  style?: TextStyle;
}

export interface TableBlock {
  type: 'table';
  headers?: string[];
  rows: string[][];
}

export interface ImageBlock {
  type: 'image';
  src: string;
  alt?: string;
  widthMm?: number;
  align?: Alignment;
}

export interface SpacerBlock {
  type: 'spacer';
  heightMm?: number;
}

export interface RuleBlock {
  type: 'rule';
}

export type ContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | ImageBlock
  | SpacerBlock
  | RuleBlock;

export interface SheetInput {
  name: string;
  rows: CellValue[][];
  headerFill?: string;
  headerColor?: string;
}

export interface DocumentInput {
  title: string;
  content?: string;
  layout?: DocumentLayout;
  blocks?: ContentBlock[];
}

export interface ResolvedLayout {
  pageSize: PageSizeName;
  orientation: Orientation;
  marginsMm: { top: number; right: number; bottom: number; left: number };
  header: string;
  footer: string;
  backgroundColor: string | null;
  defaultFont: string;
  defaultFontSize: number;
  defaultColor: string;
  accentColor: string;
  hideTitle: boolean;
}

export interface PreparedImage {
  data: Buffer;
  format: ImageFormat;
  widthMm: number;
  heightMm: number;
  alt: string;
  align: Alignment;
}

const PAGE_SIZES_MM: Record<PageSizeName, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 216, height: 279 },
};

export function pageSizeMm(layout: ResolvedLayout): { width: number; height: number } {
  const size = PAGE_SIZES_MM[layout.pageSize];
  if (layout.orientation === 'landscape') {
    return { width: size.height, height: size.width };
  }
  return size;
}

export function clampMm(value: number | undefined, fallback: number, max = 80): number {
  if (value == null || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 0), max);
}

export function normalizeHex(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) {
    return fallback;
  }
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  return `#${hex.toLowerCase()}`;
}

export function hexForDocx(value: string): string {
  return value.replace('#', '').toUpperCase();
}

export function resolveLayout(layout: DocumentLayout | undefined): ResolvedLayout {
  const margins = layout?.marginsMm ?? {};
  return {
    pageSize: layout?.pageSize === 'Letter' ? 'Letter' : 'A4',
    orientation: layout?.orientation === 'landscape' ? 'landscape' : 'portrait',
    marginsMm: {
      top: clampMm(margins.top, 20, 80),
      right: clampMm(margins.right, 18, 80),
      bottom: clampMm(margins.bottom, 20, 80),
      left: clampMm(margins.left, 18, 80),
    },
    header: layout?.header?.trim() ?? '',
    footer: layout?.footer?.trim() ?? '',
    backgroundColor: layout?.backgroundColor
      ? normalizeHex(layout.backgroundColor, '#ffffff')
      : null,
    defaultFont: layout?.defaultFont?.trim() || 'Calibri',
    defaultFontSize: clampMm(layout?.defaultFontSize, 11, 36),
    defaultColor: normalizeHex(layout?.defaultColor, '#111111'),
    accentColor: normalizeHex(layout?.accentColor, '#1f4e79'),
    hideTitle: layout?.hideTitle === true,
  };
}

export function parseMarkdownBlocks(content: string): ContentBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: ContentBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(trimmed);
    if (image) {
      blocks.push({ type: 'image', alt: image[1], src: image[2].trim() });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'rule' });
      continue;
    }

    if (trimmed.includes('|')) {
      const tableLines = [trimmed];
      while (index + 1 < lines.length && lines[index + 1].trim().includes('|')) {
        index += 1;
        tableLines.push(lines[index].trim());
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        blocks.push(table);
        continue;
      }
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items = [trimmed.replace(/^([-*]|\d+\.)\s+/, '')];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].trim();
        const nextOrdered = /^\d+\.\s+/.test(next);
        const nextBullet = /^[-*]\s+/.test(next);
        if ((ordered && nextOrdered) || (!ordered && nextBullet)) {
          index += 1;
          items.push(next.replace(/^([-*]|\d+\.)\s+/, ''));
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    blocks.push({ type: 'paragraph', text: trimmed });
  }

  return blocks;
}

function parseMarkdownTable(lines: string[]): TableBlock | null {
  const rows = lines
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return { type: 'table', rows };
  }
  return { type: 'table', headers: rows[0], rows: rows.slice(1) };
}

export function resolveBlocks(input: DocumentInput): ContentBlock[] {
  if (input.blocks && input.blocks.length > 0) {
    return input.blocks;
  }
  return parseMarkdownBlocks(input.content ?? '');
}

export function mapPdfFont(font: string, style: TextStyle | undefined): string {
  const family = font.toLowerCase();
  const bold = style?.bold === true;
  const italic = style?.italic === true;
  const serif = family.includes('times') || family.includes('georgia') || family.includes('serif');
  const mono = family.includes('courier') || family.includes('mono') || family.includes('consolas');

  if (serif) {
    if (bold && italic) {
      return 'Times-BoldItalic';
    }
    if (bold) {
      return 'Times-Bold';
    }
    if (italic) {
      return 'Times-Italic';
    }
    return 'Times-Roman';
  }
  if (mono) {
    if (bold) {
      return 'Courier-Bold';
    }
    if (italic) {
      return 'Courier-Oblique';
    }
    return 'Courier';
  }
  if (bold && italic) {
    return 'Helvetica-BoldOblique';
  }
  if (bold) {
    return 'Helvetica-Bold';
  }
  if (italic) {
    return 'Helvetica-Oblique';
  }
  return 'Helvetica';
}

export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

export function mmToPx(mm: number): number {
  return Math.round((mm * 96) / 25.4);
}
