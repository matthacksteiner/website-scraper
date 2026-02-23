import { load } from 'cheerio';
import { CapturedResponse } from './types';
import { normalizeUrl } from './url';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

export interface CapturedPage {
  html: string;
  status: number | null;
  contentType: string | null;
  responses: CapturedResponse[];
}

const isSkippable = (value: string): boolean => {
  return (
    value.startsWith('data:') ||
    value.startsWith('mailto:') ||
    value.startsWith('tel:') ||
    value.startsWith('javascript:')
  );
};

const resolveUrl = (value: string, baseUrl: string): string | null => {
  if (!value || isSkippable(value)) return null;
  try {
    return normalizeUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
};

const collectCssUrls = (
  css: string,
  cssUrl: string,
): { assets: string[]; imports: string[] } => {
  const assets = new Set<string>();
  const imports = new Set<string>();
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(css)) !== null) {
      const resolved = resolveUrl(match[2], cssUrl);
      if (resolved) assets.add(resolved);
    }
    const importUrlRegex = /@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    while ((match = importUrlRegex.exec(css)) !== null) {
      const resolved = resolveUrl(match[2], cssUrl);
      if (resolved) imports.add(resolved);
    }
    const importStringRegex = /@import\s+(['"])([^'"]+)\1/gi;
    while ((match = importStringRegex.exec(css)) !== null) {
      const resolved = resolveUrl(match[2], cssUrl);
      if (resolved) imports.add(resolved);
    }
    return { assets: Array.from(assets), imports: Array.from(imports) };
  }

  root.walkDecls((decl) => {
    const parsed = valueParser(decl.value);
    parsed.walk((node) => {
      if (node.type === 'function' && node.value === 'url') {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, '');
        const resolved = resolveUrl(cleaned, cssUrl);
        if (resolved) assets.add(resolved);
      }
      return false;
    });
  });

  root.walkAtRules('import', (rule) => {
    const parsed = valueParser(rule.params);
    parsed.walk((node) => {
      if (node.type === 'function' && node.value === 'url') {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, '');
        const resolved = resolveUrl(cleaned, cssUrl);
        if (resolved) imports.add(resolved);
        return false;
      }
      if (node.type === 'string') {
        const resolved = resolveUrl(node.value, cssUrl);
        if (resolved) imports.add(resolved);
        return false;
      }
      return false;
    });
  });

  return { assets: Array.from(assets), imports: Array.from(imports) };
};

const collectAssetUrls = (html: string, baseUrl: string): string[] => {
  const $ = load(html);
  const assets = new Set<string>();

  const addUrl = (value: string | undefined) => {
    const resolved = value ? resolveUrl(value, baseUrl) : null;
    if (resolved) assets.add(resolved);
  };

  $('link[rel="stylesheet"][href]').each((_, el) => {
    addUrl($(el).attr('href'));
  });

  $('link[rel="preload"][href], link[rel="modulepreload"][href]').each((_, el) => {
    addUrl($(el).attr('href'));
  });

  $('script[src]').each((_, el) => {
    addUrl($(el).attr('src'));
  });

  $(
    'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="mask-icon"][href]',
  ).each((_, el) => {
    addUrl($(el).attr('href'));
  });

  $('img[src], source[src], video[poster]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('poster');
    addUrl(src);
  });

  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (!srcset) return;
    srcset.split(',').forEach((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return;
      const [urlPart] = trimmed.split(/\s+/, 2);
      addUrl(urlPart);
    });
  });

  // Common lazy-loading/background image attributes.
  const lazyAttrs = [
    'data-src',
    'data-lazy',
    'data-lazy-src',
    'data-original',
    'data-bg',
    'data-bg-src',
    'data-background',
    'data-background-image',
    'data-nectar-img-src',
    'data-srcset',
    'data-lazy-srcset',
    'data-nectar-img-srcset',
  ];
  lazyAttrs.forEach((attr) => {
    const selector = `[${attr}]`;
    $(selector).each((_, el) => addUrl($(el).attr(attr)));
  });

  // Inline styles can contain url(...) references.
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (!style) return;
    const parsed = valueParser(style);
    parsed.walk((node) => {
      if (node.type === 'function' && node.value === 'url') {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, '');
        addUrl(cleaned);
      }
      return false;
    });
  });

  // <style> blocks can also contain url(...) and @import resources.
  $('style').each((_, el) => {
    const css = $(el).html() || '';
    if (!css.trim()) return;
    const discovered = collectCssUrls(css, baseUrl);
    discovered.assets.forEach((url) => assets.add(url));
    discovered.imports.forEach((url) => assets.add(url));
  });

  return Array.from(assets);
};

const fetchBinary = async (url: string, userAgent: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: '*/*',
      },
      signal: controller.signal,
    });
    const arrayBuffer = await res.arrayBuffer();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: Buffer.from(arrayBuffer),
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const captureAssetsForHtml = async (
  html: string,
  baseUrl: string,
  userAgent: string,
  timeoutMs: number,
  alreadyCaptured: Set<string> = new Set(),
): Promise<CapturedResponse[]> => {
  const assetUrls = collectAssetUrls(html, baseUrl);
  const responses: CapturedResponse[] = [];
  const seen = new Set<string>(alreadyCaptured);
  const queue: Array<{ url: string; cssDepth: number }> = assetUrls.map((assetUrl) => ({
    url: assetUrl,
    cssDepth: 0,
  }));
  const MAX_ASSETS = 500;
  const MAX_CSS_IMPORT_DEPTH = 5;

  while (queue.length > 0 && responses.length < MAX_ASSETS) {
    const item = queue.shift()!;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    try {
      const result = await fetchBinary(item.url, userAgent, timeoutMs);
      responses.push({
        url: item.url,
        status: result.status,
        contentType: result.contentType,
        body: result.body,
      });

      const contentType = (result.contentType || '').toLowerCase();
      const lowerUrl = item.url.split('?')[0].toLowerCase();
      const isCss = contentType.includes('text/css') || lowerUrl.endsWith('.css');
      if (isCss && item.cssDepth <= MAX_CSS_IMPORT_DEPTH) {
        const cssText = result.body.toString('utf8');
        const discovered = collectCssUrls(cssText, item.url);
        for (const imported of discovered.imports) {
          if (!seen.has(imported))
            queue.push({ url: imported, cssDepth: item.cssDepth + 1 });
        }
        for (const asset of discovered.assets) {
          if (!seen.has(asset)) queue.push({ url: asset, cssDepth: item.cssDepth });
        }
      }
    } catch {
      continue;
    }
  }

  return responses;
};

export const capturePageFetch = async (
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<CapturedPage> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let html = '';
  let status: number | null = null;
  let contentType: string | null = null;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    html = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const responses = await captureAssetsForHtml(html, url, userAgent, timeoutMs);

  return { html, status, contentType, responses };
};
