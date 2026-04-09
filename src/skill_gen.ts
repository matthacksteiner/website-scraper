import { promises as fs } from 'fs';
import path from 'path';
import {
	HeadingTokenReport,
	MiniCdReport,
	renderInlineList,
	renderList,
	selectItems,
} from './mini_cd';

export const buildSkillMd = (
	domain: string,
	sourceUrl: string,
	report: MiniCdReport,
): string => {
	const brandFonts = selectItems(report.fonts.brand, {
		max: 6,
		minCount: 2,
		fallback: 4,
	});
	const displayFonts =
		brandFonts.length > 0
			? brandFonts
			: selectItems(report.fonts.all, { max: 6, minCount: 2, fallback: 4 });
	const textColors = selectItems(report.colors.text, {
		max: 8,
		minCount: 3,
		fallback: 6,
	});
	const bgColors = selectItems(report.colors.background, {
		max: 8,
		minCount: 3,
		fallback: 6,
	});
	const borderColors = selectItems(report.colors.border, {
		max: 6,
		minCount: 3,
		fallback: 4,
	});
	const fontSizes = selectItems(report.typography.fontSizes, {
		max: 10,
		minCount: 2,
		fallback: 8,
	});
	const fontWeights = selectItems(report.typography.fontWeights, {
		max: 6,
		minCount: 2,
		fallback: 4,
	});
	const breakpoints = selectItems(report.media.breakpoints, {
		max: 8,
		minCount: 2,
		fallback: 6,
	});

	return [
		'---',
		`name: design-${domain}`,
		`description: "Design system extracted from ${domain} — colors, typography, spacing, breakpoints. Use when building or matching this website's visual design."`,
		'---',
		'',
		`# Design System: ${domain}`,
		'',
		`- Source: ${sourceUrl}`,
		`- Pages analyzed: ${report.stats.html.pages}`,
		`- Generated: ${report.generatedAt}`,
		'',
		'## Colors',
		'',
		'### Text',
		renderList(textColors),
		'',
		'### Background',
		renderList(bgColors),
		'',
		'### Border',
		renderList(borderColors),
		'',
		'## Typography',
		'',
		'### Brand Fonts',
		renderList(displayFonts),
		'',
		'### Type Scale',
		renderList(fontSizes),
		'',
		'### Font Weights',
		renderList(fontWeights),
		'',
		'## Breakpoints',
		'',
		renderList(breakpoints),
		'',
		'## References',
		'',
		'See `references/` for complete data:',
		'- `colors.md` — Full color palette by context',
		'- `typography.md` — All font families, sizes, weights, line heights',
		'- `layout.md` — Spacing values, border radius',
		'- `responsive.md` — All breakpoints, media queries, heading styles per breakpoint',
		'',
	].join('\n');
};

export const buildColorsRef = (report: MiniCdReport): string => {
	const allColors = selectItems(report.colors.all, {
		max: 50,
		minCount: 2,
		fallback: 30,
	});
	const textColors = selectItems(report.colors.text, {
		max: 30,
		minCount: 2,
		fallback: 20,
	});
	const bgColors = selectItems(report.colors.background, {
		max: 30,
		minCount: 2,
		fallback: 20,
	});
	const borderColors = selectItems(report.colors.border, {
		max: 20,
		minCount: 2,
		fallback: 14,
	});
	const fillColors = selectItems(report.colors.fill, {
		max: 20,
		minCount: 2,
		fallback: 10,
	});

	return [
		'# Colors',
		'',
		`Total unique colors: ${report.totals.uniqueColors}`,
		'',
		'## All Colors (by frequency)',
		renderList(allColors),
		'',
		'## Text Colors',
		renderList(textColors),
		'',
		'## Background Colors',
		renderList(bgColors),
		'',
		'## Border Colors',
		renderList(borderColors),
		'',
		'## Fill Colors',
		renderList(fillColors),
		'',
	].join('\n');
};

export const buildTypographyRef = (report: MiniCdReport): string => {
	const brandFonts = selectItems(report.fonts.brand, {
		max: 20,
		minCount: 1,
		fallback: 10,
	});
	const genericFonts = selectItems(report.fonts.generic, {
		max: 10,
		minCount: 1,
		fallback: 6,
	});
	const fontSizes = selectItems(report.typography.fontSizes, {
		max: 30,
		minCount: 1,
		fallback: 20,
	});
	const fontWeights = selectItems(report.typography.fontWeights, {
		max: 12,
		minCount: 1,
		fallback: 8,
	});
	const lineHeights = selectItems(report.typography.lineHeights, {
		max: 20,
		minCount: 1,
		fallback: 14,
	});

	return [
		'# Typography',
		'',
		`Total unique fonts: ${report.totals.uniqueFonts}`,
		`Total unique font sizes: ${report.totals.uniqueFontSizes}`,
		`Total unique font weights: ${report.totals.uniqueFontWeights}`,
		`Total unique line heights: ${report.totals.uniqueLineHeights}`,
		'',
		'## Brand Fonts',
		renderList(brandFonts),
		'',
		'## Generic / Fallback Fonts',
		renderList(genericFonts),
		'',
		'## Font Sizes',
		renderList(fontSizes),
		'',
		'## Font Weights',
		renderList(fontWeights),
		'',
		'## Line Heights',
		renderList(lineHeights),
		'',
	].join('\n');
};

export const buildLayoutRef = (report: MiniCdReport): string => {
	const spacing = selectItems(report.layout.spacing, {
		max: 40,
		minCount: 2,
		fallback: 25,
	});
	const borderRadius = selectItems(report.layout.borderRadius, {
		max: 20,
		minCount: 2,
		fallback: 12,
	});

	return [
		'# Layout',
		'',
		`Total unique spacing values: ${report.totals.uniqueSpacingValues}`,
		`Total unique border radius values: ${report.totals.uniqueBorderRadiusValues}`,
		'',
		'## Spacing (margin, padding, gap)',
		renderList(spacing),
		'',
		'## Border Radius',
		renderList(borderRadius),
		'',
	].join('\n');
};

const renderHeadingEntry = (entry: HeadingTokenReport): string => {
	return [
		`### ${entry.heading} / ${entry.breakpoint}`,
		`- font-family: ${renderInlineList(selectItems(entry.fontFamilies, { max: 4, minCount: 1, fallback: 2 }))}`,
		`- font-size: ${renderInlineList(selectItems(entry.fontSizes, { max: 4, minCount: 1, fallback: 2 }))}`,
		`- font-weight: ${renderInlineList(selectItems(entry.fontWeights, { max: 4, minCount: 1, fallback: 2 }))}`,
		`- line-height: ${renderInlineList(selectItems(entry.lineHeights, { max: 4, minCount: 1, fallback: 2 }))}`,
	].join('\n');
};

export const buildResponsiveRef = (report: MiniCdReport): string => {
	const breakpoints = selectItems(report.media.breakpoints, {
		max: 30,
		minCount: 1,
		fallback: 20,
	});
	const mediaQueries = selectItems(report.media.queries, {
		max: 30,
		minCount: 1,
		fallback: 20,
	});

	return [
		'# Responsive Design',
		'',
		`Total breakpoints: ${report.totals.breakpoints}`,
		`Total media queries: ${report.totals.mediaQueries}`,
		'',
		'## Breakpoints',
		renderList(breakpoints),
		'',
		'## Media Queries',
		renderList(mediaQueries),
		'',
		'## Headings by Breakpoint',
		'',
		...(report.headings.length === 0
			? ['- none found']
			: report.headings.flatMap((entry) => [renderHeadingEntry(entry), ''])),
		'',
	].join('\n');
};

export const writeSkill = async (
	outputDir: string,
	domain: string,
	sourceUrl: string,
	report: MiniCdReport,
): Promise<string> => {
	const refsDir = path.join(outputDir, 'references');

	await fs.mkdir(refsDir, { recursive: true });

	await Promise.all([
		fs.writeFile(
			path.join(outputDir, 'SKILL.md'),
			buildSkillMd(domain, sourceUrl, report),
			'utf8',
		),
		fs.writeFile(
			path.join(refsDir, 'colors.md'),
			buildColorsRef(report),
			'utf8',
		),
		fs.writeFile(
			path.join(refsDir, 'typography.md'),
			buildTypographyRef(report),
			'utf8',
		),
		fs.writeFile(
			path.join(refsDir, 'layout.md'),
			buildLayoutRef(report),
			'utf8',
		),
		fs.writeFile(
			path.join(refsDir, 'responsive.md'),
			buildResponsiveRef(report),
			'utf8',
		),
	]);

	return outputDir;
};
