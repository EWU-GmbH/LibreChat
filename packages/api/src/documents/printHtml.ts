import type {
  Alignment,
  ContentBlock,
  DocumentInput,
  PreparedImage,
  ResolvedLayout,
} from './model';
import { loadBlockImages } from './images';
import { pageSizeMm, resolveBlocks, resolveLayout } from './model';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function inlineMarkup(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
}

function alignClass(align: Alignment | undefined): string {
  if (!align || align === 'left') {
    return '';
  }
  return ` align-${align}`;
}

function cssLength(style?: { font?: string; size?: number; color?: string }): string {
  if (!style) {
    return '';
  }
  const parts: string[] = [];
  if (style.font) {
    parts.push(`font-family:${escapeHtml(style.font)}`);
  }
  if (style.size) {
    parts.push(`font-size:${style.size}pt`);
  }
  if (style.color) {
    parts.push(`color:${escapeHtml(style.color)}`);
  }
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

function renderBlock(block: ContentBlock, image: PreparedImage | undefined): string {
  if (block.type === 'heading') {
    return `<h${block.level} class="${alignClass(block.align).trim()}"${cssLength(block.style)}>${inlineMarkup(block.text)}</h${block.level}>`;
  }
  if (block.type === 'paragraph') {
    return `<p class="${alignClass(block.align).trim()}"${cssLength(block.style)}>${inlineMarkup(block.text)}</p>`;
  }
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul';
    const items = block.items
      .map((item) => `<li${cssLength(block.style)}>${inlineMarkup(item)}</li>`)
      .join('');
    return `<${tag}>${items}</${tag}>`;
  }
  if (block.type === 'checklist') {
    const items = block.items
      .map((item, index) => {
        const done = block.checked?.[index] === true;
        return `<li class="${done ? 'is-checked' : ''}"><span class="box" aria-hidden="true"></span>${inlineMarkup(item)}</li>`;
      })
      .join('');
    return `<ul class="checklist">${items}</ul>`;
  }
  if (block.type === 'table') {
    const columns = Math.max(block.headers?.length ?? 0, block.rows[0]?.length ?? 1, 1);
    const head =
      block.headers && block.headers.length
        ? `<thead><tr>${block.headers.map((header) => `<th>${inlineMarkup(header)}</th>`).join('')}</tr></thead>`
        : '';
    const body = block.rows
      .map((row) => {
        const cells = Array.from({ length: columns }, (_, index) => row[index] ?? '');
        return `<tr>${cells.map((cell) => `<td>${inlineMarkup(cell)}</td>`).join('')}</tr>`;
      })
      .join('');
    return `<table><colgroup>${Array.from({ length: columns }, () => '<col>').join('')}</colgroup>${head}<tbody>${body}</tbody></table>`;
  }
  if (block.type === 'image') {
    if (!image) {
      return `<p class="missing-image">[Bild fehlt: ${escapeHtml(block.alt ?? '')}]</p>`;
    }
    const caption = block.caption?.trim() || image.caption;
    const captionHtml = caption ? `<figcaption>${inlineMarkup(caption)}</figcaption>` : '';
    return `<figure class="doc-figure${alignClass(image.align)}"><img src="${image.dataUri}" alt="${escapeHtml(image.alt)}" style="width:${image.widthMm}mm" />${captionHtml}</figure>`;
  }
  if (block.type === 'callout') {
    const title = block.title?.trim()
      ? `<p class="callout-title">${inlineMarkup(block.title)}</p>`
      : '';
    return `<aside class="callout">${title}<p>${inlineMarkup(block.text)}</p></aside>`;
  }
  if (block.type === 'pageBreak') {
    return '<div class="page-break"></div>';
  }
  if (block.type === 'spacer') {
    const height = Math.min(Math.max(block.heightMm ?? 6, 1), 40);
    return `<div class="spacer" style="height:${height}mm"></div>`;
  }
  return '<hr />';
}

function printCss(layout: ResolvedLayout): string {
  const page = pageSizeMm(layout);
  const header = escapeCssString(layout.header);
  const footer = escapeCssString(layout.footer);
  const radius = layout.theme === 'plain' ? '0' : '6px';
  return `
@page {
  size: ${page.width}mm ${page.height}mm;
  margin: ${layout.marginsMm.top}mm ${layout.marginsMm.right}mm ${layout.marginsMm.bottom}mm ${layout.marginsMm.left}mm;
  @top-left { content: "${header}"; font-size: 9pt; color: #666666; }
  @bottom-left { content: "${footer}"; font-size: 9pt; color: #666666; }
  @bottom-right { content: "Seite " counter(page); font-size: 9pt; color: #666666; }
}
html { background: ${layout.backgroundColor ?? '#ffffff'}; }
body {
  margin: 0;
  color: ${layout.defaultColor};
  font-family: ${layout.defaultFont}, Calibri, "Segoe UI", sans-serif;
  font-size: ${layout.defaultFontSize}pt;
  line-height: 1.45;
  hyphens: auto;
  hyphenate-limit-chars: 6 3 3;
}
.doc-title {
  color: ${layout.accentColor};
  font-size: 22pt;
  font-weight: 700;
  margin: 0 0 8pt;
  padding-bottom: 8pt;
  border-bottom: 2px solid ${layout.accentColor};
}
.doc-subtitle { color: #444444; font-size: 12pt; margin: 0 0 16pt; }
h1, h2, h3 { color: ${layout.accentColor}; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 16pt; margin: 18pt 0 8pt; }
h2 { font-size: 13pt; margin: 14pt 0 6pt; }
h3 { font-size: 12pt; margin: 12pt 0 6pt; }
p { margin: 0 0 8pt; }
.align-center { text-align: center; }
.align-right { text-align: right; }
.align-justify { text-align: justify; }
ul, ol { margin: 0 0 10pt; padding-left: 18pt; }
li { margin: 0 0 3pt; }
.checklist { list-style: none; padding-left: 4pt; }
.checklist li { padding-left: 16pt; text-indent: -16pt; }
.checklist .box {
  display: inline-block;
  position: relative;
  width: 9pt;
  height: 9pt;
  margin-right: 7pt;
  border: 1pt solid ${layout.accentColor};
  border-radius: 1.5pt;
  text-indent: 0;
  vertical-align: -1pt;
}
.checklist .is-checked .box::after {
  content: "";
  position: absolute;
  left: 2.6pt;
  top: 0.2pt;
  width: 2.6pt;
  height: 5.6pt;
  border: solid ${layout.accentColor};
  border-width: 0 1.6pt 1.6pt 0;
  transform: rotate(45deg);
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
  margin: 0 0 12pt;
  break-inside: auto;
}
thead { display: table-header-group; }
th, td {
  border: 1px solid #c5cdd6;
  padding: 6pt 8pt;
  vertical-align: top;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
th { background: ${layout.accentColor}; color: #ffffff; font-weight: 700; text-align: left; }
tbody tr:nth-child(even) td { background: #f6f8fb; }
.doc-figure { margin: 10pt 0 14pt; break-inside: avoid; page-break-inside: avoid; }
.doc-figure img { max-width: 100%; height: auto; display: block; }
.doc-figure.align-center { margin-left: auto; margin-right: auto; }
.doc-figure figcaption { font-size: 9pt; color: #555555; margin-top: 4pt; }
.callout {
  border-left: 4px solid ${layout.accentColor};
  background: #f4f7fb;
  padding: 10pt 12pt;
  margin: 10pt 0 14pt;
  border-radius: ${radius};
  break-inside: avoid;
}
.callout-title { font-weight: 700; color: ${layout.accentColor}; margin: 0 0 4pt; }
.page-break { break-before: page; page-break-before: always; }
hr { border: 0; border-top: 1px solid ${layout.accentColor}; margin: 12pt 0; }
`.trim();
}

export async function renderPrintHtml(input: DocumentInput): Promise<string> {
  const layout = resolveLayout(input.layout);
  const blocks = resolveBlocks(input);
  const images = await loadBlockImages(blocks);
  const body = blocks.map((block, index) => renderBlock(block, images.get(index))).join('\n');
  const title = layout.hideTitle ? '' : `<h1 class="doc-title">${inlineMarkup(input.title)}</h1>`;
  const subtitle = layout.subtitle
    ? `<p class="doc-subtitle">${inlineMarkup(layout.subtitle)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="de" data-page-size="${layout.pageSize}" data-orientation="${layout.orientation}" data-font="${escapeHtml(layout.defaultFont)}" data-font-size="${layout.defaultFontSize}" data-color="${layout.defaultColor}" data-accent="${layout.accentColor}" data-header="${escapeHtml(layout.header)}" data-footer="${escapeHtml(layout.footer)}" data-title="${escapeHtml(input.title)}" data-margin-top="${layout.marginsMm.top}" data-margin-right="${layout.marginsMm.right}" data-margin-bottom="${layout.marginsMm.bottom}" data-margin-left="${layout.marginsMm.left}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.title)}</title>
<style>
${printCss(layout)}
</style>
</head>
<body>
<article>
${title}
${subtitle}
${body}
</article>
</body>
</html>`;
}
