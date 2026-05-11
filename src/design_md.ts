import { MiniCdReport } from './mini_cd';

interface CountItem {
  value: string;
  count: number;
}

interface ColorTokens {
  primary?: string;
  secondary?: string;
  background?: string;
  surface?: string;
  text?: string;
  textMuted?: string;
  border?: string;
  accent?: string;
}

interface TypographyToken {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string | number;
}

interface DimensionEntry {
  name: string;
  value: string;
}

const NEUTRAL_HEX = new Set([
  '#000000',
  '#ffffff',
  '#fff',
  '#000',
  '#fefefe',
  '#fcfcfc',
  '#fafafa',
  '#f8f8f8',
  '#111111',
  '#0a0a0a',
]);

const hexToRgb = (hex: string): [number, number, number] | null => {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
};

const saturation = (hex: string): number => {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
};

const luminance = (hex: string): number => {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const isHexColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);
const isUnitlessNumber = (value: string): boolean => /^-?\d*\.?\d+$/.test(value);
const isValidDimension = (value: string): boolean =>
  /^-?(?:\d+|\d*\.\d+)(?:px|rem|em)$/.test(value);

const normalizeDimension = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === '0') return '0px';
  if (isValidDimension(trimmed)) return trimmed;
  if (isUnitlessNumber(trimmed)) return `${trimmed}px`;
  return undefined;
};

const normalizeLineHeight = (value: string | undefined): string | number | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'normal') return undefined;
  if (isUnitlessNumber(trimmed)) return Number(trimmed);
  return normalizeDimension(trimmed);
};

const normalizeFontWeight = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'normal') return '400';
  if (normalized === 'bold') return '700';
  if (/^[1-9]00$/.test(normalized)) return normalized;
  return undefined;
};

const isNearNeutral = (hex: string): boolean => {
  if (NEUTRAL_HEX.has(hex.toLowerCase())) return true;
  return saturation(hex) < 0.1;
};

const pickPrimary = (colors: CountItem[]): string | undefined => {
  const chromatic = colors.filter((c) => isHexColor(c.value) && !isNearNeutral(c.value));
  if (chromatic.length === 0) return colors.find((c) => isHexColor(c.value))?.value;
  return chromatic.sort((a, b) => {
    const score = (item: CountItem) => item.count * (0.5 + saturation(item.value));
    return score(b) - score(a);
  })[0]?.value;
};

const pickBackground = (colors: CountItem[]): string | undefined => {
  const sorted = colors.filter((c) => isHexColor(c.value));
  const light = sorted.find((c) => luminance(c.value) > 0.85);
  return light?.value ?? sorted[0]?.value;
};

const pickText = (colors: CountItem[]): string | undefined => {
  const sorted = colors.filter((c) => isHexColor(c.value));
  const dark = sorted.find((c) => luminance(c.value) < 0.3);
  return dark?.value ?? sorted[0]?.value;
};

const pickColors = (report: MiniCdReport): ColorTokens => {
  const all = report.colors.all;
  const primary = pickPrimary(all);
  const background = pickBackground(report.colors.background);
  const surface = report.colors.background
    .filter((c) => isHexColor(c.value) && c.value !== background)
    .find((c) => luminance(c.value) > 0.8)?.value;
  const text = pickText(report.colors.text);
  const textMuted = report.colors.text
    .filter(
      (c) =>
        isHexColor(c.value) &&
        c.value !== text &&
        luminance(c.value) > 0.25 &&
        luminance(c.value) < 0.65,
    )
    .sort((a, b) => b.count - a.count)[0]?.value;
  const border = report.colors.border.find((c) => isHexColor(c.value))?.value;
  const secondary = all
    .filter((c) => isHexColor(c.value) && !isNearNeutral(c.value) && c.value !== primary)
    .sort((a, b) => b.count - a.count)[0]?.value;
  const accent = all
    .filter(
      (c) =>
        isHexColor(c.value) &&
        !isNearNeutral(c.value) &&
        c.value !== primary &&
        c.value !== secondary,
    )
    .sort(
      (a, b) => saturation(b.value) - saturation(a.value) || b.count - a.count,
    )[0]?.value;

  return { primary, secondary, background, surface, text, textMuted, border, accent };
};

const sortPxValues = (items: CountItem[]): { value: string; px: number }[] => {
  const parsed: { value: string; px: number }[] = [];
  for (const item of items) {
    const match = item.value.match(/^(-?\d*\.?\d+)(px|rem|em)?$/i);
    if (!match) continue;
    const num = parseFloat(match[1]);
    if (!Number.isFinite(num)) continue;
    const unit = (match[2] || '').toLowerCase();
    const px = unit === 'rem' || unit === 'em' ? num * 16 : num;
    const value = normalizeDimension(item.value);
    if (!value) continue;
    parsed.push({ value, px });
  }
  return parsed.sort((a, b) => a.px - b.px);
};

const dedupePx = (items: { value: string; px: number }[]) => {
  const seen = new Set<number>();
  const out: { value: string; px: number }[] = [];
  for (const item of items) {
    const key = Math.round(item.px * 100) / 100;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

const buildSpacingScale = (report: MiniCdReport): DimensionEntry[] => {
  const sorted = dedupePx(sortPxValues(report.layout.spacing)).filter((i) => i.px >= 0);
  const sample = sorted.slice(0, 12);
  return sample.map((entry, index) => ({
    name: String(index),
    value: entry.value,
  }));
};

const ROUNDED_LABELS = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];

const buildRoundedScale = (report: MiniCdReport): DimensionEntry[] => {
  const sorted = dedupePx(sortPxValues(report.layout.borderRadius)).filter(
    (i) => i.px >= 0,
  );
  if (sorted.length === 0) return [];
  const sample = sorted.slice(0, ROUNDED_LABELS.length - 1);
  const entries = sample.map((entry, index) => ({
    name: ROUNDED_LABELS[index] ?? String(index),
    value: entry.value,
  }));
  if (sample.some((s) => s.px >= 9999)) {
    return entries;
  }
  entries.push({ name: 'full', value: '9999px' });
  return entries;
};

const cleanFontFamily = (value: string): string => value.replace(/^['"]+|['"]+$/g, '');

const pickBrandFont = (report: MiniCdReport): string | undefined => {
  const brand = report.fonts.brand[0]?.value ?? report.fonts.all[0]?.value;
  return brand ? cleanFontFamily(brand) : undefined;
};

const pickHeadingTypography = (
  report: MiniCdReport,
  heading: string,
): TypographyToken => {
  const entries = report.headings.filter((h) => h.heading === heading);
  const base = entries.find((e) => e.breakpoint === 'base') ?? entries[0];
  if (!base) return {};
  return {
    fontFamily: base.fontFamilies[0]
      ? cleanFontFamily(base.fontFamilies[0].value)
      : undefined,
    fontSize: normalizeDimension(base.fontSizes[0]?.value),
    fontWeight: normalizeFontWeight(base.fontWeights[0]?.value),
    lineHeight: normalizeLineHeight(base.lineHeights[0]?.value),
  };
};

const buildTypographyTokens = (report: MiniCdReport): Record<string, TypographyToken> => {
  const brandFont = pickBrandFont(report);
  const display = pickHeadingTypography(report, 'h1');
  const heading = pickHeadingTypography(report, 'h2');
  const body: TypographyToken = {
    fontFamily: brandFont,
    fontSize:
      normalizeDimension(
        report.typography.fontSizes.find((s) => /^(14|15|16|17|18)px$/.test(s.value))
          ?.value,
      ) ?? normalizeDimension(report.typography.fontSizes[0]?.value),
    fontWeight:
      normalizeFontWeight(
        report.typography.fontWeights.find((w) => /^(400|normal)$/.test(w.value))?.value,
      ) ?? normalizeFontWeight(report.typography.fontWeights[0]?.value),
    lineHeight: normalizeLineHeight(report.typography.lineHeights[0]?.value),
  };
  const caption: TypographyToken = {
    fontFamily: brandFont,
    fontSize: normalizeDimension(
      report.typography.fontSizes.find((s) => /^(11|12|13)px$/.test(s.value))?.value,
    ),
    fontWeight: body.fontWeight,
    lineHeight: body.lineHeight,
  };

  const out: Record<string, TypographyToken> = {};
  if (Object.values(display).some(Boolean)) {
    out['headline-display'] = withFallbackFont(display, brandFont);
  }
  if (Object.values(heading).some(Boolean)) {
    out['headline-md'] = withFallbackFont(heading, brandFont);
  }
  if (Object.values(body).some(Boolean)) out['body-md'] = body;
  if (Object.values(caption).some(Boolean)) out['body-sm'] = caption;
  return out;
};

const withFallbackFont = (
  token: TypographyToken,
  fallback?: string,
): TypographyToken => ({
  ...token,
  fontFamily: token.fontFamily ?? fallback,
});

const yamlString = (value: string): string => {
  if (/^[A-Za-z0-9._/-]+$/.test(value) && !/^(true|false|null|yes|no)$/i.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const yamlScalar = (value: string | number): string => {
  if (typeof value === 'number') return String(value);
  return yamlString(value);
};

const renderRecord = (
  label: string,
  entries: Array<[string, string | undefined]>,
  indent: string,
): string[] => {
  const lines: string[] = [];
  const populated = entries.filter(([, v]) => v !== undefined && v !== '');
  if (populated.length === 0) return lines;
  lines.push(`${indent}${label}:`);
  for (const [key, value] of populated) {
    lines.push(`${indent}  ${yamlString(key)}: ${yamlString(value as string)}`);
  }
  return lines;
};

const renderTypographyBlock = (
  tokens: Record<string, TypographyToken>,
  indent: string,
): string[] => {
  const lines: string[] = [];
  const keys = Object.keys(tokens);
  if (keys.length === 0) return lines;
  lines.push(`${indent}typography:`);
  for (const key of keys) {
    const token = tokens[key];
    lines.push(`${indent}  ${yamlString(key)}:`);
    if (token.fontFamily) {
      lines.push(`${indent}    fontFamily: ${yamlString(token.fontFamily)}`);
    }
    if (token.fontSize) {
      lines.push(`${indent}    fontSize: ${yamlString(token.fontSize)}`);
    }
    if (token.fontWeight) {
      lines.push(`${indent}    fontWeight: ${yamlString(token.fontWeight)}`);
    }
    if (token.lineHeight !== undefined) {
      lines.push(`${indent}    lineHeight: ${yamlScalar(token.lineHeight)}`);
    }
  }
  return lines;
};

const deriveName = (sourceUrl: string): string => {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return host || sourceUrl;
  } catch {
    return sourceUrl;
  }
};

const renderColorList = (tokens: ColorTokens): string => {
  const entries = Object.entries(tokens).filter(([, v]) => v);
  if (entries.length === 0) return '_No reliable color tokens detected._';
  return entries.map(([key, value]) => `- **${key}** — \`${value}\``).join('\n');
};

const renderTypographyList = (tokens: Record<string, TypographyToken>): string => {
  const keys = Object.keys(tokens);
  if (keys.length === 0) return '_No typography tokens detected._';
  return keys
    .map((key) => {
      const t = tokens[key];
      const parts = [
        t.fontFamily ? `family: \`${t.fontFamily}\`` : null,
        t.fontSize ? `size: \`${t.fontSize}\`` : null,
        t.fontWeight ? `weight: \`${t.fontWeight}\`` : null,
        t.lineHeight !== undefined ? `line-height: \`${t.lineHeight}\`` : null,
      ].filter(Boolean);
      return `- **${key}** — ${parts.join(', ')}`;
    })
    .join('\n');
};

const renderDimensionList = (entries: DimensionEntry[]): string => {
  if (entries.length === 0) return '_No values detected._';
  return entries.map((e) => `- \`${e.name}\` — \`${e.value}\``).join('\n');
};

const renderBreakpoints = (report: MiniCdReport): string => {
  if (report.media.breakpoints.length === 0) return '_No breakpoints detected._';
  return report.media.breakpoints
    .slice(0, 8)
    .map((bp) => `- ${bp.value} (${bp.count})`)
    .join('\n');
};

export const renderDesignMarkdown = (report: MiniCdReport): string => {
  const name = deriveName(report.sourceUrl);
  const colors = pickColors(report);
  const typography = buildTypographyTokens(report);
  const rounded = buildRoundedScale(report);
  const spacing = buildSpacingScale(report);

  const frontMatter: string[] = ['---', 'version: alpha', `name: ${yamlString(name)}`];
  frontMatter.push(
    `description: ${yamlString(`Design tokens auto-extracted from ${report.sourceUrl} on ${report.generatedAt}`)}`,
  );
  frontMatter.push(
    ...renderRecord(
      'colors',
      [
        ['primary', colors.primary],
        ['secondary', colors.secondary],
        ['accent', colors.accent],
        ['background', colors.background],
        ['surface', colors.surface],
        ['text', colors.text],
        ['textMuted', colors.textMuted],
        ['border', colors.border],
      ],
      '',
    ),
  );
  frontMatter.push(...renderTypographyBlock(typography, ''));
  frontMatter.push(
    ...renderRecord(
      'rounded',
      rounded.map((r) => [r.name, r.value] as [string, string]),
      '',
    ),
  );
  frontMatter.push(
    ...renderRecord(
      'spacing',
      spacing.map((s) => [s.name, s.value] as [string, string]),
      '',
    ),
  );
  frontMatter.push('components: {}');
  frontMatter.push('---');

  const brandFont = pickBrandFont(report);
  const body: string[] = [
    '',
    `# ${name}`,
    '',
    '## Overview',
    '',
    `Design tokens were auto-extracted from \`${report.sourceUrl}\` by the website-scraper.`,
    `Detected ${report.totals.uniqueColors} colors, ${report.totals.uniqueFonts} font families, and ${report.totals.uniqueFontSizes} distinct font sizes across ${report.stats.html.pages} page(s).`,
    brandFont ? `The dominant brand font appears to be **${brandFont}**.` : '',
    '',
    '## Colors',
    '',
    renderColorList(colors),
    '',
    '## Typography',
    '',
    renderTypographyList(typography),
    '',
    '## Layout',
    '',
    '### Spacing scale',
    '',
    renderDimensionList(spacing),
    '',
    '### Breakpoints',
    '',
    renderBreakpoints(report),
    '',
    '## Elevation & Depth',
    '',
    '_No shadow tokens were extracted in this pass._',
    '',
    '## Shapes',
    '',
    '### Rounded scale',
    '',
    renderDimensionList(rounded),
    '',
    '## Components',
    '',
    '_Component tokens are not auto-derived. Map these against the colors and typography above as you build._',
    '',
    "## Do's and Don'ts",
    '',
    '- **Do** use `colors.primary` for primary actions and links.',
    '- **Do** pair `typography.headline-display` with hero copy and `typography.body-md` for prose.',
    "- **Don't** introduce colors outside the palette without updating this file.",
    "- **Don't** use raw pixel values for spacing — pick from the `spacing` scale.",
    '',
  ];

  const bodyLines = body.filter((line, index) => {
    if (line !== '') return true;
    return body[index - 1] !== '';
  });
  return [...frontMatter, ...bodyLines].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
};
