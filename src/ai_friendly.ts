import { createHash } from 'crypto';
import { load } from 'cheerio';
import path from 'path';
import { rewriteCss } from './rewrite';
import { normalizeUrl } from './url';

export const INLINE_STYLE_EXTRACT_MIN_BYTES = 32 * 1024;

export interface ExtractedInlineCssAsset {
  sourceUrl: string;
  relativePathFromPageDir: string;
  content: string;
  bytes: number;
}

type RewriteCssFn = (
  css: string,
  cssUrl: string,
  cssPath: string,
  resourceMap: Map<string, string>,
  responses: Map<string, { contentType: string | null; body: Buffer }>,
  singleFile?: boolean,
  importDepth?: number,
) => string;

export interface ExtractLargeInlineStylesInput {
  html: string;
  pageUrl: string;
  pagePath: string;
  minBytes?: number;
  resourceMap: Map<string, string>;
  responses: Map<string, { contentType: string | null; body: Buffer }>;
  saveCssAsset: (asset: {
    sourceUrl: string;
    relativePathFromPageDir: string;
    body: Buffer;
    contentType: string | null;
  }) => Promise<void>;
  onError?: (
    error: Error,
    context: {
      sourceUrl: string;
      relativePathFromPageDir: string;
      styleIndex: number;
      stage: 'rewrite' | 'save';
    },
  ) => void;
  rewriteCssFn?: RewriteCssFn;
}

export interface ExtractLargeInlineStylesResult {
  html: string;
  extractedAssets: ExtractedInlineCssAsset[];
}

const buildInlineStyleSourceUrl = (pageUrl: string, index: number, hash: string): string => {
  const pageHash = createHash('sha1')
    .update(normalizeUrl(pageUrl))
    .digest('hex')
    .slice(0, 12);
  return `https://inline.scrape.local/${pageHash}/inline-${index}-${hash}.css`;
};

const shouldSkipStyleExtraction = (el: any): boolean => {
  if (el.attr('data-scrape-consent-hide') !== undefined) return true;
  if (el.attr('data-scrape-slider-fallback') !== undefined) return true;
  return false;
};

export const extractLargeInlineStyles = async (
  input: ExtractLargeInlineStylesInput,
): Promise<ExtractLargeInlineStylesResult> => {
  const $ = load(input.html);
  const minBytes = input.minBytes ?? INLINE_STYLE_EXTRACT_MIN_BYTES;
  const rewriteCssFn = input.rewriteCssFn ?? rewriteCss;
  const extractedAssets: ExtractedInlineCssAsset[] = [];

  let extractedIndex = 0;
  const styleElements = $('style').toArray();
  for (const element of styleElements) {
    const el = $(element);
    if (shouldSkipStyleExtraction(el)) continue;

    const css = el.html() ?? '';
    if (!css.trim()) continue;

    const cssBytes = Buffer.byteLength(css, 'utf8');
    if (cssBytes < minBytes) continue;

    const nextIndex = extractedIndex + 1;
    const hash = createHash('sha1').update(css).digest('hex').slice(0, 12);
    const relativePathFromPageDir = `assets/css/inline/inline-${nextIndex}-${hash}.css`;
    const cssPath = path.join(path.dirname(input.pagePath), relativePathFromPageDir);
    const sourceUrl = buildInlineStyleSourceUrl(input.pageUrl, nextIndex, hash);

    let rewrittenCss = '';
    try {
      rewrittenCss = rewriteCssFn(
        css,
        input.pageUrl,
        cssPath,
        input.resourceMap,
        input.responses,
        false,
      );
    } catch (error) {
      input.onError?.((error as Error) ?? new Error('Unknown rewrite error'), {
        sourceUrl,
        relativePathFromPageDir,
        styleIndex: nextIndex,
        stage: 'rewrite',
      });
      continue;
    }

    try {
      await input.saveCssAsset({
        sourceUrl,
        relativePathFromPageDir,
        body: Buffer.from(rewrittenCss, 'utf8'),
        contentType: 'text/css',
      });
    } catch (error) {
      input.onError?.((error as Error) ?? new Error('Unknown save error'), {
        sourceUrl,
        relativePathFromPageDir,
        styleIndex: nextIndex,
        stage: 'save',
      });
      continue;
    }

    const link = $('<link rel="stylesheet" data-scrape-inline-css="true" />');
    link.attr('href', sourceUrl);
    el.replaceWith(link);

    extractedAssets.push({
      sourceUrl,
      relativePathFromPageDir,
      content: rewrittenCss,
      bytes: cssBytes,
    });
    extractedIndex = nextIndex;
  }

  return {
    html: $.html(),
    extractedAssets,
  };
};
