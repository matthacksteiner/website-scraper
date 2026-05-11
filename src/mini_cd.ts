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
const HEADING_SELECTOR_REGEX = /(?:^|[\s>+~,(])h([1-6])(?=[\s>+~.#:[,(]|$)/gi;

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
    return `#${chars
      .slice(0, 3)
      .map((char) => `${char}${char}`)
      .join('')}`;
  }
  return lower.slice(0, 7);
};

const clampRgbChannel = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(255, Math.round(parsed)));
};

const rgbToHex = (value: string): string | null => {
  const match = value.match(/^rgba?\((.+)\)$/i);
  if (!match) return null;
  const channels = match[1]
    .replace(/\s*\/\s*/g, ',')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (channels.length < 3) return null;
  if (channels[3] !== undefined && Number(channels[3]) === 0) return null;
  const rgb = channels.slice(0, 3).map(clampRgbChannel);
  if (rgb.some((channel) => channel === null)) return null;
  return `#${rgb.map((channel) => channel!.toString(16).padStart(2, '0')).join('')}`;
};

const normalizeColorToken = (value: string): string | null => {
  const compact = value.replace(/\s+/g, '').toLowerCase();
  if (compact.includes('var(')) return null;
  if (compact.startsWith('#')) return normalizeHex(compact);
  if (compact.startsWith('rgb')) return rgbToHex(compact);
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
    this.mergeRecordIntoMap(
      snapshot.used.typography.fontWeights,
      this.fontWeights,
      (value) => normalizeFontWeightToken(value),
    );
    this.mergeRecordIntoMap(
      snapshot.used.typography.lineHeights,
      this.lineHeights,
      (value) => normalizeLengthToken(value),
    );
    this.mergeRecordIntoMap(snapshot.used.layout.spacing, this.spacing, (value) =>
      normalizeLengthToken(value),
    );
    this.mergeRecordIntoMap(
      snapshot.used.layout.borderRadius,
      this.borderRadius,
      (value) => normalizeLengthToken(value),
    );

    for (const [rawFamily, count] of Object.entries(
      snapshot.used.typography.fontFamilies || {},
    )) {
      this.addFontFamilyWithCount(rawFamily, count);
    }

    for (const headingSnapshot of snapshot.headings || []) {
      const bucket = this.headingBucket(
        headingSnapshot.heading,
        headingSnapshot.breakpoint,
      );
      this.mergeRecordIntoMap(
        headingSnapshot.fontFamilies,
        bucket.fontFamilies,
        (value) => {
          const family = sanitizeFontFamily(value);
          return family || null;
        },
      );
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
      this.selectorStats.classSelectors += countMatches(selector, /\.[_a-zA-Z-][\w-]*/g);
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
