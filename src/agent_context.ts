import path from 'path';
import { load } from 'cheerio';

const toPosix = (value: string): string => value.split(path.sep).join('/');

export interface AgentPageContext {
  url: string;
  path: string;
  depth: number;
  status: number | null;
  contentType: string | null;
  title: string | null;
  headings: string[];
  htmlBytes: number;
  elements: number;
  stylesheets: number;
  cssFiles: string[];
  images: number;
  scripts: number;
}

export interface AgentContextDocument {
  generatedAt: string;
  sourceUrl: string;
  rootPage: string;
  totals: {
    pages: number;
    htmlBytes: number;
    elements: number;
    stylesheets: number;
    images: number;
    scripts: number;
  };
  pages: AgentPageContext[];
}

export interface BuildAgentPageContextInput {
  outputDir: string;
  url: string;
  pagePath: string;
  depth: number;
  status: number | null;
  contentType: string | null;
  html: string;
}

const normalizeText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const splitRefAndSuffix = (value: string): string => {
  const hashIdx = value.indexOf('#');
  const queryIdx = value.indexOf('?');
  let cut = -1;
  if (hashIdx !== -1 && queryIdx !== -1) cut = Math.min(hashIdx, queryIdx);
  else cut = Math.max(hashIdx, queryIdx);
  return cut === -1 ? value : value.slice(0, cut);
};

const uniqueLimit = (values: string[], max: number): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
};

export const buildAgentPageContext = (
  input: BuildAgentPageContextInput,
): AgentPageContext => {
  const $ = load(input.html);
  const title = normalizeText($('title').first().text() || '');
  const headings = uniqueLimit(
    $('h1,h2,h3')
      .toArray()
      .map((element) => normalizeText($(element).text() || ''))
      .filter(Boolean),
    6,
  );
  const cssFiles = uniqueLimit(
    $('link[rel~="stylesheet"][href]')
      .toArray()
      .map((element) => String($(element).attr('href') || '').trim())
      .filter(Boolean)
      .map(splitRefAndSuffix)
      .filter((href) => {
        if (!href) return false;
        if (href.startsWith('http://') || href.startsWith('https://')) return false;
        if (href.startsWith('//')) return false;
        if (href.startsWith('data:')) return false;
        return true;
      })
      .map((href) => {
        if (href.startsWith('/')) {
          return toPosix(path.resolve(input.outputDir, `.${href}`));
        }
        return toPosix(path.resolve(path.dirname(input.pagePath), href));
      })
      .map((absolute) => toPosix(path.relative(input.outputDir, absolute))),
    12,
  );

  return {
    url: input.url,
    path: toPosix(path.relative(input.outputDir, input.pagePath)),
    depth: input.depth,
    status: input.status,
    contentType: input.contentType,
    title: title || null,
    headings,
    htmlBytes: Buffer.byteLength(input.html, 'utf8'),
    elements: $('*').length,
    stylesheets: $('link[rel~="stylesheet"][href], style').length,
    cssFiles,
    images: $('img[src], picture source[srcset], svg image').length,
    scripts: $('script').length,
  };
};

export const buildAgentContextDocument = (
  sourceUrl: string,
  rootPagePath: string,
  pages: AgentPageContext[],
): AgentContextDocument => {
  const sorted = [...pages].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });

  const totals = sorted.reduce(
    (acc, page) => {
      acc.pages += 1;
      acc.htmlBytes += page.htmlBytes;
      acc.elements += page.elements;
      acc.stylesheets += page.stylesheets;
      acc.images += page.images;
      acc.scripts += page.scripts;
      return acc;
    },
    {
      pages: 0,
      htmlBytes: 0,
      elements: 0,
      stylesheets: 0,
      images: 0,
      scripts: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    sourceUrl,
    rootPage: rootPagePath,
    totals,
    pages: sorted,
  };
};

export const renderAgentContextMarkdown = (doc: AgentContextDocument): string => {
  const lines: string[] = [];
  lines.push('# Agent Context');
  lines.push('');
  lines.push(`- Source URL: ${doc.sourceUrl}`);
  lines.push(`- Generated: ${doc.generatedAt}`);
  lines.push(`- Root page: ${doc.rootPage}`);
  lines.push(`- Pages: ${doc.totals.pages}`);
  lines.push(`- Total HTML bytes: ${doc.totals.htmlBytes}`);
  lines.push('');
  lines.push('## Start Here');
  lines.push('');
  lines.push('1. Open root page HTML first.');
  lines.push('2. Use `pages[]` in `agent/context.json` to jump directly to relevant subpages.');
  lines.push('3. Avoid reading `scrape-log.jsonl` unless debugging capture issues.');
  lines.push('');
  lines.push('## Page Index');
  lines.push('');

  for (const page of doc.pages) {
    const title = page.title || '(untitled)';
    const headingPreview = page.headings.slice(0, 2).join(' | ') || '-';
    const cssPreview = page.cssFiles.slice(0, 2).join(' | ') || '-';
    lines.push(
      `- depth ${page.depth} | ${page.path} | ${title} | h: ${headingPreview} | css: ${cssPreview}`,
    );
  }

  lines.push('');
  return lines.join('\n');
};
