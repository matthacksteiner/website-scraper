import { createHash } from 'crypto';
import { describe, expect, it } from 'bun:test';
import { load } from 'cheerio';
import {
  extractLargeInlineStyles,
  INLINE_STYLE_EXTRACT_MIN_BYTES,
} from '../src/ai_friendly';

describe('extractLargeInlineStyles', () => {
  it('keeps style tags below threshold untouched', async () => {
    const html = '<html><head><style id="small">.x{color:red;}</style></head></html>';
    let saveCalls = 0;

    const result = await extractLargeInlineStyles({
      html,
      pageUrl: 'https://example.com/page',
      pagePath: '/tmp/page/index.html',
      minBytes: INLINE_STYLE_EXTRACT_MIN_BYTES,
      resourceMap: new Map(),
      responses: new Map(),
      saveCssAsset: async () => {
        saveCalls += 1;
      },
    });

    expect(saveCalls).toBe(0);
    expect(result.extractedAssets.length).toBe(0);

    const $ = load(result.html);
    expect($('style#small').length).toBe(1);
    expect($('link[data-scrape-inline-css="true"]').length).toBe(0);
  });

  it('extracts large inline styles in-place with deterministic names', async () => {
    const largeCss1 = '.a{color:#123456;} '.repeat(2400);
    const largeCss2 = '.b{background:#ffffff;} '.repeat(2400);
    const html = `<html><head><style id="s1">${largeCss1}</style><style id="small">.x{color:red;}</style><style id="s2">${largeCss2}</style></head></html>`;

    const saved: Array<{ sourceUrl: string; relativePathFromPageDir: string; body: Buffer }> = [];

    const result = await extractLargeInlineStyles({
      html,
      pageUrl: 'https://example.com/page',
      pagePath: '/tmp/page/index.html',
      minBytes: 1024,
      resourceMap: new Map(),
      responses: new Map(),
      saveCssAsset: async (asset) => {
        saved.push({
          sourceUrl: asset.sourceUrl,
          relativePathFromPageDir: asset.relativePathFromPageDir,
          body: asset.body,
        });
      },
    });

    expect(saved.length).toBe(2);
    expect(result.extractedAssets.length).toBe(2);

    const hash1 = createHash('sha1').update(largeCss1).digest('hex').slice(0, 12);
    const hash2 = createHash('sha1').update(largeCss2).digest('hex').slice(0, 12);

    expect(saved[0].relativePathFromPageDir).toBe(`assets/css/inline/inline-1-${hash1}.css`);
    expect(saved[1].relativePathFromPageDir).toBe(`assets/css/inline/inline-2-${hash2}.css`);
    expect(saved[0].sourceUrl).toContain(`/inline-1-${hash1}.css`);
    expect(saved[1].sourceUrl).toContain(`/inline-2-${hash2}.css`);

    const $ = load(result.html);
    const headChildren = $('head')
      .children()
      .toArray()
      .map((node) => node.tagName);
    expect(headChildren).toEqual(['link', 'style', 'link']);
    expect($('style#small').length).toBe(1);
    expect($('link[data-scrape-inline-css="true"]').length).toBe(2);
  });

  it('keeps original style when css rewrite fails', async () => {
    const largeCss = '.a{color:#123456;} '.repeat(2400);
    const html = `<html><head><style id="broken">${largeCss}</style></head></html>`;
    let saveCalls = 0;
    const errors: Array<{ stage: 'rewrite' | 'save'; message: string }> = [];

    const result = await extractLargeInlineStyles({
      html,
      pageUrl: 'https://example.com/page',
      pagePath: '/tmp/page/index.html',
      minBytes: 1024,
      resourceMap: new Map(),
      responses: new Map(),
      rewriteCssFn: () => {
        throw new Error('rewrite failed');
      },
      saveCssAsset: async () => {
        saveCalls += 1;
      },
      onError: (error, context) => {
        errors.push({ stage: context.stage, message: error.message });
      },
    });

    expect(saveCalls).toBe(0);
    expect(result.extractedAssets.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].stage).toBe('rewrite');

    const $ = load(result.html);
    expect($('style#broken').length).toBe(1);
    expect($('link[data-scrape-inline-css="true"]').length).toBe(0);
  });
});
