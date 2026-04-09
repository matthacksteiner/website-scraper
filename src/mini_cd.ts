import { load } from 'cheerio';
import postcss, { AtRule, Declaration, Node, Rule } from 'postcss';
import { ComputedStyleSnapshot } from './types';

export interface CountItem {
  value: string;
  count: number;
}

export interface HeadingTokenReport {
  heading: string;
  breakpoint: string;
  fontFamilies: CountItem[];
  fontSizes: CountItem[];
  fontWeights: CountItem[];
  lineHeights: CountItem[];
}

interface SelectorStats {
  styleRules: number;
  selectors: number;
  typeSelectors: number;
  idSelectors: number;
  classSelectors: number;
  attributeSelectors: number;
  pseudoSelectors: number;
}

interface HtmlStats {
  pages: number;
  elements: number;
  externalStylesheets: number;
  inlineStyleElements: number;
  inlineStyleAttributes: number;
}

export interface CdBrandingAssets {
  faviconHref?: string | null;
  logoHref?: string | null;
}

export interface MiniCdReport {
  sourceUrl: string;
  generatedAt: string;
  stats: {
    html: HtmlStats;
    selectors: SelectorStats;
  };
  colors: {
    all: CountItem[];
    text: CountItem[];
    background: CountItem[];
    border: CountItem[];
    fill: CountItem[];
    other: CountItem[];
  };
  fonts: {
    all: CountItem[];
    brand: CountItem[];
    generic: CountItem[];
  };
  typography: {
    fontSizes: CountItem[];
    fontWeights: CountItem[];
    lineHeights: CountItem[];
  };
  layout: {
    spacing: CountItem[];
    borderRadius: CountItem[];
  };
  media: {
    queries: CountItem[];
    breakpoints: CountItem[];
  };
  headings: HeadingTokenReport[];
  totals: {
    uniqueColors: number;
    uniqueFonts: number;
    uniqueFontSizes: number;
    uniqueFontWeights: number;
    uniqueLineHeights: number;
    uniqueSpacingValues: number;
    uniqueBorderRadiusValues: number;
    mediaQueries: number;
    breakpoints: number;
  };
}

type HeadingTokenMaps = {
  fontFamilies: Map<string, number>;
  fontSizes: Map<string, number>;
  fontWeights: Map<string, number>;
  lineHeights: Map<string, number>;
};

const COLOR_TOKEN_REGEX =
  /#(?:[\da-fA-F]{3,4}|[\da-fA-F]{6}|[\da-fA-F]{8})\b|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([^)]*\)/g;
const URL_REGEX = /url\([^)]*\)/gi;
const LENGTH_TOKEN_REGEX =
  /-?(?:\d+|\d*\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|pt|pc|in|cm|mm|%)?/gi;
const FONT_SHORTHAND_REGEX =
  /(?:^|\s)(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|-?(?:\d+|\d*\.\d+)(?:px|pt|pc|in|cm|mm|em|rem|ex|ch|vw|vh|vmin|vmax|%))(?:\s*\/\s*([^\s,]+))?\s+(.+)$/i;
const FONT_WEIGHT_REGEX = /\b(?:[1-9]00|normal|bold|bolder|lighter)\b/gi;
const HEADING_SELECTOR_REGEX =
  /(?:^|[\s>+~,(])h([1-6])(?=[\s>+~.#:[,(]|$)/gi;

const SPACING_PROPS = new Set([
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'gap',
  'row-gap',
  'column-gap',
  'inset',
  'inset-inline',
  'inset-inline-start',
  'inset-inline-end',
  'inset-block',
  'inset-block-start',
  'inset-block-end',
  'top',
  'right',
  'bottom',
  'left',
]);

const RADIUS_PROPS = new Set([
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
]);

const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'helvetica',
  'arial',
  'ui system',
]);

const EXCLUDED_FONT_FAMILY_PATTERNS = [
  /^fontawesome/i,
  /^font awesome/i,
  /^material icons/i,
  /^icons?$/i,
  /^webdings$/i,
  /^wingdings$/i,
];

const HEADING_ORDER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

const normalizeHex = (value: string): string => {
  const lower = value.toLowerCase();
  if (lower.length === 4 || lower.length === 5) {
    const chars = lower.slice(1).split('');
    return `#${chars.map((char) => `${char}${char}`).join('')}`;
  }
  return lower;
};

const normalizeColorToken = (value: string): string | null => {
  const compact = value.replace(/\s+/g, '').toLowerCase();
  if (compact.includes('var(')) return null;
  if (compact.startsWith('#')) return normalizeHex(compact);
  return compact;
};

const normalizeLengthToken = (value: string): string => {
  const compact = value.replace(/\s+/g, '').toLowerCase();
  if (/^-?0(?:\.0+)?(?:[a-z%]+)?$/i.test(compact)) return '0';
  return compact;
};

const normalizeFontWeightToken = (value: string): string => {
  return value.replace(/\s+/g, '').toLowerCase();
};

const sanitizeFontFamily = (value: string): string | null => {
  let cleaned = value.trim();
  cleaned = cleaned.replace(/^['"]+|['"]+$/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ');
  if (!cleaned) return null;
  if (/^var\(/i.test(cleaned)) return null;
  const lower = cleaned.toLowerCase();
  if (
    lower === 'inherit' ||
    lower === 'initial' ||
    lower === 'unset' ||
    lower === 'revert'
  ) {
    return null;
  }
  if (lower === 'times' || lower === 'times new roman') return 'serif';
  if (EXCLUDED_FONT_FAMILY_PATTERNS.some((pattern) => pattern.test(cleaned))) return null;
  return cleaned;
};

const headingSortIndex = (heading: string): number => {
  const index = HEADING_ORDER.indexOf(heading as (typeof HEADING_ORDER)[number]);
  return index === -1 ? 99 : index;
};

const breakpointNumericValue = (value: string): number => {
  if (value === 'base') return -1;

  const viewportMatch = value.match(/viewport\s*<=\s*([0-9]*\.?[0-9]+)px/i);
  if (viewportMatch) return parseFloat(viewportMatch[1]);

  const widthMatch = value.match(
    /(max|min)-width\s*:?\s*([0-9]*\.?[0-9]+)\s*(px|em|rem)?/i,
  );
  if (widthMatch) {
    const number = parseFloat(widthMatch[2]);
    const unit = (widthMatch[3] || 'px').toLowerCase();
    if (unit === 'px') return number;
    return number * 16;
  }

  return Number.POSITIVE_INFINITY;
};

const sortCountItems = (items: CountItem[]): CountItem[] => {
  return items.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

const splitSelectors = (value: string): string[] => {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
};

const countMatches = (value: string, regex: RegExp): number => {
  const matches = value.match(regex);
  return matches ? matches.length : 0;
};

const extractHeadingsFromSelector = (selector: string): string[] => {
  const result = new Set<string>();
  for (const match of selector.toLowerCase().matchAll(HEADING_SELECTOR_REGEX)) {
    result.add(`h${match[1]}`);
  }
  return Array.from(result);
};

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const textColorForBackground = (value: string): string => {
  const lower = value.toLowerCase();
  const hexMatch = lower.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) return '#111';
  const hex = hexMatch[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.58 ? '#111' : '#fff';
};

export class MiniCdCollector {
  private colorAll = new Map<string, number>();
  private colorText = new Map<string, number>();
  private colorBackground = new Map<string, number>();
  private colorBorder = new Map<string, number>();
  private colorFill = new Map<string, number>();
  private colorOther = new Map<string, number>();
  private fontSizes = new Map<string, number>();
  private fontWeights = new Map<string, number>();
  private lineHeights = new Map<string, number>();
  private spacing = new Map<string, number>();
  private borderRadius = new Map<string, number>();
  private fontFamilies = new Map<string, { label: string; count: number }>();
  private mediaQueries = new Map<string, number>();
  private breakpoints = new Map<string, number>();
  private headings = new Map<string, Map<string, HeadingTokenMaps>>();
  private hasComputedSnapshot = false;

  private htmlStats: HtmlStats = {
    pages: 0,
    elements: 0,
    externalStylesheets: 0,
    inlineStyleElements: 0,
    inlineStyleAttributes: 0,
  };

  private selectorStats: SelectorStats = {
    styleRules: 0,
    selectors: 0,
    typeSelectors: 0,
    idSelectors: 0,
    classSelectors: 0,
    attributeSelectors: 0,
    pseudoSelectors: 0,
  };

  addCss(css: string): void {
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      return;
    }

    root.walkAtRules('media', (atRule) => {
      const query = atRule.params.trim() || 'unknown';
      this.bump(this.mediaQueries, query);
      this.extractBreakpoints(query);
    });

    const collectDeclarations = !this.hasComputedSnapshot;
    root.walkRules((rule) => {
      this.selectorStats.styleRules += 1;
      this.consumeRule(rule, collectDeclarations);
    });
  }

  addHtml(html: string): void {
    if (this.hasComputedSnapshot) return;

    const $ = load(html);

    this.htmlStats.pages += 1;
    this.htmlStats.elements += $('*').length;
    this.htmlStats.externalStylesheets += $('link[rel~="stylesheet"][href]').length;
    this.htmlStats.inlineStyleElements += $('style').length;
    this.htmlStats.inlineStyleAttributes += $('[style]').length;

    $('style').each((_, element) => {
      const css = $(element).html() || '';
      if (!css.trim()) return;
      this.addCss(css);
    });

    $('[style]').each((_, element) => {
      const style = $(element).attr('style');
      if (!style || !style.trim()) return;
      this.addInlineStyle(style);
    });
  }

  addComputedSnapshot(snapshot: ComputedStyleSnapshot): void {
    this.hasComputedSnapshot = true;

    this.htmlStats.pages += 1;
    this.htmlStats.elements += snapshot.html.elements;
    this.htmlStats.externalStylesheets += snapshot.html.externalStylesheets;
    this.htmlStats.inlineStyleElements += snapshot.html.inlineStyleElements;
    this.htmlStats.inlineStyleAttributes += snapshot.html.inlineStyleAttributes;

    this.mergeColorRecord(snapshot.used.colors.text, this.colorText);
    this.mergeColorRecord(snapshot.used.colors.background, this.colorBackground);
    this.mergeColorRecord(snapshot.used.colors.border, this.colorBorder);
    this.mergeColorRecord(snapshot.used.colors.fill, this.colorFill);

    this.mergeRecordIntoMap(snapshot.used.typography.fontSizes, this.fontSizes, (value) =>
      normalizeLengthToken(value),
    );
    this.mergeRecordIntoMap(snapshot.used.typography.fontWeights, this.fontWeights, (value) =>
      normalizeFontWeightToken(value),
    );
    this.mergeRecordIntoMap(
      snapshot.used.typography.lineHeights,
      this.lineHeights,
      (value) => normalizeLengthToken(value),
    );
    this.mergeRecordIntoMap(snapshot.used.layout.spacing, this.spacing, (value) =>
      normalizeLengthToken(value),
    );
    this.mergeRecordIntoMap(snapshot.used.layout.borderRadius, this.borderRadius, (value) =>
      normalizeLengthToken(value),
    );

    for (const [rawFamily, count] of Object.entries(
      snapshot.used.typography.fontFamilies || {},
    )) {
      this.addFontFamilyWithCount(rawFamily, count);
    }

    for (const headingSnapshot of snapshot.headings || []) {
      const bucket = this.headingBucket(headingSnapshot.heading, headingSnapshot.breakpoint);
      this.mergeRecordIntoMap(headingSnapshot.fontFamilies, bucket.fontFamilies, (value) => {
        const family = sanitizeFontFamily(value);
        return family || null;
      });
      this.mergeRecordIntoMap(headingSnapshot.fontSizes, bucket.fontSizes, (value) =>
        normalizeLengthToken(value),
      );
      this.mergeRecordIntoMap(headingSnapshot.fontWeights, bucket.fontWeights, (value) =>
        normalizeFontWeightToken(value),
      );
      this.mergeRecordIntoMap(headingSnapshot.lineHeights, bucket.lineHeights, (value) =>
        normalizeLengthToken(value),
      );
    }
  }

  buildReport(sourceUrl: string): MiniCdReport {
    const allFonts = sortCountItems(
      Array.from(this.fontFamilies.values()).map((entry) => ({
        value: entry.label,
        count: entry.count,
      })),
    );
    const brandFonts = allFonts.filter(
      (entry) => !GENERIC_FONT_FAMILIES.has(entry.value.toLowerCase()),
    );
    const genericFonts = allFonts.filter((entry) =>
      GENERIC_FONT_FAMILIES.has(entry.value.toLowerCase()),
    );

    return {
      sourceUrl,
      generatedAt: new Date().toISOString(),
      stats: {
        html: { ...this.htmlStats },
        selectors: { ...this.selectorStats },
      },
      colors: {
        all: this.toCountItems(this.colorAll),
        text: this.toCountItems(this.colorText),
        background: this.toCountItems(this.colorBackground),
        border: this.toCountItems(this.colorBorder),
        fill: this.toCountItems(this.colorFill),
        other: this.toCountItems(this.colorOther),
      },
      fonts: {
        all: allFonts,
        brand: brandFonts,
        generic: genericFonts,
      },
      typography: {
        fontSizes: this.toCountItems(this.fontSizes),
        fontWeights: this.toCountItems(this.fontWeights),
        lineHeights: this.toCountItems(this.lineHeights),
      },
      layout: {
        spacing: this.toCountItems(this.spacing),
        borderRadius: this.toCountItems(this.borderRadius),
      },
      media: {
        queries: this.toCountItems(this.mediaQueries),
        breakpoints: this.toCountItems(this.breakpoints),
      },
      headings: this.buildHeadingReport(),
      totals: {
        uniqueColors: this.colorAll.size,
        uniqueFonts: this.fontFamilies.size,
        uniqueFontSizes: this.fontSizes.size,
        uniqueFontWeights: this.fontWeights.size,
        uniqueLineHeights: this.lineHeights.size,
        uniqueSpacingValues: this.spacing.size,
        uniqueBorderRadiusValues: this.borderRadius.size,
        mediaQueries: this.mediaQueries.size,
        breakpoints: this.breakpoints.size,
      },
    };
  }

  private addInlineStyle(style: string): void {
    let root;
    try {
      root = postcss.parse(`x{${style}}`);
    } catch {
      return;
    }

    root.walkDecls((decl) => {
      this.consumeDeclaration(decl.prop, decl.value);
    });
  }

  private consumeRule(rule: Rule, collectDeclarations: boolean): void {
    const selectors = splitSelectors(rule.selector || '');
    const mediaContext = this.getMediaContext(rule);

    for (const selector of selectors) {
      this.selectorStats.selectors += 1;
      this.selectorStats.typeSelectors += countMatches(
        selector,
        /(^|[\s>+~,(])([a-z][a-z0-9-]*)/gi,
      );
      this.selectorStats.idSelectors += countMatches(selector, /#[_a-zA-Z-][\w-]*/g);
      this.selectorStats.classSelectors += countMatches(
        selector,
        /\.[_a-zA-Z-][\w-]*/g,
      );
      this.selectorStats.attributeSelectors += countMatches(selector, /\[[^\]]+\]/g);
      this.selectorStats.pseudoSelectors += countMatches(selector, /:{1,2}[a-zA-Z-]+/g);
    }

    const headings = new Set<string>();
    for (const selector of selectors) {
      for (const heading of extractHeadingsFromSelector(selector)) {
        headings.add(heading);
      }
    }

    if (collectDeclarations) {
      rule.walkDecls((decl) => {
        this.consumeDeclaration(decl.prop, decl.value);
        if (headings.size > 0) {
          for (const heading of headings) {
            this.consumeHeadingDeclaration(heading, mediaContext, decl);
          }
        }
      });
    }
  }

  private consumeDeclaration(propRaw: string, valueRaw: string): void {
    const prop = propRaw.trim().toLowerCase();
    const value = valueRaw.trim();
    if (!value) return;

    this.collectColors(prop, value);

    if (prop === 'font-family') {
      this.collectFontFamilies(value);
    }

    if (prop === 'font-size') {
      const token = this.firstLengthToken(value);
      if (token) this.bump(this.fontSizes, token);
    }

    if (prop === 'font-weight') {
      this.bump(this.fontWeights, normalizeFontWeightToken(value));
    }

    if (prop === 'line-height') {
      this.bump(this.lineHeights, normalizeLengthToken(value));
    }

    if (prop === 'font') {
      this.consumeFontShorthand(value, {
        fontSizes: this.fontSizes,
        lineHeights: this.lineHeights,
        fontWeights: this.fontWeights,
        fontFamilyHandler: (families) => this.collectFontFamilies(families),
      });
    }

    if (SPACING_PROPS.has(prop)) {
      for (const token of this.extractLengthTokens(value)) {
        this.bump(this.spacing, token);
      }
    }

    if (RADIUS_PROPS.has(prop)) {
      for (const token of this.extractLengthTokens(value)) {
        this.bump(this.borderRadius, token);
      }
    }
  }

  private consumeHeadingDeclaration(
    heading: string,
    breakpoint: string,
    decl: Declaration,
  ): void {
    const prop = decl.prop.trim().toLowerCase();
    const value = decl.value.trim();
    if (!value) return;

    const bucket = this.headingBucket(heading, breakpoint);

    if (prop === 'font-family') {
      for (const family of this.collectFamilyList(value)) {
        this.bump(bucket.fontFamilies, family);
      }
    }

    if (prop === 'font-size') {
      const token = this.firstLengthToken(value);
      if (token) this.bump(bucket.fontSizes, token);
    }

    if (prop === 'font-weight') {
      this.bump(bucket.fontWeights, normalizeFontWeightToken(value));
    }

    if (prop === 'line-height') {
      this.bump(bucket.lineHeights, normalizeLengthToken(value));
    }

    if (prop === 'font') {
      this.consumeFontShorthand(value, {
        fontSizes: bucket.fontSizes,
        lineHeights: bucket.lineHeights,
        fontWeights: bucket.fontWeights,
        fontFamilyHandler: (families) => {
          for (const family of this.collectFamilyList(families)) {
            this.bump(bucket.fontFamilies, family);
          }
        },
      });
    }
  }

  private consumeFontShorthand(
    value: string,
    target: {
      fontSizes: Map<string, number>;
      lineHeights: Map<string, number>;
      fontWeights: Map<string, number>;
      fontFamilyHandler: (value: string) => void;
    },
  ): void {
    const match = value.match(FONT_SHORTHAND_REGEX);
    if (!match) return;

    this.bump(target.fontSizes, normalizeLengthToken(match[1]));
    if (match[2]) {
      this.bump(target.lineHeights, normalizeLengthToken(match[2]));
    }

    target.fontFamilyHandler(match[3]);

    const weightTokens = value.match(FONT_WEIGHT_REGEX);
    if (weightTokens && weightTokens.length > 0) {
      this.bump(
        target.fontWeights,
        normalizeFontWeightToken(weightTokens[weightTokens.length - 1]),
      );
    }
  }

  private collectColors(prop: string, value: string): void {
    const withoutUrls = value.replace(URL_REGEX, '');
    const matches = withoutUrls.match(COLOR_TOKEN_REGEX);
    if (!matches) return;

    const target = this.colorTarget(prop);
    for (const match of matches) {
      const normalized = normalizeColorToken(match);
      if (!normalized) continue;
      this.bump(this.colorAll, normalized);
      this.bump(target, normalized);
    }
  }

  private colorTarget(prop: string): Map<string, number> {
    if (prop === 'color' || prop === 'caret-color' || prop === 'text-decoration-color') {
      return this.colorText;
    }
    if (prop === 'background' || prop.startsWith('background-')) {
      return this.colorBackground;
    }
    if (prop.startsWith('border') || prop.startsWith('outline')) {
      return this.colorBorder;
    }
    if (prop === 'fill' || prop === 'stroke') {
      return this.colorFill;
    }
    return this.colorOther;
  }

  private collectFamilyList(value: string): string[] {
    return value
      .split(',')
      .map((chunk) => sanitizeFontFamily(chunk))
      .filter((entry): entry is string => Boolean(entry));
  }

  private collectFontFamilies(value: string): void {
    const families = this.collectFamilyList(value);
    for (const family of families) {
      this.addFontFamilyWithCount(family, 1);
    }
  }

  private firstLengthToken(value: string): string | null {
    const match = value.match(LENGTH_TOKEN_REGEX);
    if (!match || match.length === 0) return null;
    return normalizeLengthToken(match[0]);
  }

  private extractLengthTokens(value: string): string[] {
    const matches = value.match(LENGTH_TOKEN_REGEX);
    if (!matches) return [];
    return matches.map((token) => normalizeLengthToken(token));
  }

  private extractBreakpoints(query: string): void {
    const lower = query.toLowerCase();
    for (const match of lower.matchAll(
      /(min|max)-width\s*:\s*([0-9]*\.?[0-9]+(?:px|em|rem))/g,
    )) {
      this.bump(this.breakpoints, `${match[1]}-width ${match[2]}`);
    }
  }

  private getMediaContext(node: Node): string {
    const parts: string[] = [];
    let current: Node | undefined = node.parent ?? undefined;

    while (current) {
      if (current.type === 'atrule') {
        const atRule = current as AtRule;
        if (atRule.name.toLowerCase() === 'media') {
          const query = atRule.params.trim() || 'unknown';
          parts.unshift(`@media ${query}`);
        }
      }
      current = current.parent ?? undefined;
    }

    return parts.length > 0 ? parts.join(' && ') : 'base';
  }

  private headingBucket(heading: string, breakpoint: string): HeadingTokenMaps {
    let headingMap = this.headings.get(heading);
    if (!headingMap) {
      headingMap = new Map();
      this.headings.set(heading, headingMap);
    }

    let bucket = headingMap.get(breakpoint);
    if (!bucket) {
      bucket = {
        fontFamilies: new Map(),
        fontSizes: new Map(),
        fontWeights: new Map(),
        lineHeights: new Map(),
      };
      headingMap.set(breakpoint, bucket);
    }

    return bucket;
  }

  private buildHeadingReport(): HeadingTokenReport[] {
    const reports: HeadingTokenReport[] = [];

    for (const [heading, breakpointMap] of this.headings.entries()) {
      for (const [breakpoint, tokens] of breakpointMap.entries()) {
        reports.push({
          heading,
          breakpoint,
          fontFamilies: this.toCountItems(tokens.fontFamilies),
          fontSizes: this.toCountItems(tokens.fontSizes),
          fontWeights: this.toCountItems(tokens.fontWeights),
          lineHeights: this.toCountItems(tokens.lineHeights),
        });
      }
    }

    return reports.sort((a, b) => {
      const aBp = breakpointNumericValue(a.breakpoint);
      const bBp = breakpointNumericValue(b.breakpoint);
      if (aBp !== bBp) return aBp - bBp;

      const aHeading = headingSortIndex(a.heading);
      const bHeading = headingSortIndex(b.heading);
      if (aHeading !== bHeading) return aHeading - bHeading;

      if (a.breakpoint !== b.breakpoint) {
        return a.breakpoint.localeCompare(b.breakpoint);
      }

      return a.heading.localeCompare(b.heading);
    });
  }

  private bump(target: Map<string, number>, key: string): void {
    const current = target.get(key) ?? 0;
    target.set(key, current + 1);
  }

  private bumpByCount(target: Map<string, number>, key: string, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    const current = target.get(key) ?? 0;
    target.set(key, current + count);
  }

  private mergeColorRecord(
    input: Record<string, number>,
    target: Map<string, number>,
  ): void {
    for (const [rawValue, count] of Object.entries(input || {})) {
      const color = normalizeColorToken(rawValue);
      if (!color) continue;
      this.bumpByCount(this.colorAll, color, count);
      this.bumpByCount(target, color, count);
    }
  }

  private mergeRecordIntoMap(
    input: Record<string, number>,
    target: Map<string, number>,
    normalize: (value: string) => string | null,
  ): void {
    for (const [rawValue, count] of Object.entries(input || {})) {
      const normalized = normalize(rawValue);
      if (!normalized) continue;
      this.bumpByCount(target, normalized, count);
    }
  }

  private addFontFamilyWithCount(rawFamily: string, count: number): void {
    const family = sanitizeFontFamily(rawFamily);
    if (!family) return;
    const key = family.toLowerCase();
    const existing = this.fontFamilies.get(key);
    if (existing) {
      existing.count += count;
      return;
    }
    this.fontFamilies.set(key, {
      label: family,
      count,
    });
  }

  private toCountItems(target: Map<string, number>): CountItem[] {
    return sortCountItems(
      Array.from(target.entries()).map(([value, count]) => ({
        value,
        count,
      })),
    );
  }
}

export const renderList = (items: CountItem[], emptyText = '- none found'): string => {
  if (items.length === 0) return emptyText;
  return items.map((item) => `- ${item.value} (${item.count})`).join('\n');
};

export const renderInlineList = (items: CountItem[]): string => {
  if (items.length === 0) return 'none';
  return items.map((item) => `${item.value} (${item.count})`).join(', ');
};

export const selectItems = (
  items: CountItem[],
  options: { max: number; minCount: number; fallback: number },
): CountItem[] => {
  const filtered = items.filter((item) => item.count >= options.minCount);
  if (filtered.length > 0) return filtered.slice(0, options.max);
  return items.slice(0, options.fallback);
};

export const renderCdMarkdown = (report: MiniCdReport): string => {
  const selectedAllColors = selectItems(report.colors.all, {
    max: 28,
    minCount: 8,
    fallback: 20,
  });
  const selectedTextColors = selectItems(report.colors.text, {
    max: 16,
    minCount: 4,
    fallback: 12,
  });
  const selectedBackgroundColors = selectItems(report.colors.background, {
    max: 18,
    minCount: 4,
    fallback: 12,
  });
  const selectedBorderColors = selectItems(report.colors.border, {
    max: 14,
    minCount: 3,
    fallback: 10,
  });
  const selectedBrandFonts = selectItems(report.fonts.brand, {
    max: 12,
    minCount: 3,
    fallback: 8,
  });
  const selectedFontSizes = selectItems(report.typography.fontSizes, {
    max: 14,
    minCount: 3,
    fallback: 10,
  });
  const selectedFontWeights = selectItems(report.typography.fontWeights, {
    max: 8,
    minCount: 2,
    fallback: 6,
  });
  const selectedLineHeights = selectItems(report.typography.lineHeights, {
    max: 14,
    minCount: 3,
    fallback: 10,
  });
  const selectedBreakpoints = selectItems(report.media.breakpoints, {
    max: 16,
    minCount: 2,
    fallback: 10,
  });
  const selectedDisplayFonts =
    selectedBrandFonts.length > 0
      ? selectedBrandFonts
      : selectItems(report.fonts.all, {
          max: 14,
          minCount: 3,
          fallback: 10,
        });
  const selectedFallbackFonts = selectItems(report.fonts.generic, {
    max: 6,
    minCount: 2,
    fallback: 4,
  });

  return [
    '# CD',
    '',
    `- Source: ${report.sourceUrl}`,
    `- Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Pages analyzed: ${report.stats.html.pages}`,
    `- Elements: ${report.stats.html.elements}`,
    `- External stylesheets: ${report.stats.html.externalStylesheets}`,
    `- Inline style elements: ${report.stats.html.inlineStyleElements}`,
    `- Inline style attributes: ${report.stats.html.inlineStyleAttributes}`,
    `- Style rules: ${report.stats.selectors.styleRules}`,
    `- Selectors: ${report.stats.selectors.selectors}`,
    `- Media queries: ${report.totals.mediaQueries}`,
    `- Breakpoints: ${report.totals.breakpoints}`,
    '',
    '## Colors',
    '',
    '### Selected colors (used most often)',
    renderList(selectedAllColors),
    '',
    '### Selected text colors',
    renderList(selectedTextColors),
    '',
    '### Selected background colors',
    renderList(selectedBackgroundColors),
    '',
    '### Selected border colors',
    renderList(selectedBorderColors),
    '',
    '## Fonts',
    '',
    '### Selected brand font families',
    renderList(selectedDisplayFonts),
    '',
    `- Generic fallback fonts hidden in strict brand mode (${selectedFallbackFonts.length} selected).`,
    '',
    '## Typography',
    '',
    '### Font sizes',
    renderList(selectedFontSizes),
    '',
    '### Font weights',
    renderList(selectedFontWeights),
    '',
    '### Line heights',
    renderList(selectedLineHeights),
    '',
    '## Breakpoints',
    '',
    renderList(selectedBreakpoints),
    '',
    '## Headings by Breakpoint',
    '',
    ...(report.headings.length === 0
      ? ['- none found']
      : report.headings.flatMap((entry) => [
          `### ${entry.heading} / ${entry.breakpoint}`,
          `- font-family: ${renderInlineList(selectItems(entry.fontFamilies, { max: 4, minCount: 1, fallback: 2 }))}`,
          `- font-size: ${renderInlineList(selectItems(entry.fontSizes, { max: 4, minCount: 1, fallback: 2 }))}`,
          `- font-weight: ${renderInlineList(selectItems(entry.fontWeights, { max: 4, minCount: 1, fallback: 2 }))}`,
          `- line-height: ${renderInlineList(selectItems(entry.lineHeights, { max: 4, minCount: 1, fallback: 2 }))}`,
          '',
        ])),
    '## Raw Extracted Data',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
  ].join('\n');
};

const renderColorGroup = (title: string, items: CountItem[]): string => {
  const cards =
    items.length === 0
      ? `<p class="muted">No colors detected.</p>`
      : items
          .map((item) => {
            const fg = textColorForBackground(item.value);
            return `<div class="swatch-card"><div class="swatch" style="background:${escapeHtml(item.value)};color:${fg}">${escapeHtml(item.value)}</div><div class="swatch-meta">${escapeHtml(item.value)} <span>${item.count}</span></div></div>`;
          })
          .join('');

  return `<section class="panel"><h3>${escapeHtml(title)}</h3><div class="swatch-grid">${cards}</div></section>`;
};

const renderCountTable = (items: CountItem[], emptyText = 'No entries found.'): string => {
  if (items.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;

  const rows = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.value)}</td><td class="num">${item.count}</td></tr>`,
    )
    .join('');

  return `<table><thead><tr><th>Value</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const renderHeadingSection = (items: HeadingTokenReport[]): string => {
  if (items.length === 0) return '<p class="muted">No headline selectors detected.</p>';

  const blocks = items
    .map((entry) => {
      const fontFamilies = selectItems(entry.fontFamilies, {
        max: 4,
        minCount: 1,
        fallback: 2,
      });
      const fontSizes = selectItems(entry.fontSizes, {
        max: 4,
        minCount: 1,
        fallback: 2,
      });
      const fontWeights = selectItems(entry.fontWeights, {
        max: 4,
        minCount: 1,
        fallback: 2,
      });
      const lineHeights = selectItems(entry.lineHeights, {
        max: 4,
        minCount: 1,
        fallback: 2,
      });
      return `<article class="heading-card"><h4>${escapeHtml(entry.heading)} <span>${escapeHtml(entry.breakpoint)}</span></h4><ul><li><strong>Font family:</strong> ${escapeHtml(renderInlineList(fontFamilies))}</li><li><strong>Font size:</strong> ${escapeHtml(renderInlineList(fontSizes))}</li><li><strong>Font weight:</strong> ${escapeHtml(renderInlineList(fontWeights))}</li><li><strong>Line height:</strong> ${escapeHtml(renderInlineList(lineHeights))}</li></ul></article>`;
    })
    .join('');

  return `<div class="heading-grid">${blocks}</div>`;
};

export const renderCdHtml = (
  report: MiniCdReport,
  branding: CdBrandingAssets = {},
): string => {
  const selectedAllColors = selectItems(report.colors.all, {
    max: 40,
    minCount: 8,
    fallback: 24,
  });
  const selectedTextColors = selectItems(report.colors.text, {
    max: 24,
    minCount: 4,
    fallback: 16,
  });
  const selectedBackgroundColors = selectItems(report.colors.background, {
    max: 24,
    minCount: 4,
    fallback: 16,
  });
  const selectedBorderColors = selectItems(report.colors.border, {
    max: 20,
    minCount: 3,
    fallback: 14,
  });
  const selectedFillColors = selectItems(report.colors.fill, {
    max: 20,
    minCount: 3,
    fallback: 14,
  });
  const selectedBrandFonts = selectItems(report.fonts.brand, {
    max: 16,
    minCount: 3,
    fallback: 10,
  });
  const selectedGenericFonts = selectItems(report.fonts.generic, {
    max: 10,
    minCount: 2,
    fallback: 6,
  });
  const selectedDisplayFonts =
    selectedBrandFonts.length > 0
      ? selectedBrandFonts
      : selectItems(report.fonts.all, {
          max: 18,
          minCount: 3,
          fallback: 12,
        });
  const selectedFontSizes = selectItems(report.typography.fontSizes, {
    max: 18,
    minCount: 3,
    fallback: 12,
  });
  const selectedFontWeights = selectItems(report.typography.fontWeights, {
    max: 10,
    minCount: 2,
    fallback: 6,
  });
  const selectedLineHeights = selectItems(report.typography.lineHeights, {
    max: 18,
    minCount: 3,
    fallback: 12,
  });
  const selectedMediaQueries = selectItems(report.media.queries, {
    max: 20,
    minCount: 2,
    fallback: 12,
  });
  const selectedBreakpoints = selectItems(report.media.breakpoints, {
    max: 20,
    minCount: 2,
    fallback: 12,
  });
  const faviconTag = branding.faviconHref
    ? `  <link rel="icon" href="${escapeHtml(String(branding.faviconHref))}" />`
    : '';
  const topLogo = branding.logoHref
    ? `<div class="top-logo-wrap"><img class="top-logo" src="${escapeHtml(String(branding.logoHref))}" alt="Brand logo" /></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CD Report</title>
${faviconTag}
  <style>
    :root {
      --bg: #f5f2e8;
      --panel: #fffdf8;
      --ink: #1f2328;
      --muted: #5a646d;
      --line: #d8caa1;
      --accent: #a57c00;
      --accent-soft: #f0dd98;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      color: var(--ink);
      background: linear-gradient(140deg, #f5f2e8 0%, #ece7d9 50%, #efe7d0 100%);
      min-height: 100vh;
    }
    .layout {
      display: grid;
      grid-template-columns: 260px 1fr;
      min-height: 100vh;
    }
    nav {
      border-right: 1px solid var(--line);
      background: #efe6cd;
      padding: 24px 16px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow: auto;
    }
    nav h1 {
      margin: 0 0 12px;
      font-size: 16px;
      line-height: 1.2;
    }
    nav p {
      margin: 0 0 18px;
      color: var(--muted);
      font-size: 12px;
    }
    nav a {
      display: block;
      text-decoration: none;
      color: var(--ink);
      padding: 9px 10px;
      border-radius: 8px;
      margin-bottom: 6px;
      border: 1px solid transparent;
      font-size: 13px;
    }
    nav a:hover {
      background: var(--accent-soft);
      border-color: var(--line);
    }
    main {
      padding: 26px;
      display: grid;
      gap: 20px;
    }
    section {
      scroll-margin-top: 24px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 18px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
    }
    h2 {
      margin: 0 0 14px;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }
    h3 {
      margin: 0 0 12px;
      font-size: 15px;
      line-height: 1.25;
    }
    .top-logo-wrap {
      margin: 0 0 14px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      width: fit-content;
      max-width: 100%;
    }
    .top-logo {
      display: block;
      max-height: 46px;
      max-width: 280px;
      width: auto;
      object-fit: contain;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
    .metric {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
    }
    .metric .label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .metric .value {
      margin-top: 3px;
      font-size: 17px;
      font-weight: 700;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .swatch-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 10px;
    }
    .swatch-card {
      border: 1px solid #d9d9d9;
      border-radius: 10px;
      overflow: hidden;
      background: #fff;
    }
    .swatch {
      height: 48px;
      padding: 8px;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
    }
    .swatch-meta {
      padding: 8px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      line-height: 1.25;
      word-break: break-word;
    }
    .swatch-meta span {
      color: var(--muted);
      font-weight: 700;
      white-space: nowrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    th, td {
      border-bottom: 1px solid #eadfbe;
      padding: 9px 10px;
      text-align: left;
      font-size: 14px;
      vertical-align: top;
    }
    th {
      background: #f7efd8;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #63552c;
    }
    td.num {
      width: 110px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 700;
    }
    .heading-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }
    .heading-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: #fff;
    }
    .heading-card h4 {
      margin: 0 0 8px;
      font-size: 18px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .heading-card h4 span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .heading-card ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: #2c3237;
    }
    .muted {
      color: var(--muted);
      margin: 0;
      font-size: 12px;
    }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 8px;
      background: #f7f7f7;
      border: 1px solid #e2e2e2;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      main { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <h1>CD Report</h1>
      <p>${escapeHtml(report.sourceUrl)}</p>
      <a href="#overview">Overview</a>
      <a href="#colors">Colors</a>
      <a href="#fonts">Font info</a>
      <a href="#typography">Typography</a>
      <a href="#media">Media queries</a>
      <a href="#headings">Headlines / Breakpoints</a>
      <a href="#raw">Raw JSON</a>
    </nav>
    <main>
      <section id="overview" class="panel">
        <h2>Overview summary</h2>
        <div class="summary-grid">
          <div class="metric"><div class="label">Generated</div><div class="value">${escapeHtml(
            report.generatedAt,
          )}</div></div>
          <div class="metric"><div class="label">Pages</div><div class="value">${report.stats.html.pages}</div></div>
          <div class="metric"><div class="label">Elements</div><div class="value">${report.stats.html.elements}</div></div>
          <div class="metric"><div class="label">External stylesheets</div><div class="value">${report.stats.html.externalStylesheets}</div></div>
          <div class="metric"><div class="label">Inline style elements</div><div class="value">${report.stats.html.inlineStyleElements}</div></div>
          <div class="metric"><div class="label">Inline style attrs</div><div class="value">${report.stats.html.inlineStyleAttributes}</div></div>
          <div class="metric"><div class="label">Style rules</div><div class="value">${report.stats.selectors.styleRules}</div></div>
          <div class="metric"><div class="label">Selectors</div><div class="value">${report.stats.selectors.selectors}</div></div>
          <div class="metric"><div class="label">Type selectors</div><div class="value">${report.stats.selectors.typeSelectors}</div></div>
          <div class="metric"><div class="label">ID selectors</div><div class="value">${report.stats.selectors.idSelectors}</div></div>
          <div class="metric"><div class="label">Class selectors</div><div class="value">${report.stats.selectors.classSelectors}</div></div>
          <div class="metric"><div class="label">Attribute selectors</div><div class="value">${report.stats.selectors.attributeSelectors}</div></div>
          <div class="metric"><div class="label">Pseudo selectors</div><div class="value">${report.stats.selectors.pseudoSelectors}</div></div>
          <div class="metric"><div class="label">Media queries</div><div class="value">${report.totals.mediaQueries}</div></div>
          <div class="metric"><div class="label">Breakpoints</div><div class="value">${report.totals.breakpoints}</div></div>
        </div>
      </section>

      <section id="colors" class="panel">
        ${topLogo}
        <h2>Colors</h2>
        ${renderColorGroup('Selected colors (used most often)', selectedAllColors)}
        ${renderColorGroup('Selected text colors', selectedTextColors)}
        ${renderColorGroup('Selected background colors', selectedBackgroundColors)}
        ${renderColorGroup('Selected border colors', selectedBorderColors)}
        ${renderColorGroup('Selected fill/stroke colors', selectedFillColors)}
      </section>

      <section id="fonts" class="panel">
        <h2>Font info</h2>
        <h3>Selected brand font families</h3>
        ${renderCountTable(selectedDisplayFonts, 'No brand fonts found.')}
        <p class="muted">Generic fallback fonts are hidden in strict brand mode (${selectedGenericFonts.length} selected).</p>
      </section>

      <section id="typography" class="panel">
        <h2>Typography</h2>
        <h3>Font sizes</h3>
        ${renderCountTable(selectedFontSizes)}
        <h3>Font weights</h3>
        ${renderCountTable(selectedFontWeights)}
        <h3>Line heights</h3>
        ${renderCountTable(selectedLineHeights)}
      </section>

      <section id="media" class="panel">
        <h2>Media queries</h2>
        <h3>Queries</h3>
        ${renderCountTable(selectedMediaQueries, 'No media queries found.')}
        <h3>Breakpoints</h3>
        ${renderCountTable(selectedBreakpoints, 'No breakpoints found.')}
      </section>

      <section id="headings" class="panel">
        <h2>Headlines by Breakpoint</h2>
        ${renderHeadingSection(report.headings)}
      </section>

      <section id="raw" class="panel">
        <h2>Raw extracted data</h2>
        <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
      </section>
    </main>
  </div>
</body>
</html>`;
};
